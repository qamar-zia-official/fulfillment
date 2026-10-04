import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  FULFILLMENT_EXCEPTION_SEVERITIES,
  FULFILLMENT_EXCEPTION_STATUSES,
  FULFILLMENT_EXCEPTION_TYPES,
  type ExceptionSeverity,
  type ExceptionStatus,
  type FulfillmentExceptionType,
} from "@repo/domain";
import {
  MAX_EXCEPTION_PAGE_SIZE,
  closeException,
  listExceptions,
  type ExceptionCursor,
  type ExceptionOperationsRepository,
  type ExceptionPage,
} from "@repo/application";

/**
 * Who is making the request.
 *
 * Resolved once, by the caller, and passed in rather than looked up inside the routes. That
 * makes the guards and the response mapping testable without a database, a Better Auth
 * instance, or a real session cookie -- none of which are what these handlers are deciding.
 */
export type OperationsActor = {
  readonly email: string;
};

/**
 * Returns the authenticated operator, or null when there is no usable session.
 *
 * A null return covers both "no session" and "not an operator" from the route's point of view;
 * the caller distinguishes them with {@link requireOperator} below, so the policy lives in one
 * place instead of being restated per route.
 */
export type ResolveOperator = (headers: Headers) => Promise<OperationsActor | null>;

export type OperationsDeps = {
  /**
   * Resolved per request rather than passed as a value.
   *
   * The obvious shape is to pass the repository, and that is what breaks: `getDb()` throws
   * without a reachable database, so building it at mount time makes importing this module --
   * from a test, a script, or the health check -- require a live connection. The webhook route
   * in `index.ts` calls `getDb()` inside the handler for the same reason, and `@repo/auth` parses
   * its env lazily for the same reason. `getDb` memoises, so this is a lookup, not a connect.
   */
  readonly resolveRepository: () => ExceptionOperationsRepository;
  readonly resolveOperator: ResolveOperator;
  /** Fails closed when unset: see `isOperator` in `@repo/auth`. */
  readonly isOperator: (email: string | null | undefined) => boolean;
};

/**
 * Narrows a query-string value against a vocabulary.
 *
 * A 400 rather than a silent no-op, and that distinction is the whole point. `?severity=blockng`
 * returning an unfiltered list looks exactly like a queue with nothing blocking in it, and the
 * operator concludes everything is handled. A typo in a filter must not be able to answer a
 * question the operator did not ask.
 */
const narrow = <T extends string>(raw: string, allowed: readonly T[], label: string): T => {
  if (!allowed.includes(raw as T)) {
    throw new HTTPException(400, { message: `Unknown ${label}. Expected one of: ${allowed.join(", ")}.` });
  }
  return raw as T;
};

/**
 * The opaque page cursor, base64-encoded JSON.
 *
 * Opaque so the client treats it as a token rather than constructing one, and validated on the
 * way in because a cursor is attacker-controlled input like any other: a bad timestamp here
 * reaches a keyset comparison, and "unparseable" must not quietly become "the first page
 * again".
 */
export const encodeCursor = (cursor: ExceptionCursor): string => Buffer.from(JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id })).toString("base64url");

export const decodeCursor = (raw: string | null): ExceptionCursor | undefined => {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string") throw new Error("shape");
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) throw new Error("timestamp");
    return { createdAt, id: parsed.i };
  } catch {
    throw new HTTPException(400, { message: "Malformed page cursor." });
  }
};

/**
 * Parses the queue's query string.
 *
 * Exported because the parsing rules -- repeated `status`, a `limit` that is clamped rather
 * than trusted, a `shopDomain` that is mandatory -- are the part most likely to be wrong, and
 * they are worth testing without standing up a request.
 *
 * `shopDomain` is required rather than defaulted. Defaulting it to "the one shop" would be fine
 * until the second merchant connects, at which point the default silently starts returning
 * another merchant's data.
 */
export const parseExceptionQuery = (params: URLSearchParams) => {
  const shopDomain = params.get("shopDomain");
  if (!shopDomain || shopDomain.trim().length === 0) {
    throw new HTTPException(400, { message: "A shopDomain is required to read the exception queue." });
  }

  const statuses = params.getAll("status").map((raw) => narrow<ExceptionStatus>(raw, FULFILLMENT_EXCEPTION_STATUSES, "status"));
  const severities = params.getAll("severity").map((raw) => narrow<ExceptionSeverity>(raw, FULFILLMENT_EXCEPTION_SEVERITIES, "severity"));
  const types = params.getAll("type").map((raw) => narrow<FulfillmentExceptionType>(raw, FULFILLMENT_EXCEPTION_TYPES, "type"));

  const cursor = decodeCursor(params.get("cursor"));

  const rawLimit = params.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    // A non-numeric limit is rejected rather than ignored: `?limit=abc` becoming the default
    // 25 is a page size the caller did not ask for, and the queue is paginated.
    if (!Number.isFinite(parsed)) throw new HTTPException(400, { message: "limit must be a number." });
    if (parsed < 1 || parsed > MAX_EXCEPTION_PAGE_SIZE) {
      throw new HTTPException(400, { message: `limit must be between 1 and ${MAX_EXCEPTION_PAGE_SIZE}.` });
    }
    limit = parsed;
  }

  return {
    shopDomain,
    // Defaulting to open-only is the difference between a queue and an archive. The closed ones
    // are history, and history in the same list is history nobody reads.
    status: statuses.length > 0 ? statuses : (["open"] as const),
    ...(severities.length > 0 ? { severity: severities } : {}),
    ...(types.length > 0 ? { type: types } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor ? { after: cursor } : {}),
  };
};

