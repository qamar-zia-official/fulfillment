import { expect, test } from "bun:test";
import { getDb } from "../client";
import { accounts, orderItems, orders, sessions, users } from "./index";
import { loadRepositoryEnvironment } from "@repo/validation/environment-loader";

loadRepositoryEnvironment();

/**
 * Regression test for a bug that made every Better Auth sign-in return HTTP 500.
 *
 * The schema declared foreign keys (`.references()`) on `sessions` and `accounts` but no
 * Drizzle `relations()`. Better Auth's adapter uses the relational query builder, which
 * resolved those relations to `undefined` and threw at query time:
 *
 *   TypeError: undefined is not an object (evaluating 'relation.referencedTable')
 *
 * Account creation still worked, because it is a plain INSERT. Session lookup is a
 * relational query, so it failed. This test exercises the relational builder directly so
 * a missing `relations()` declaration fails here rather than in production sign-in.
 */

/**
 * This test needs a reachable database, which is a network resource we do not control.
 * Neon in particular scales to zero, so a cold first query can take several seconds.
 * If the database is genuinely unreachable that is an environment problem, not a code
 * defect, so we skip with a reason instead of reporting a false failure.
 */
const databaseReachable = await (async () => {
  try {
    await getDb().execute("select 1");
    return true;
  } catch {
    return false;
  }
})();

const REMOTE_DATABASE_TIMEOUT_MS = 20_000;

test.skipIf(!databaseReachable)("relational queries resolve every declared relation", async () => {
  const db = getDb();

  // These run concurrently on purpose. A relational query is one round trip each, and
  // serialising five of them against a remote, cold-starting database previously pushed
  // this test past the default 5s timeout -- a flaky test that reports failures which
  // have nothing to do with the code under test.
  const [usersWithSessions, sessionsWithUser, accountsWithUser, ordersWithItems, itemsWithOrder] = await Promise.all([
    // `with: { sessions: true }` can only be built if usersRelations/sessionsRelations exist.
    db.query.users.findMany({ with: { sessions: true }, limit: 1 }),
    db.query.sessions.findMany({ with: { user: true }, limit: 1 }),
    db.query.accounts.findMany({ with: { user: true }, limit: 1 }),
    db.query.orders.findMany({ with: { items: true }, limit: 1 }),
    db.query.orderItems.findMany({ with: { order: true }, limit: 1 }),
  ]);

  expect(Array.isArray(usersWithSessions)).toBe(true);
  expect(Array.isArray(sessionsWithUser)).toBe(true);
  expect(Array.isArray(accountsWithUser)).toBe(true);
  expect(Array.isArray(ordersWithItems)).toBe(true);
  expect(Array.isArray(itemsWithOrder)).toBe(true);
}, REMOTE_DATABASE_TIMEOUT_MS);

test("every table the relational query builder needs is exported from the schema barrel", () => {
  // Guards against a relation being declared against a table that is never re-exported
  // from src/schema/index.ts, which silently disables the relational API for that entity
  // because the Drizzle client only registers what it receives in its `schema` option.
  for (const table of [users, sessions, accounts, orders, orderItems]) {
    expect(table).toBeDefined();
  }
});
