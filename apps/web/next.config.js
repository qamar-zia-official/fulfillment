import path from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";

// `@next/env` ships as CommonJS, so it is consumed via the default export.
const { loadEnvConfig } = nextEnv;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The dashboard has no `.env` of its own.
 *
 * Next.js only reads env files from its own directory, but the monorepo keeps a single
 * root `.env` (see `.env.example`) shared by the API, drizzle-kit, and Trigger.dev.
 * Duplicating it into `apps/web/.env.local` would give us two files that drift apart and
 * two places to leak a secret from.
 *
 * `loadEnvConfig` from `@next/env` is Next's own supported loader, pointed at a
 * non-default directory. It runs while `next.config.js` is being evaluated, which is
 * early enough for `process.env.NEXT_PUBLIC_*` values to be inlined into the client
 * bundle during the build.
 */
loadEnvConfig(repositoryRoot);

const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
