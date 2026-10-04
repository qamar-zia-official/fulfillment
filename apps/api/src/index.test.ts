import { expect, test } from "bun:test";
import app from "./index";

/**
 * Enough environment for `getAuth()` to construct.
 *
 * `getAuth` parses its env lazily, so setting these here is enough -- and the existing health test
 * keeps working without them, which is the point of that laziness. `DATABASE_URL` is never
 * dialled: Better Auth's `getSession` has no session cookie to look up, so it answers before
 * issuing a query. If that ever stops being true the assertions below fail loudly rather than
 * quietly needing a database.
 */
const withAuthEnv = () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-that-is-at-least-32-characters-long";
  process.env.BETTER_AUTH_URL ??= "http://localhost:4000";
  process.env.DATABASE_URL ??= "postgres://user:pass@127.0.0.1:1/unreachable";
};

test("GET /health returns the operational API status", async () => {
  const response = await app.request("http://localhost/health");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toMatchObject({ status: "ok", service: "kinetous-fulfillment-api" });
  expect(response.headers.get("x-request-id")).toBeString();
});

/**
 * The mount, on the real app.
 *
 * The route tests build their own Hono instance, which proves the handlers but not the wiring.
 * This one goes through `index.ts`, so a refactor that drops the `app.route` call -- or points it
 * at a different prefix -- fails here rather than in a browser. It asserts 401 rather than 200
 * because the guard is the part that must not be bypassable, and because reaching the repository
 * would need a database this test should not depend on.
 */
test("the operations API is mounted and refuses an unauthenticated caller", async () => {
  withAuthEnv();
  const response = await app.request("http://localhost/api/operations/exceptions?shopDomain=kinetous.myshopify.com");

  expect(response.status).toBe(401);
  const body = await response.json();
  expect(body).toMatchObject({ error: { code: "REQUEST_ERROR" } });
  expect(body.error.requestId).toBeString();
});

test("the session guard runs before the query is parsed", async () => {
  withAuthEnv();
  // A signed-out caller with a malformed request gets 401, not 400. The guard is first on
  // purpose: otherwise the response distinguishes "your query is well-formed" from "your query is
  // broken" for someone who has not proved they may ask. Answering 401 to both keeps the parser
  // entirely behind the authentication boundary.
  const response = await app.request("http://localhost/api/operations/exceptions");

  expect(response.status).toBe(401);
});
