import type { Context, Next } from "hono";

/**
 * Browser origins permitted to make credentialed requests to this API.
 *
 * The dashboard runs on a different origin from the API (localhost:3000 -> localhost:4000 in
 * development, `app.` and `api.` subdomains in production), so the browser will not hand it a
 * response unless this API says so in `Access-Control-Allow-Origin`. Without this the queue is
 * reachable from curl and unreachable from the one thing meant to use it.
 *
 * Two properties matter more than convenience here:
 *
 *   - It is an explicit list, never `*`. `credentials: true` combined with a wildcard origin is
 *     rejected by browsers *and* would be meaningless as a security boundary if it were not, so
 *     the wildcard is not an option to reach for when a variable is missing.
 *   - It is derived from the same variables Better Auth uses for `trustedOrigins`
 *     (`WEB_APP_URL`, `BETTER_AUTH_URL`). Two independent origin lists in one deployment is how
 *     "signs in fine, then every request 401s" happens: one list trusts the origin and the other
 *     does not, and which one is wrong is not obvious from the symptom.
 */

export const allowedBrowserOrigins = (
  env: NodeJS.ProcessEnv = process.env,
): string[] => {
  const origins = new Set<string>();
  for (const candidate of [env.WEB_APP_URL, env.BETTER_AUTH_URL]) {
    if (!candidate) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (!url.origin || url.origin === "null") continue;
    origins.add(url.origin);
  }
  return [...origins];
};
const ALLOW_METHODS = "GET, POST, OPTIONS";
const ALLOW_HEADERS = "content-type, x-request-id";
const MAX_AGE_SECONDS = "600";
const applyHeaders = (c: Context, allowOrigin: string) => {
  c.res.headers.set("Access-Control-Allow-Origin", allowOrigin);
  c.res.headers.set("Access-Control-Allow-Credentials", "true");
  c.res.headers.set("Access-Control-Expose-Headers", "x-request-id");
  c.res.headers.set("Vary", "Origin");
};

/**
 * CORS for the browser-facing routes.
 *
 * Hand-written rather than `hono/cors`, for one specific reason: that middleware sets its
 * headers *before* awaiting the downstream handler, and Hono builds a **new** response object
 * when a handler throws. Every error response therefore loses its CORS headers, and the browser
 * reports "CORS error" instead of the message the API actually sent.
 *
 * That is not a rare path here -- it is the 401 that a signed-out dashboard gets on its very
 * first load, the 403 for an account that is not an operator, the 409 when another operator
 * closed an exception first, and every 400. The API's own error envelope is designed to tell an
 * operator what went wrong and which request to quote, and this bug is what silently throws all
 * of it away, replacing it with the one message that helps nobody. `cors.test.ts` asserts the
 * headers on a thrown error for exactly this reason.
 *
 * The env is read per middleware *creation* rather than at module scope, and this factory is
 * called from `index.ts`, so importing the app without a populated environment still works.
 */
export const corsMiddleware = (env: NodeJS.ProcessEnv = process.env) => {
  const allowed = allowedBrowserOrigins(env);

  return async (c: Context, next: Next) => {
    const origin = c.req.header("origin");
    // Null for a missing, unlisted, or empty Origin. No header is the correct answer in all
    // three cases: a non-browser client does not care, and a browser on another site cannot
    // read the response either way.
    const allowOrigin = origin && allowed.includes(origin) ? origin : null;

    if (allowOrigin) applyHeaders(c, allowOrigin);

    if (c.req.method === "OPTIONS") {
      if (allowOrigin) {
        c.header("Access-Control-Allow-Methods", ALLOW_METHODS);
        c.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
        c.header("Access-Control-Max-Age", MAX_AGE_SECONDS);
      }
      return c.body(null, 204);
    }

    await next();

    // Re-apply to whatever response the handler produced. On the success path this is a no-op;
    // on the error path it is the difference between the operator seeing "This account is not
    // permitted" and seeing nothing at all.
    if (allowOrigin) applyHeaders(c, allowOrigin);
  };
};
