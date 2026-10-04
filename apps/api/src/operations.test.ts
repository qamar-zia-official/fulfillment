import { describe, expect, test } from "bun:test";
import { toExceptionId, toOrderId, type FulfillmentException } from "@repo/domain";
import type { ExceptionOperationsRepository } from "@repo/application";
import { Hono } from "hono";
import { onApiError } from "./error-handler";
import { createOperationsRoutes, decodeCursor, encodeCursor, parseExceptionQuery } from "./operations";

const SHOP = "kinetous.myshopify.com";

const anException = (overrides: Partial<FulfillmentException> = {}): FulfillmentException => ({
  id: toExceptionId("exc-1"),
  orderId: toOrderId("ord-1"),
  type: "unroutable_insufficient_stock",
  severity: "blocking",
  status: "open",
  reason: "No single location can cover: KNT-TEE short by 2.",
  details: { shortfall: { "KNT-TEE": 2 } },
  createdAt: new Date("2026-09-28T12:00:00Z"),
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  ...overrides,
});

type TestApp = Hono<{ Variables: { requestId: string } }>;

type Harness = {
  app: TestApp;
  calls: { list: number; close: unknown[] };
  closeResult?: Awaited<ReturnType<ExceptionOperationsRepository["closeException"]>>;
};

const harness = (options: { signedInAs?: string | null; operator?: boolean; closeResult?: Harness["closeResult"] } = {}): Harness => {
  const calls = { list: 0, close: [] as unknown[] };
  const signedInAs = options.signedInAs === undefined ? "ops@example.com" : options.signedInAs;
  const operator = options.operator ?? true;

  const repository: ExceptionOperationsRepository = {
    async listExceptions() {
      calls.list += 1;
      return { exceptions: [anException()], nextCursor: null };
    },
    async closeException(input) {
      calls.close.push(input);
      return (
        options.closeResult ?? {
          outcome: "closed",
          exception: anException({ status: "resolved", resolvedBy: "ops@example.com", resolutionNote: "Restocked." }),
        }
      );
    },
  };

  const routes = createOperationsRoutes({
    resolveRepository: () => repository,
    resolveOperator: async () => (signedInAs ? { email: signedInAs } : null),
    isOperator: () => operator,
  });

  // The real middleware and the real error handler, so the assertions below are about the
  // response contract production actually sends. A harness without `onApiError` would render
  // every guard's `HTTPException` as plain text and quietly verify nothing.
  const app: TestApp = new Hono<{ Variables: { requestId: string } }>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req-test");
    await next();
  });
  app.onError(onApiError);
  app.route("/api/operations", routes);

  return { app, calls, closeResult: options.closeResult };
};

const get = (app: TestApp, path: string) => app.request(`http://localhost/api/operations${path}`);

const close = (app: TestApp, id: string, body: unknown) =>
  app.request(`http://localhost/api/operations/exceptions/${id}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("the operations guard", () => {
  test("401 when there is no session", async () => {
    const { app, calls } = harness({ signedInAs: null });

    const response = await get(app, `/exceptions?shopDomain=${SHOP}`);

    expect(response.status).toBe(401);
    // Nothing may run without a session -- not even a read.
    expect(calls.list).toBe(0);
  });

  /**
   * 401 and 403 are different problems with different fixes, and the dashboard needs to tell
   * them apart to prompt for the right one.
   */
  test("403 when signed in but not an operator", async () => {
    const { app, calls } = harness({ signedInAs: "customer@example.com", operator: false });

    const response = await get(app, `/exceptions?shopDomain=${SHOP}`);

    expect(response.status).toBe(403);
    expect(calls.list).toBe(0);
  });

  test("the 403 does not reveal whether the address is on the list", async () => {
    // Not because an authenticated caller could not work it out eventually, but because a
    // message that varied with the answer is an account oracle, and these two paths should not
    // drift apart in wording.
    const denied = harness({ signedInAs: "nobody@example.com", operator: false });
    const allowed = harness({ signedInAs: "ops@example.com", operator: true });

    const deniedBody = await (await get(denied.app, `/exceptions?shopDomain=${SHOP}`)).json();
    const allowedBody = await (await get(allowed.app, `/exceptions?shopDomain=${SHOP}`)).json();

    expect(deniedBody.error.message).not.toContain("not on the list");
    expect(allowedBody.error?.message).toBeUndefined();
  });

  test("an unauthenticated caller cannot close an exception either", async () => {
    const { app, calls } = harness({ signedInAs: null });

    const response = await close(app, "exc-1", { shopDomain: SHOP, status: "resolved", note: "done" });

    expect(response.status).toBe(401);
    expect(calls.close).toHaveLength(0);
  });
});

describe("GET /api/operations/exceptions", () => {
  test("returns the page and the acting operator", async () => {
    const { app } = harness();

    const response = await get(app, `/exceptions?shopDomain=${SHOP}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0]).toMatchObject({ id: "exc-1", severity: "blocking", status: "open" });
    // Dates go over the wire as ISO strings, not as Date objects: JSON.stringify would turn
    // them into strings anyway, but doing it explicitly means the shape is not an accident of
    // the serialiser.
    expect(body.data[0].createdAt).toBe("2026-09-28T12:00:00.000Z");
    expect(body.actor).toBe("ops@example.com");
  });

  test("requires a shopDomain rather than defaulting to one", async () => {
    const { app } = harness();

    // Defaulting would be fine until a second merchant connected, at which point the default
    // silently starts returning their data.
    expect((await get(app, "/exceptions")).status).toBe(400);
  });

  /**
   * The reason a typo cannot answer a question the operator did not ask.
   */
  test("rejects an unknown filter value instead of ignoring it", async () => {
    const { app } = harness();

    for (const query of ["status=opne", "severity=blockng", "type=unroutable_teapot", "status=open&status=resolvd"]) {
      expect((await get(app, `/exceptions?shopDomain=${SHOP}&${query}`)).status).toBe(400);
    }
  });

  test("rejects a limit outside 1..100, and a limit that is not a number", async () => {
    const { app } = harness();

    for (const limit of ["0", "101", "-1", "abc", "Infinity"]) {
      expect((await get(app, `/exceptions?shopDomain=${SHOP}&limit=${limit}`)).status).toBe(400);
    }
    expect((await get(app, `/exceptions?shopDomain=${SHOP}&limit=100`)).status).toBe(200);
  });

  test("rejects a malformed cursor rather than silently restarting at page one", async () => {
    const { app } = harness();

    // A cursor is attacker-controlled input like any other. Falling back to the first page
    // turns "your cursor is broken" into "here are some exceptions again", which an operator
    // re-triages as fresh work.
    expect((await get(app, `/exceptions?shopDomain=${SHOP}&cursor=not-base64!!`)).status).toBe(400);
    expect((await get(app, `/exceptions?shopDomain=${SHOP}&cursor=${Buffer.from("{}").toString("base64url")}`)).status).toBe(400);
    expect((await get(app, `/exceptions?shopDomain=${SHOP}&cursor=${Buffer.from('{"c":"nope","i":"x"}').toString("base64url")}`)).status).toBe(400);
  });

  test("round-trips a cursor", () => {
    const cursor = { createdAt: new Date("2026-09-28T12:00:00Z"), id: "exc-1" };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor(null)).toBeUndefined();
  });
});

