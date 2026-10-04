import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepositoryRoot, loadRepositoryEnvironment } from "./environment-loader";
import {
  parsePublicEnvironment,
  parseServerEnvironment,
  publicEnvironmentSchema,
  serverEnvironmentSchema,
} from "./environment";

const validServer = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/fulfillment",
  BETTER_AUTH_SECRET: "a-secret-that-is-definitely-long-enough-32",
  BETTER_AUTH_URL: "http://localhost:4000",
};

test("finds the monorepo root by locating the manifest that declares workspaces", () => {
  const root = findRepositoryRoot();
  const manifest = readFileSync(join(root, "package.json"), "utf8");

  // The root is where the workspace-owning package.json lives, regardless of the cwd
  // this test happens to run from. Turbo runs every task with cwd = package dir, which
  // is exactly the condition that made the original env loading silently fail.
  expect(existsSync(join(root, "package.json"))).toBe(true);
  expect(manifest).toContain('"workspaces"');
  expect(existsSync(join(root, "packages/db/drizzle.config.ts"))).toBe(true);
});

test("the discovered root is the same regardless of process.cwd()", async () => {
  const original = process.cwd();
  const first = findRepositoryRoot();
  try {
    process.chdir("/tmp");
    expect(findRepositoryRoot()).toBe(first);
  } finally {
    process.chdir(original);
  }
});

test("loads the repo-root .env into process.env without throwing", () => {
  expect(() => loadRepositoryEnvironment()).not.toThrow();
  // Idempotent: a second call must be a no-op rather than an error or a re-parse.
  expect(() => loadRepositoryEnvironment()).not.toThrow();
});

test("applies the documented API_PORT default", () => {
  const environment = parseServerEnvironment(validServer);
  expect(environment.API_PORT).toBe(4000);
});

test("coerces API_PORT from the environment string", () => {
  const environment = parseServerEnvironment({ ...validServer, API_PORT: "8080" });
  expect(environment.API_PORT).toBe(8080);
});

test("rejects a BETTER_AUTH_SECRET that is too short to be safe", () => {
  const result = serverEnvironmentSchema.safeParse({ ...validServer, BETTER_AUTH_SECRET: "short" });
  expect(result.success).toBe(false);
});

test("rejects a missing DATABASE_URL, because every server context needs Postgres", () => {
  const result = serverEnvironmentSchema.safeParse({
    BETTER_AUTH_SECRET: validServer.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: validServer.BETTER_AUTH_URL,
  });
  expect(result.success).toBe(false);
});

test("treats integration secrets as optional until those phases are built", () => {
  const environment = parseServerEnvironment(validServer);
  expect(environment.SHOPIFY_WEBHOOK_SECRET).toBeUndefined();
  expect(environment.RESEND_API_KEY).toBeUndefined();
  expect(environment.THREE_PL_API_KEY).toBeUndefined();
});

test("defaults WEB_APP_URL to the dashboard dev origin", () => {
  const environment = parseServerEnvironment(validServer);
  expect(environment.WEB_APP_URL).toBe("http://localhost:3000");
});

test("public environment requires a NEXT_PUBLIC_API_URL", () => {
  expect(parsePublicEnvironment({ NEXT_PUBLIC_API_URL: "http://localhost:4000" }).NEXT_PUBLIC_API_URL).toBe(
    "http://localhost:4000",
  );
  expect(publicEnvironmentSchema.safeParse({}).success).toBe(false);
});
