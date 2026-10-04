import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

/**
 * Locates the monorepo root and loads its `.env` files.
 *
 * Why this exists instead of a bare `dotenv/config`:
 *
 * Turbo runs every task with `cwd` set to the *package* directory, not the repo root.
 * So `apps/api` sees `apps/api/.env`, `packages/db` sees `packages/db/.env`, and a
 * root-level `.env` is invisible to both. That is exactly the bug this module fixes:
 * environment configuration silently missing at runtime.
 *
 * We therefore walk up from this module's own location until we find the package.json
 * that declares `workspaces`, which is the definition of the monorepo root. This is
 * independent of `process.cwd()`, so it works under Turbo, plain `bun run`, and `bunx`.
 *
 * Precedence: dotenv never overrides variables that already exist in `process.env`, so
 * a real deployment environment (Vercel, CI, Docker) always wins over the local file.
 */

let cachedRoot: string | undefined;

export function findRepositoryRoot(): string {
  if (cachedRoot) return cachedRoot;

  let directory = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const contents = readManifest(manifest);
      if (contents.workspaces) {
        cachedRoot = directory;
        return directory;
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Could not locate the monorepo root: no package.json declaring \"workspaces\" was found above this module.");
    }
    directory = parent;
  }
}

type Manifest = { workspaces?: unknown };

function readManifest(path: string): Manifest {
  try {
    // The manifest is repo-controlled, but still parsed defensively rather than blindly cast.
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch {
    return {};
  }
}

/**
 * Loads `<repo-root>/.env` and `<repo-root>/.env.local` into `process.env`.
 * Idempotent: calling it more than once is harmless.
 */
export function loadRepositoryEnvironment(): void {
  const root = findRepositoryRoot();

  // Precedence (dotenv does not overwrite already-set values):
  //   .env.local overrides .env, and both yield to real process env.
  config({ path: resolve(root, ".env"), quiet: true });
  config({ path: resolve(root, ".env.local"), override: true, quiet: true });
}
