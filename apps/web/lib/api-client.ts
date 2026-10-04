import type { ExceptionSeverity, ExceptionStatus, FulfillmentExceptionType } from "@repo/domain";

/**
 * The typed client for the operations API.
 *
 * `credentials: "include"` on every call, deliberately. The session cookie is the only thing
 * authorising these routes, and the dashboard is a different origin from the API, so a request
 * without it is a 401. The alternative -- proxying the queue through a Next.js server component
 * and forwarding the cookie by hand -- only works while the browser happens to send the API's
 * cookie to the *dashboard's* origin, which is true on localhost (cookies ignore ports) and
 * false the moment the two are deployed to different subdomains. This way works in both, and
 * does not need the cookie to be readable by JavaScript.
 */

/** One exception, in the shape `serialise` in `apps/api/src/operations.ts` produces. */
export type ExceptionDto = {
  readonly id: string;
  readonly orderId: string;
  readonly type: FulfillmentExceptionType;
  readonly severity: ExceptionSeverity;
  readonly status: ExceptionStatus;
  readonly reason: string;
  readonly details: Record<string, unknown>;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly resolutionNote: string | null;
};

export type ExceptionPageDto = {
  readonly data: readonly ExceptionDto[];
  readonly nextCursor: string | null;
  readonly actor: string;
  readonly requestId: string;
};

/**
 * A failed API call, carrying enough to tell the operator what to do next.
 *
 * `status` is kept because the three interesting cases need different messages and the console
 * must not have to re-derive them from a string: 401 means sign in, 403 means this account is not
 * an operator (retrying will not help), and 409 means another operator closed the same exception
 * first -- which is information, not a failure to report as one.
 *
 * `requestId` is the API's own correlation id, so a report of "it said no" can be traced to a
 * specific request in the logs instead of a timestamp and a shrug.
 */
export class OperationsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "OperationsApiError";
  }
}

const apiBaseUrl = (): string => {
  // Inlined at build time by Next, so a missing value here means the deploy forgot
  // NEXT_PUBLIC_API_URL rather than that the browser cannot reach the API at runtime.
  const base = process.env.NEXT_PUBLIC_API_URL;

  if (!base) {
    throw new OperationsApiError(
      0,
      "NEXT_PUBLIC_API_URL is not set. The dashboard cannot reach the API without it.",
      "CONFIGURATION",
      null,
    );
  }

  return base.replace(/\/$/, "");
};

/**
 * Turns a non-2xx response into an {@link OperationsApiError}.
 *
 * The API's error envelope is `{ error: { code, message, requestId } }` from a single handler, so
 * one shape covers every 4xx and 5xx. When the body is not that shape -- a proxy timeout, an HTML
 * error page from something in front of the API -- the status text is used instead, because a
 * console showing the operator `[object Object]` is worse than one showing them a bare code.
 */
const toApiError = async (response: Response): Promise<OperationsApiError> => {
  const requestId = response.headers.get("x-request-id");

  let code = "REQUEST_ERROR";
  let message = `Request failed with status ${response.status}.`;

  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body) {
      const error = (body as { error: { code?: unknown; message?: unknown; requestId?: unknown } }).error;
      if (typeof error.message === "string" && error.message.length > 0) message = error.message;
      if (typeof error.code === "string" && error.code.length > 0) code = error.code;
      if (typeof error.requestId === "string") return new OperationsApiError(response.status, message, code, error.requestId);
    }
  } catch {
    // Not the envelope. Keep the status-derived message.
  }

  return new OperationsApiError(response.status, message, code, requestId);
};

const request = async (path: string, init: RequestInit): Promise<Response> => {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    // A queue is live data. Without this a browser is entitled to serve a stale page back from
    // its own cache after a close, and the operator sees the entry they just resolved still
    // sitting in the list.
    cache: "no-store",
    headers: { "content-type": "application/json", ...init.headers },
  });

  if (!response.ok) throw await toApiError(response);
  return response;
};

export const listExceptions = async (query: URLSearchParams, signal?: AbortSignal): Promise<ExceptionPageDto> =>
  (await request(`/api/operations/exceptions?${query.toString()}`, { method: "GET", signal })).json() as Promise<ExceptionPageDto>;

export const closeException = async (input: {
  readonly id: string;
  readonly shopDomain: string;
  readonly status: "resolved" | "ignored";
  readonly note: string;
}): Promise<ExceptionDto> => {
  const response = await request(`/api/operations/exceptions/${encodeURIComponent(input.id)}/close`, {
    method: "POST",
    body: JSON.stringify({ shopDomain: input.shopDomain, status: input.status, note: input.note }),
  });

  // Unwrapped through a named binding rather than `(... as { data: ExceptionDto }).data`. The
  // assertion-then-member-access form is both a parse error here and harder to read than two
  // lines that say what the response looks like and what we keep.
  const payload = (await response.json()) as { data: ExceptionDto };
  return payload.data;
};
