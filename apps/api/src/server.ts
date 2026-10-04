import app from "./index";
import { parseServerEnvironment } from "@repo/validation/environment";
import { loadRepositoryEnvironment } from "@repo/validation/environment-loader";

// Load the repo-root .env before anything reads process.env. The loader never overrides
// variables that are already set, so a real deployment environment always wins.
loadRepositoryEnvironment();

const environment = parseServerEnvironment();

/**
 * The HTTP boundary: Hono's `app.request()`-compatible fetch handler plus an explicit
 * listener.
 *
 * Why this file exists separately from `index.ts`:
 *
 * `bun run --hot src/index.ts` on a module that only default-exports a Hono app makes
 * Bun treat that export as a server config and call `Bun.serve()` with *its* defaults,
 * which is port 3000 -- the same port `next dev` uses. The result is an EADDRINUSE
 * crash at best, and a silently wrong port at worst.
 *
 * Making the listener explicit means the port comes from configuration (`API_PORT`),
 * the same value `.env.example` and the web app's `NEXT_PUBLIC_API_URL` document,
 * instead of being a framework default.
 *
 * `index.ts` stays listener-free on purpose: API tests use `app.request()` and must not
 * need to bind a port.
 */
const server = Bun.serve({
  port: environment.API_PORT,
  fetch: app.fetch,
  error(error) {
    console.error("Unhandled error outside the Hono pipeline", error);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(
  `kinetous-fulfillment-api listening on http://localhost:${server.port} (${environment.NODE_ENV})`,
);

export { server };
export type ApiServer = typeof server;