describe("parseExceptionQuery", () => {
  test("defaults to the open queue, not every exception ever raised", () => {
    // Open-only is the difference between a queue and an archive. The closed ones in the same
    // list are history nobody reads.
    expect(parseExceptionQuery(new URLSearchParams({ shopDomain: SHOP })).status).toEqual(["open"]);
  });

  test("accepts repeated filters and keeps each one", () => {
    const parsed = parseExceptionQuery(new URLSearchParams("shopDomain=x.myshopify.com&status=open&status=ignored&severity=blocking&severity=warning"));

    expect(parsed.status).toEqual(["open", "ignored"]);
    expect(parsed.severity).toEqual(["blocking", "warning"]);
  });
});

describe("POST /api/operations/exceptions/:id/close", () => {
  const body = { shopDomain: SHOP, status: "resolved", note: "Restocked and re-routed." };

  test("closes and returns the updated exception", async () => {
    const { app, calls } = harness();

    const response = await close(app, "exc-1", body);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({ id: "exc-1", status: "resolved", resolvedBy: "ops@example.com" });
    expect(calls.close[0]).toMatchObject({ shopDomain: SHOP, exceptionId: "exc-1", status: "resolved" });
  });

  test("takes the actor from the session, and ignores one in the body", async () => {
    // `resolved_by` answers "who decided to ship this without stock?". An actor from the body is
    // an answer the caller chose, which makes the column decorative.
    const { app, calls } = harness({ signedInAs: "real-operator@example.com" });

    const response = await close(app, "exc-1", { ...body, actor: "someone-else@example.com", resolvedBy: "ceo@example.com" });

    expect(response.status).toBe(200);
    expect(calls.close[0]).toMatchObject({ actor: "real-operator@example.com" });
  });

  test("409 when someone else closed it first", async () => {
    const { app } = harness({
      closeResult: { outcome: "already_closed", exception: anException({ status: "resolved" }) },
    });

    const response = await close(app, "exc-1", body);

    // 409 rather than 200: both operators are looking at the same open entry, and the second one
    // has to know it lost, or their note vanishes with no signal.
    expect(response.status).toBe(409);
  });

  test("404 when the exception is gone, or belongs to another shop", async () => {
    const { app } = harness({ closeResult: { outcome: "not_found" } });

    const response = await close(app, "exc-1", body);

    // The same answer for "no such id" and "not yours" -- answering differently would make this
    // a probe for which exception ids exist in other tenants.
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).not.toMatch(/another shop|belongs/i);
  });

  test("rejects a close that cannot be audited", async () => {
    const { app, calls } = harness();

    const rejected: [unknown, RegExp][] = [
      [{ ...body, note: "" }, /note is required/i],
      [{ ...body, note: "   " }, /note is required/i],
      [{ ...body, status: "open" }, /status must be one of/i],
      [{ ...body, status: "closed" }, /status must be one of/i],
      [{ ...body, shopDomain: "" }, /shopDomain is required/i],
      [{ ...body, note: "x".repeat(2_001) }, /2000 characters/],
      ["not-an-object", /JSON body is required/],
    ];

    for (const [payload, message] of rejected) {
      const response = await close(app, "exc-1", payload);
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toMatch(message);
    }

    expect(calls.close).toHaveLength(0);
  });

  test("records `ignored` as a decision rather than a failure", async () => {
    const { app, calls } = harness();

    const response = await close(app, "exc-1", { ...body, status: "ignored" });

    expect(response.status).toBe(200);
    expect(calls.close[0]).toMatchObject({ status: "ignored" });
  });
});
