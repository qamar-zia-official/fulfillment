import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { FULFILLMENT_EXCEPTION_TYPES, ORDER_STATUSES } from "@repo/domain";
import { loadRepositoryEnvironment } from "@repo/validation/environment-loader";
import { getDb } from "../client";
import { FULFILLMENT_EXCEPTION_SEVERITIES, FULFILLMENT_EXCEPTION_STATUSES, RESERVATION_STATUSES } from "./warehouses";

loadRepositoryEnvironment();

/**
 * Guards the SQL/domain status lists against each other.
 *
 * A CHECK constraint cannot take bind parameters, so the list has to be restated as a string
 * literal in the schema. That is genuine duplication, and the usual outcome is that one side
 * moves and the other does not. The two failure modes are both bad and both silent:
 *
 *   - The domain adds a state, the database does not. Every attempt to write an order in that
 *     state fails with a constraint violation, so the feature is dead at runtime rather than at
 *     compile time.
 *   - The constraint is wrong in a subtler way. When a CHECK is written with `sql.join` instead
 *     of `sql.raw`, Drizzle emits *bind parameters*, and the applied DDL ends up as
 *     `type in ('$1','$2')`. That constraint rejects every row while looking entirely correct
 *     in the schema source. This file was written after that bug shipped, and it exists
 *     because reading the generated migration is not a practice anyone keeps up.
 *
 * So the assertions below read the constraint definitions back **out of the live database**
 * rather than out of the schema source or the migration file. Reading the live catalog is the
 * only one of those three that would have caught a parameter-binding mistake: the schema
 * source and the migration file both looked fine.
 */

const runIntegration = process.env.SKIP_DB_INTEGRATION !== "1";
const REMOTE_DATABASE_TIMEOUT_MS = 30_000;
const db = getDb();

const databaseReachable = runIntegration
  ? await (async () => {
      try {
        await db.execute("select 1");
        return true;
      } catch {
        return false;
      }
    })()
  : false;

/**
 * Pulls the quoted literals out of the list in a CHECK definition.
 *
 * Postgres rewrites `x in ('a','b')` into `x = ANY (ARRAY['a'::text, 'b'::text])`, so the
 * text of the applied constraint does not look like the SQL that was written -- matching on
 * the literal `IN` is what this helper did first, and it silently returned nothing for every
 * constraint. That is the same failure mode as the bug it is meant to catch: an empty result
 * that reads as "nothing found" rather than "parsed wrongly". The `::type` casts are stripped
 * and every quoted literal is collected, which covers both spellings.
 *
 * The constraints under test contain no string literals other than the ones being compared,
 * so "all quoted literals" is the list here.
 */
const literalsOf = (definition: string): string[] => {
  const withoutCasts = definition.replaceAll(/::[a-z_ ]+(?=\s*[,\]])/gi, "");
  return [...withoutCasts.matchAll(/'([^']*)'/g)].map((entry) => entry[1] as string);
};

const checkDefinition = async (constraintName: string): Promise<string> => {
  const rows = await db.execute<{ definition: string }>(
    sql`select pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conname = ${constraintName}`,
  );
  const definition = rows[0]?.definition;
  if (!definition) throw new Error(`Constraint ${constraintName} does not exist in the database.`);
  return definition;
};

/**
 * The parser itself, tested without a database.
 *
 * This block is deliberately outside the `skipIf(!databaseReachable)` guard below, because it
 * runs in milliseconds and it is what proves the other tests can actually detect the failure
 * they exist for. A guard that cannot fail is worse than no guard, because it reads as
 * coverage in a review.
 */
describe("constraint literal parser", () => {
  test("reads a plain IN list", () => {
    expect(literalsOf("CHECK (status in ('a','b'))")).toEqual(["a", "b"]);
  });

  test("reads the = ANY (ARRAY[...]) form Postgres actually stores", () => {
    expect(literalsOf("CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))")).toEqual(["a", "b"]);
  });

  test("detects the bind-parameter bug the schema tests exist to catch", () => {
    // What Drizzle generates for a CHECK written with `sql.join` instead of `sql.raw`. It
    // looks like a list of two types, it is a list of two literal strings, and the constraint
    // it produces rejects every row it was written to allow.
    const leaked = literalsOf("CHECK ((type = ANY (ARRAY['$1'::text, '$2'::text])))");

    expect(leaked).toEqual(["$1", "$2"]);
    expect(leaked).not.toEqual(expect.arrayContaining(FULFILLMENT_EXCEPTION_TYPES));
  });
});

describe.skipIf(!databaseReachable)("schema/domain agreement", () => {
  test(
    "orders_status_lifecycle_check accepts exactly the domain's ORDER_STATUSES",
    async () => {
      const definition = await checkDefinition("orders_status_lifecycle_check");

      // Compared as sets, not sequences: the SQL list is written for readability and the
      // domain order carries meaning about the lifecycle. Only the membership is a contract.
      expect(new Set(literalsOf(definition))).toEqual(new Set(ORDER_STATUSES));
      // A parameter leak would produce zero literals, which `toEqual` against a non-empty set
      // already catches; this states the failure mode outright so it is obvious when read.
      expect(literalsOf(definition).length).toBe(ORDER_STATUSES.length);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "exceptions_type_check accepts exactly the domain's FULFILLMENT_EXCEPTION_TYPES",
    async () => {
      const definition = await checkDefinition("exceptions_type_check");
      expect(new Set(literalsOf(definition))).toEqual(new Set(FULFILLMENT_EXCEPTION_TYPES));
      expect(literalsOf(definition).length).toBe(FULFILLMENT_EXCEPTION_TYPES.length);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "exception status and reservation status constraints match the schema constants",
    async () => {
      expect(new Set(literalsOf(await checkDefinition("exceptions_status_check")))).toEqual(new Set(FULFILLMENT_EXCEPTION_STATUSES));
      expect(new Set(literalsOf(await checkDefinition("inventory_reservations_status_check")))).toEqual(new Set(RESERVATION_STATUSES));

      // Added when the severity CHECK stopped being a hand-written literal and started being
      // built from the same list the rest of the codebase uses. That edit is exactly the shape
      // that produces the bind-parameter bug this file exists to catch -- a constraint that
      // reads correctly here and rejects every row in production -- so it is worth reading the
      // generated definition back rather than assuming.
      expect(new Set(literalsOf(await checkDefinition("exceptions_severity_check")))).toEqual(new Set(FULFILLMENT_EXCEPTION_SEVERITIES));
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "audit_events_event_type_check knows about allocation",
    async () => {
      const literals = literalsOf(await checkDefinition("audit_events_event_type_check"));

      // Both allocation events must be present. Phase 4 added them because the routing
      // repository writes an ORDER_ALLOCATED row, and a constraint that had not been extended
      // would have rejected every successful allocation.
      expect(literals).toContain("ORDER_ALLOCATED");
      expect(literals).toContain("ORDER_DEALLOCATED");
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );
});
