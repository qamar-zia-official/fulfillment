import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { accounts, getDb, sessions, users, verifications } from "@repo/db";
import { parseServerEnvironment } from "@repo/validation/environment";

/**
 * Better Auth configuration.
 *
 * This lives in `@repo/auth` rather than in an app file because both the Hono API
 * (which serves `/api/auth/*`) and the dashboard (which holds the client) need to agree
 * on the same instance, settings, and origin rules. Two divergent copies of auth config
 * is how "works locally, 401s in production" bugs are born.
 *
 * Env is parsed lazily inside `createAuth()` rather than at module scope so that simply
 * importing this module (for example from a unit test) does not require a fully
 * populated environment.
 */
export function createAuth() {
  const environment = parseServerEnvironment();

  // The dashboard and the auth API are different origins in local development
  // (localhost:3000 -> localhost:4000). Better Auth rejects cross-origin requests that
  // carry credentials unless the origin is trusted, so without this the browser session
  // would sign in successfully and then appear logged out on the next request.
  const trustedOrigins = [
    new URL(environment.BETTER_AUTH_URL).origin,
    new URL(environment.WEB_APP_URL).origin,
  ];

  return betterAuth({
    baseURL: environment.BETTER_AUTH_URL,
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins,
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        account: accounts,
        session: sessions,
        user: users,
        verification: verifications,
      },
    }),
    emailAndPassword: { enabled: true },
    advanced: { database: { joins: true } },
  });
}

export type Auth = ReturnType<typeof createAuth>;

let auth: Auth | undefined;

export function getAuth(): Auth {
  auth ??= createAuth();
  return auth;
}

/**
 * Whether an account may use the operations endpoints.
 *
 * Exported separately from `createAuth` so the check is a pure function of the environment and
 * an email, and can be tested without constructing a Better Auth instance or touching a
 * database. The comparison is on the lower-cased address because email is case-insensitive in
 * practice and Better Auth does not normalise it consistently across the providers it can be
 * configured with -- so without this, `Ops@Example.com` and `ops@example.com` are two accounts
 * and the allow-list is half-useless.
 *
 * Fails closed: an unset or empty `OPERATOR_EMAILS` authorises nobody. See the note on the
 * variable in `@repo/validation` for why the default is not "allow all".
 */
export function isOperator(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = parseServerEnvironment().OPERATOR_EMAILS;
  return allowed.includes(email.trim().toLowerCase());
}