const serialise = (page: ExceptionPage) => ({
  data: page.exceptions.map((exception) => ({
    id: exception.id,
    orderId: exception.orderId,
    type: exception.type,
    severity: exception.severity,
    status: exception.status,
    reason: exception.reason,
    details: exception.details,
    createdAt: exception.createdAt.toISOString(),
    resolvedAt: exception.resolvedAt?.toISOString() ?? null,
    resolvedBy: exception.resolvedBy,
    resolutionNote: exception.resolutionNote,
  })),
  nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
});

export const createOperationsRoutes = ({ resolveRepository, resolveOperator, isOperator }: OperationsDeps) => {
  // Same Variables as the parent app in `index.ts`: it sets `requestId` in middleware,
  // and a sub-router that does not declare it treats every `c.get` as `never`.
  const routes = new Hono<{ Variables: { requestId: string } }>();

  /**
   * The single gate for every operations route.
   *
   * Two distinct failures, deliberately: 401 says "sign in", 403 says "signed in, not allowed".
   * Collapsing them into one 403 is a small thing that makes the dashboard's error handling
   * guess wrong -- a user who is not an operator should be told to sign in as one, not to keep
   * retrying the same session.
   *
   * The message for the 403 names nothing. It does not say whether the address is on the list,
   * because the caller is already authenticated, so there is nothing to protect -- and a
   * message that varied with the answer would be an account oracle.
   */
  const requireOperator = async (headers: Headers): Promise<OperationsActor> => {
    const actor = await resolveOperator(headers);
    if (!actor) throw new HTTPException(401, { message: "Sign in to use the operations API." });
    if (!isOperator(actor.email)) throw new HTTPException(403, { message: "This account is not permitted to use the operations API." });
    return actor;
  };

  routes.get("/exceptions", async (c) => {
    const actor = await requireOperator(c.req.raw.headers);
    const query = parseExceptionQuery(new URL(c.req.url).searchParams);
    const page = await listExceptions(resolveRepository(), query);

    return c.json({ ...serialise(page), actor: actor.email, requestId: c.get("requestId") });
  });

  /**
   * Closes an exception.
   *
   * `shopDomain`, `status` and `note` come from the body; the actor does not. `resolved_by` is
   * the answer to "who decided to ship this without stock?", and an actor taken from a request
   * body is an answer the caller chose, which makes the column decorative. The session is the
   * only source that can make it mean anything.
   */
  routes.post("/exceptions/:id/close", async (c) => {
    const actor = await requireOperator(c.req.raw.headers);
    const body = (await c.req.json().catch(() => null)) as
      | { shopDomain?: unknown; status?: unknown; note?: unknown }
      | null;

    if (!body || typeof body !== "object") throw new HTTPException(400, { message: "A JSON body is required." });

    const shopDomain = body.shopDomain;
    if (typeof shopDomain !== "string" || shopDomain.trim().length === 0) {
      throw new HTTPException(400, { message: "A shopDomain is required." });
    }
    const status = body.status;
    if (status !== "resolved" && status !== "ignored") {
      throw new HTTPException(400, { message: `status must be one of: resolved, ignored.` });
    }
    const note = body.note;
    if (typeof note !== "string" || note.trim().length === 0) {
      throw new HTTPException(400, { message: "A note is required. Closing an exception must record why." });
    }
    // Bounded so `resolution_note` cannot become a place to paste a payload. The real ceiling is
    // on the operator's patience, not the column.
    if (note.length > 2_000) throw new HTTPException(400, { message: "note must be 2000 characters or fewer." });

    const result = await closeException(resolveRepository(), {
      shopDomain,
      exceptionId: c.req.param("id"),
      status,
      actor: actor.email,
      note,
      at: new Date(),
    });

    if (result.outcome === "not_found") {
      // Also the answer for "exists, but belongs to another shop". Answering differently would
      // turn this endpoint into a probe for which exception ids exist in other tenants.
      throw new HTTPException(404, { message: "No open exception with that id for this shop." });
    }
    if (result.outcome === "already_closed") {
      // 409, not 404 and not 200. The two operators are both looking at the same open entry and
      // the second one needs to know it lost, or the note they typed vanishes with no signal.
      throw new HTTPException(409, { message: "This exception was already closed by someone else." });
    }

    return c.json({ data: serialise({ exceptions: [result.exception], nextCursor: null }).data[0], requestId: c.get("requestId") });
  });

  return routes;
};
