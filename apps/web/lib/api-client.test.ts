import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OperationsApiError, closeException, listExceptions } from "./api-client";

/**
 * The client is tested against a stubbed `fetch` rather than a live API.
 *
 * The parts worth testing here are the ones that only misbehave when something goes wrong: the
 * error envelope, the non-envelope fallback, and the request wiring. A running server would
 * exercise the happy path, which is the path least likely to be wrong.
 */

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.NEXT_PUBLIC_API_URL = originalBaseUrl;
});

type Call = { url: string; init: RequestInit };

const stubFetch = (response: Response): Call[] => {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response;
  }) as typeof fetch;
  return calls;
};

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

const errorResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:4000";
});

describe("request wiring", () => {
  test("sends the session cookie cross-origin", async () => {
    // The whole reason this client exists in the browser rather than on the server: drop
    // `credentials` and every call is a 401 while the sign-in screen still looks fine.
    const calls = stubFetch(jsonResponse({ data: [], nextCursor: null, actor: "ops@example.com", requestId: "r1" }));

    await listExceptions(new URLSearchParams({ shopDomain: "kinetous.myshopify.com" }));

    expect(calls[0]?.init.credentials).toBe("include");
  });

  test("does not let a browser cache serve a stale queue", async () => {
    const calls = stubFetch(jsonResponse({ data: [], nextCursor: null, actor: "ops@example.com", requestId: "r1" }));

    await listExceptions(new URLSearchParams({ shopDomain: "kinetous.myshopify.com" }));

    // Without this, closing an exception can leave it on screen after a reload.
    expect(calls[0]?.init.cache).toBe("no-store");
  });

  test("appends the query to the configured base URL", async () => {
    const calls = stubFetch(jsonResponse({ data: [], nextCursor: null, actor: "ops@example.com", requestId: "r1" }));

    await listExceptions(new URLSearchParams({ shopDomain: "kinetous.myshopify.com", status: "open" }));

    expect(calls[0]?.url).toBe("http://localhost:4000/api/operations/exceptions?shopDomain=kinetous.myshopify.com&status=open");
  });

  test("tolerates a trailing slash on the configured base URL", async () => {
    // A slash in the env var produces `//api/...`, which some proxies redirect and some reject.
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:4000/";
    const calls = stubFetch(jsonResponse({ data: [], nextCursor: null, actor: "ops@example.com", requestId: "r1" }));

    await listExceptions(new URLSearchParams({ shopDomain: "kinetous.myshopify.com" }));

    expect(calls[0]?.url.startsWith("http://localhost:4000//")).toBe(false);
  });

  test("escapes an exception id in the close path", async () => {
    const calls = stubFetch(jsonResponse({ data: { id: "exc-1" }, requestId: "r1" }));

    await closeException({ id: "exc/../admin", shopDomain: "kinetous.myshopify.com", status: "resolved", note: "n" });

    expect(calls[0]?.url).toBe("http://localhost:4000/api/operations/exceptions/exc%2F..%2Fadmin/close");
  });

  test("fails with a configuration error, not a network error, when the base URL is unset", async () => {
    // A missing env var is a deploy mistake. Surfacing it as "Failed to fetch" would send an
    // operator to look at their own network instead of at the build.
    process.env.NEXT_PUBLIC_API_URL = "";
    stubFetch(jsonResponse({}));

    const error = await listExceptions(new URLSearchParams({ shopDomain: "kinetous.myshopify.com" })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OperationsApiError);
    expect((error as OperationsApiError).code).toBe("CONFIGURATION");
  });
});

describe("error mapping", () => {
  test("prefers the API's own request id over the response header", async () => {
    // A gateway in front of the API rewrites headers; the id the API logged is the one that
    // finds the request, so the body's wins.
    stubFetch(errorResponse(500, { error: { code: "INTERNAL_ERROR", message: "Boom.", requestId: "from-body" } }, { "x-request-id": "from-header" }));

    const error = (await listExceptions(new URLSearchParams({ shopDomain: "s.com" })).catch((e: unknown) => e)) as OperationsApiError;

    expect(error.requestId).toBe("from-body");
    expect(error.status).toBe(500);
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.message).toBe("Boom.");
  });

  test("falls back to the response header when the body has no id", async () => {
    stubFetch(errorResponse(401, { error: { code: "REQUEST_ERROR", message: "Sign in to use the operations API." } }, { "x-request-id": "from-header" }));

    const error = (await listExceptions(new URLSearchParams({ shopDomain: "s.com" })).catch((e: unknown) => e)) as OperationsApiError;

    expect(error.requestId).toBe("from-header");
  });

  test("keeps the status so the console can tell 401 from 403 from 409", async () => {
    // These three need different words in front of the operator and must not collapse into
    // "something went wrong": sign in, ask someone else, or accept that someone beat you to it.
    for (const [status, expected] of [
      [401, "Sign in to use the operations API."],
      [403, "This account is not permitted to use the operations API."],
      [409, "This exception was already closed by someone else."],
    ] as const) {
      stubFetch(errorResponse(status, { error: { code: "REQUEST_ERROR", message: expected } }));

      const error = (await listExceptions(new URLSearchParams({ shopDomain: "s.com" })).catch((e: unknown) => e)) as OperationsApiError;

      expect(error.status).toBe(status);
      expect(error.message).toBe(expected);
    }
  });

  test("survives a response that is not the error envelope", async () => {
    // An HTML page from a proxy or a load balancer. Showing the operator `[object Object]` would
    // be worse than showing a status.
    stubFetch(new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));

    const error = (await listExceptions(new URLSearchParams({ shopDomain: "s.com" })).catch((e: unknown) => e)) as OperationsApiError;

    expect(error.status).toBe(502);
    expect(error.message).toContain("502");
  });

  test("survives an error envelope with missing fields", async () => {
    stubFetch(errorResponse(400, { error: {} }));

    const error = (await listExceptions(new URLSearchParams({ shopDomain: "s.com" })).catch((e: unknown) => e)) as OperationsApiError;

    expect(error.status).toBe(400);
    expect(error.message).toContain("400");
  });

  test("reports a network failure as an error rather than an empty queue", async () => {
    // The dangerous outcome for a triage screen is a caught error rendered as "no exceptions".
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(listExceptions(new URLSearchParams({ shopDomain: "s.com" }))).rejects.toThrow();
  });
});
