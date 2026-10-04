import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { toApiError } from "./api-errors";

/**
 * The one place an error becomes an HTTP response.
 *
 * Extracted from `index.ts` so the operations routes can be tested against the real handler
 * rather than a copy of it. That matters more than it sounds: every route guard throws an
 * `HTTPException`, and Hono's *default* handler renders one as a plain-text body. A test harness
 * without this handler therefore sees `"Sign in..."` where production sees
 * `{"error":{"code":"REQUEST_ERROR",...}}` -- and the response contract for every 4xx in the
 * operations API would be verified by nothing.
 */
export const onApiError: ErrorHandler = (error: Error, c: Context) => {
  const requestId = c.get("requestId" as never) as string | undefined;

  if (error instanceof HTTPException) {
    // Raised deliberately by our own route guards (bad signature, missing header, not an
    // operator). Not a domain error, so it keeps its own wording -- these messages are authored
    // to be safe.
    return c.json({ error: { code: "REQUEST_ERROR", message: error.message, requestId } }, error.status);
  }

  const { status, body } = toApiError(error, requestId ?? "");
  // A 5xx means we broke; a 4xx means the caller did. Only the former earns a stack trace,
  // and logging a stack for every 422 turns real incidents into noise.
  if (status >= 500) {
    console.error("API request failed", {
      requestId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
    });
  }
  return c.json(body, status as 400);
};
