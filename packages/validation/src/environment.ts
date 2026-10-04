import { z } from "zod";

/**
 * Environment variable schemas.
 *
 * These are split by *runtime context* rather than kept as one flat schema, because
 * the processes in this monorepo do not all need the same secrets:
 *
 *   drizzle.config.ts  -> needs DATABASE_URL only
 *   apps/api           -> needs database + auth + port
 *   apps/web           -> needs public vars (browser-visible) + server-only vars
 *   packages/tasks     -> needs TRIGGER_SECRET_KEY (validated by the Trigger CLI)
 *
 * A single flat "everything required" schema would make `bun run db:push` fail on a
 * machine that has no auth secret, which is a confusing failure for the wrong reason.
 *
 * Precedence for every value is:
 *   1. real process environment (Vercel / CI / Docker)  <- highest
 *   2. the repo-root .env file (local development)
 *   3. the schema default
 */

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

/** Anything that opens a Postgres connection. Used by drizzle-kit and the API. */
export const databaseEnvironmentSchema = environmentSchema.extend({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required to reach Postgres."),
});

/** Full server environment for the Hono API process. */
export const serverEnvironmentSchema = databaseEnvironmentSchema.extend({
  API_PORT: z.coerce.number().int().positive().default(4000),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters."),
  /** Origin the auth API is served from (the Hono API itself). */
  BETTER_AUTH_URL: z.string().url(),
  /** Origin of the dashboard. Needed so cookie auth works cross-origin in development. */
  WEB_APP_URL: z.string().url().default("http://localhost:3000"),
  // Optional: only needed once the corresponding integration is wired up.
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  THREE_PL_API_KEY: z.string().min(1).optional(),

  /**
   * Emails allowed to use the operations endpoints, comma separated.
   *
   * Better Auth runs with `emailAndPassword` enabled and no signup restriction, so "has a
   * session" is not a meaningful boundary for operational data: anyone who can register an
   * account can then read every merchant's exceptions, which carry customer names, addresses,
   * and order contents. `users` has no role column, so an allow-list is what stands between an
   * open signup form and a cross-merchant data read.
   *
   * An allow-list rather than a `role` column on `users`, because the column is not the hard
   * part -- deciding who gets assigned a role is, and that is a signup-flow decision this code
   * does not own yet. When it exists, `isOperator` becomes one query instead of a list
   * comparison and nothing else has to change.
   *
   * Unset means nobody, not everybody. A missing variable that defaulted to "allow all" would
   * turn a deployment mistake into a breach, and the failure would be invisible until someone
   * used it.
   */
  OPERATOR_EMAILS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.length > 0),
    ),
});

/** Browser-visible variables. Never put a secret behind a NEXT_PUBLIC_ prefix. */
export const publicEnvironmentSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
});

export type DatabaseEnvironment = z.infer<typeof databaseEnvironmentSchema>;
export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;
export type PublicEnvironment = z.infer<typeof publicEnvironmentSchema>;

export function parseDatabaseEnvironment(source: Record<string, string | undefined> = process.env): DatabaseEnvironment {
  return databaseEnvironmentSchema.parse(source);
}

export function parseServerEnvironment(source: Record<string, string | undefined> = process.env): ServerEnvironment {
  return serverEnvironmentSchema.parse(source);
}

export function parsePublicEnvironment(source: Record<string, string | undefined> = process.env): PublicEnvironment {
  return publicEnvironmentSchema.parse(source);
}
