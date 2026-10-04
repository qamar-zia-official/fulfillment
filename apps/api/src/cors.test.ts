import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { allowedBrowserOrigins, corsMiddleware } from "./cors";
import { onApiError } from "./error-handler";

const env = (
  overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv => ({
  WEB_APP_URL: "http://localhost:3000",
  BETTER_AUTH_URL: "http://localhost:4000",
  ...overrides,
});

const app = (environment: NodeJS.ProcessEnv) => {
  const instance = new Hono();
  instance.use("*", corsMiddleware(environment));
  instance.get("/api/operations/exceptions", (c) =>
    c.json({ data: [], nextCursor: null }),
  );
  return instance;
};

describe("allowedBrowserOrigins", () => {
  test("returns the origins of the dashboard and the auth API", () => {
    expect(allowedBrowserOrigins(env())).toEqual([
      "http://localhost:3000",
      "http://localhost:4000",
    ]);
  });

  test("deduplicates when both variables point at one origin", () => {
    expect(
      allowedBrowserOrigins(env({ BETTER_AUTH_URL: "http://localhost:3000" })),
    ).toEqual(["http://localhost:3000"]);
  });

  test("reduces a URL to its origin, dropping the path and any credentials", () => {
    // `https://user:pass@shop.example.com/admin?x=1` is one origin as far as a browser is
    // concerned, and allowing the whole string would never match an Origin header.
    expect(
      allowedBrowserOrigins(
        env({
          WEB_APP_URL: "https://user:pass@shop.example.com/admin?x=1",
          BETTER_AUTH_URL: "",
        }),
      ),
    ).toEqual(["https://shop.example.com"]);
  });

  /**
   * The fail-closed cases, as one test each because they fail differently.
   *
   * Every one of these inputs authorises *nobody*, which is the property that matters: the wrong
   * answer is a list containing a wildcard or the literal string "null", both of which are worse
   * than an empty list.
   */
  test("authorises nobody when the variables are missing", () => {
    expect(allowedBrowserOrigins({})).toEqual([]);
  });

  test("authorises nobody when the variables are empty strings", () => {
    // An empty env var is the *likely* deployment mistake, not an exotic one.
    expect(
      allowedBrowserOrigins({ WEB_APP_URL: "", BETTER_AUTH_URL: "" }),
    ).toEqual([]);
  });

  test("ignores a malformed value rather than falling back to a wildcard", () => {
    expect(allowedBrowserOrigins(env({ WEB_APP_URL: "not a url" }))).toEqual([
      "http://localhost:4000",
    ]);
  });

  test("ignores a scheme-less host, which URL parses to a null origin", () => {
    // `new URL("localhost:3000")` succeeds with protocol "localhost:" and origin "null".
    // Emitting that as an allowed origin would hand the API to every sandboxed iframe.
    expect(
      allowedBrowserOrigins(env({ WEB_APP_URL: "localhost:3000" })),
    ).toEqual(["http://localhost:4000"]);
  });

  test("ignores a non-http scheme", () => {
    expect(
      allowedBrowserOrigins(env({ WEB_APP_URL: "javascript://evil.example" })),
    ).toEqual(["http://localhost:4000"]);
  });
});

describe("cors middleware", () => {
  const call = (
    environment: NodeJS.ProcessEnv,
    origin: string,
    path = "/api/operations/exceptions",
  ) => app(environment).request(path, { headers: { origin } });

  test("allows the configured dashboard origin and advertises credentialed requests", async () => {
    const response = await call(env(), "http://localhost:3000");

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    // Without this the dashboard cannot show the request id, which is the one useful thing to
    // put in front of a user who has hit a 5xx.
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "x-request-id",
    );
    // Caches must not serve one origin's response to another.
    expect(response.headers.get("vary")).toContain("Origin");
  });

  test("sends no allow-origin header for an unlisted origin", async () => {
    const response = await call(env(), "https://attacker.example");

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  /**
   * The request still succeeds.
   *
   * CORS is enforced by the *browser* refusing to hand the response to JavaScript, not by the
   * server refusing to answer. An attacker with curl is unaffected by any allow-list here, which
   * is exactly why these routes also require a session -- the two controls are independent and
   * neither substitutes for the other.
   */
  test("still serves the request to a non-browser client, with no CORS headers", async () => {
    const response = await app(env()).request("/api/operations/exceptions");

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("answers a preflight from the dashboard without reaching the route", async () => {
    const instance = new Hono();
    instance.use("*", corsMiddleware(env()));
    instance.get(
      "/api/operations/exceptions",
      () => new Response("route body", { status: 200 }),
    );

    const response = await instance.request("/api/operations/exceptions", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    // Echoing whatever the browser asked for would make this header meaningless as a reviewable
    // statement of what the API accepts.
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type, x-request-id",
    );
    expect(response.headers.get("access-control-max-age")).toBe("600");
  });

  /**
   * The reason this middleware is hand-written.
   *
   * `hono/cors` sets its headers before awaiting the handler, and Hono builds a *new* response
   * when a handler throws -- so every error response came back without `Access-Control-Allow-Origin`
   * and the browser reported a generic CORS failure instead of the message the API had just
   * carefully written. This is the 401 an unauthenticated dashboard gets on its first load, the
   * 403 for a non-operator, and the 409 when an operator loses a close race: precisely the
   * responses whose whole job is to say what went wrong.
   */
  test("keeps CORS headers on an error response", async () => {
    const instance = new Hono();
    instance.use("*", corsMiddleware(env()));
    instance.onError(onApiError);
    instance.get("/api/operations/exceptions", () => {
      throw new HTTPException(403, {
        message: "This account is not permitted to use the operations API.",
      });
    });

    const response = await instance.request("/api/operations/exceptions", {
      headers: { origin: "http://localhost:3000" },
    });

    expect(response.status).toBe(403);
    // The message has to survive, or the operator cannot tell 403 from a network fault.
    expect(await response.json()).toMatchObject({
      error: {
        message: "This account is not permitted to use the operations API.",
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
  });

  test("withholds CORS headers from an error response for an unlisted origin", async () => {
    const instance = new Hono();
    instance.use("*", corsMiddleware(env()));
    instance.onError(onApiError);
    instance.get("/api/operations/exceptions", () => {
      throw new HTTPException(403, { message: "nope" });
    });

    const response = await instance.request("/api/operations/exceptions", {
      headers: { origin: "https://attacker.example" },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("preflights from an unlisted origin are not allowed", async () => {
    const response = await app(env()).request("/api/operations/exceptions", {
      method: "OPTIONS",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "POST",
      },
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
