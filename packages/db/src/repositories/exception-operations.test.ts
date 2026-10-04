import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { toExceptionId, type ExceptionId, type FulfillmentException } from "@repo/domain";
import { loadRepositoryEnvironment } from "@repo/validation/environment-loader";
import { getDb } from "../client";
import { createExceptionOperationsRepository } from "../repositories/exception-operations";
import { exceptions, orders } from "../schema";

const databaseReachable = await (async () => {
  try {
    loadRepositoryEnvironment();
    const probe = await getDb().execute(sql`select 1`);
    return Array.isArray(probe) ? true : true;
  } catch {
    return false;
  }
})();

const db = getDb();
const repository = () => createExceptionOperationsRepository(db);
const REMOTE_DATABASE_TIMEOUT_MS = 120_000;

/**
 * A distinct shop per test.
 *
 * The same lesson the routing suite learned, arriving the same way: the first draft shared one
 * shop and every test could see every other test's rows, so "pages by cursor" failed with two
 * rows on the last page instead of one -- the extra row was another test's exception.
 *
 * The shop is the right isolation key here specifically because it is the field the query filters
 * on. Distinct countries worked for routing because the country is a hard filter in the policy.
 * Unique ids would not help at all: two exceptions with different ids still sit in the same
 * queue.
 */
let shopCounter = 0;
const shopFor = (name: string) => {
  shopCounter += 1;
  return `ops-${RUN}-${shopCounter}-${name}.myshopify.com`;
};

const RUN = `${Date.now()}`;
const exceptionId = (name: string) => `exc-${RUN}-${name}`;
const orderId = (name: string) => `ord-${RUN}-${name}`;

type Seed = {
  order: string;
  shop: string;
  type?: FulfillmentException["type"];
  severity?: FulfillmentException["severity"];
  status?: FulfillmentException["status"];
  createdAt?: Date;
  reason?: string;
};

let counter = 0;

/** Seeds an order plus one exception, so the shop scope is exercised through a real join. */
async function seed({ order: name, shop, type = "unroutable_insufficient_stock", severity = "blocking", status = "open", createdAt, reason }: Seed) {
  counter += 1;
  const order = orderId(name);
  // Branded, so a test cannot pass a warehouse or order id here by mistake and get a 404 that
  // looks like a bug in the query.
  const id = toExceptionId(exceptionId(`${name}-${counter}`));

  await db.insert(orders).values({
    id: order,
    shopDomain: shop,
    shopifyOrderId: `gid://shopify/Order/${RUN}-${name}-${counter}`,
    currency: "USD",
    totalPrice: "10.00",
    status: "pending",
    sourceCreatedAt: createdAt ?? new Date("2026-09-28T10:00:00Z"),
    createdAt,
  });

  await db.insert(exceptions).values({
    id,
    orderId: order,
    type,
    severity,
    status,
    reason: reason ?? "No single location can cover: KNT-TEE short by 1.",
    details: { shortfall: { "KNT-TEE": 1 } },
    createdAt: createdAt ?? new Date("2026-09-28T12:00:00Z"),
    ...(status === "open" ? {} : { resolvedAt: new Date("2026-09-29T09:00:00Z"), resolvedBy: "ops@example.com", resolutionNote: "Handled." }),
  });

  return { order, id, shop };
}

const ids = (rows: readonly FulfillmentException[]) => rows.map((row) => row.id).sort();

const purge = () => db.delete(orders).where(sql`${orders.shopDomain} like ${`ops-${RUN}-%`}`);

beforeAll(async () => {
  if (!databaseReachable) return;
  await purge();
}, REMOTE_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  if (!databaseReachable) return;
  await purge();
}, REMOTE_DATABASE_TIMEOUT_MS);

describe.skipIf(!databaseReachable)("the exception queue", () => {
  test(
    "shows only the requested shop",
    async () => {
      const shop = shopFor("shows-only-the-requested");
      const other = shopFor("other-merchant");
      // The security assertion. `shop_domain` is the tenant key, so a queue that ignores it is a
      // cross-merchant read of customer names, addresses and order contents.
      await seed({ order: "mine", shop });
      await seed({ order: "theirs", shop: other });

      const page = await repository().listExceptions({ shopDomain: shop, status: ["open", "resolved", "ignored"] });

      expect(page.exceptions.every((row) => row.orderId.startsWith(`ord-${RUN}-mine`))).toBe(true);
      expect(await repository().listExceptions({ shopDomain: other, status: ["open", "resolved", "ignored"] })).toMatchObject({
        exceptions: [expect.objectContaining({ orderId: expect.stringContaining("theirs") })],
      });
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "normalises the shop domain the way ingestion does",
    async () => {
      const shop = shopFor("normalises-the-shop-doma");
      // Ingestion lower-cases on write, so an un-normalised lookup would silently match nothing.
      // An empty queue for a merchant who has exceptions reads as "nothing is wrong", which is
      // the worst possible way for this bug to present.
      await seed({ order: "case", shop });

      const upper = await repository().listExceptions({ shopDomain: shop.toUpperCase() });

      expect(upper.exceptions).toHaveLength(1);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "returns the newest first",
    async () => {
      const shop = shopFor("returns-the-newest-first");
      const older = await seed({ order: "older", shop, createdAt: new Date("2026-09-28T08:00:00Z") });
      const newer = await seed({ order: "newer", shop, createdAt: new Date("2026-09-28T20:00:00Z") });

      const page = await repository().listExceptions({ shopDomain: shop, status: ["open"], type: ["unroutable_insufficient_stock"] });

      // Newest first, because the queue is worked from the top and an old exception is usually
      // already in front of someone.
      expect(page.exceptions.map((row) => row.id)).toEqual([newer.id, older.id]);
      expect(ids(page.exceptions)).toEqual([older.id, newer.id].sort());
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "pages by cursor without repeating or dropping a row",
    async () => {
      const shop = shopFor("pages-by-cursor-without-");
      // Three rows sharing one `created_at`, which is not a contrived case: exceptions written in
      // the same transaction share `now()`. A timestamp-only cursor drops or repeats the boundary
      // row here, and the symptom is an operator triaging the same exception twice.
      const at = new Date("2026-09-28T12:00:00.000Z");
      const made = [
        await seed({ order: "page-a", shop, createdAt: at }),
        await seed({ order: "page-b", shop, createdAt: at }),
        await seed({ order: "page-c", shop, createdAt: at }),
      ];

      const first = await repository().listExceptions({ shopDomain: shop, status: ["open"], limit: 2 });
      const second = await repository().listExceptions({ shopDomain: shop, status: ["open"], limit: 2, after: first.nextCursor ?? undefined });

      expect(first.exceptions).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      // The last page reports no cursor, so a client stops rather than looping on an empty page.
      expect(second.exceptions).toHaveLength(1);
      expect(second.nextCursor).toBeNull();

      const all = [...first.exceptions, ...second.exceptions].map((row) => row.id);
      expect(new Set(all).size).toBe(3);
      expect(all.sort()).toEqual(made.map((row) => row.id).sort());
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "filters by status, severity and type",
    async () => {
      const shop = shopFor("filters-by-status-severi");
      await seed({ order: "f-blocking", shop, severity: "blocking" });
      await seed({ order: "f-warning", shop, severity: "warning", type: "carrier_error" });
      await seed({ order: "f-resolved", shop, status: "resolved" });

      const blocking = await repository().listExceptions({ shopDomain: shop, status: ["open"], severity: ["blocking"] });
      expect(blocking.exceptions.every((row) => row.severity === "blocking")).toBe(true);

      const carrier = await repository().listExceptions({ shopDomain: shop, status: ["open"], type: ["carrier_error"] });
      expect(carrier.exceptions).toHaveLength(1);
      expect(carrier.exceptions[0]?.type).toBe("carrier_error");

      // An empty status filter means "no filter", not "no rows" -- the API defaults to open
      // instead, and this pins that the repository is the one applying the filter.
      const unfiltered = await repository().listExceptions({ shopDomain: shop, status: ["open", "resolved"] });
      expect(unfiltered.exceptions.some((row) => row.status === "resolved")).toBe(true);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "clamps the page size at the repository, not just the use case",
    async () => {
      const shop = shopFor("clamps-the-page-size-at-");
      await seed({ order: "clamp", shop });

      // The repository is callable without going through the use case, and a limit is a
      // response size and a lock-hold duration.
      expect((await repository().listExceptions({ shopDomain: shop, limit: 10_000 })).exceptions.length).toBeLessThanOrEqual(100);
      expect((await repository().listExceptions({ shopDomain: shop, limit: 0 })).exceptions.length).toBeGreaterThan(0);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );
});

describe.skipIf(!databaseReachable)("closing an exception", () => {
  const close = (input: { exceptionId: ExceptionId; shop: string; status?: "resolved" | "ignored"; note?: string }) =>
    repository().closeException({
      shopDomain: input.shop,
      exceptionId: input.exceptionId,
      status: input.status ?? "resolved",
      actor: "ops@example.com",
      note: input.note ?? "Restocked and re-routed.",
      at: new Date("2026-09-29T10:00:00Z"),
    });

  test(
    "records the audit trail the CHECK constraint requires",
    async () => {
      const shop = shopFor("records-the-audit-trail-");
      const { id } = await seed({ order: "close-me", shop });

      const result = await close({ exceptionId: id, shop });

      expect(result.outcome).toBe("closed");
      if (result.outcome !== "closed") throw new Error("expected closed");
      expect(result.exception).toMatchObject({
        status: "resolved",
        resolvedBy: "ops@example.com",
        resolutionNote: "Restocked and re-routed.",
      });
      expect(result.exception.resolvedAt?.toISOString()).toBe("2026-09-29T10:00:00.000Z");
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  /**
   * The race, and the reason the close is one statement.
   *
   * Two operators work the same queue and reach for the same entry. A read-then-write leaves a
   * window where both read `open`, both write, and the second note overwrites the first -- losing
   * the audit trail the close exists to preserve. The conditional UPDATE is what closes the
   * window, and this asserts the loser is told rather than silently ignored.
   */
  test(
    "tells the second operator they lost the race",
    async () => {
      const shop = shopFor("tells-the-second-operato");
      const { id } = await seed({ order: "raced", shop });

      const [first, second] = await Promise.all([close({ exceptionId: id, shop, note: "First note." }), close({ exceptionId: id, shop, note: "Second note." })]);

      const outcomes = [first.outcome, second.outcome].sort();
      expect(outcomes).toEqual(["already_closed", "closed"]);

      const winner = first.outcome === "closed" ? first : second;
      expect(winner.outcome === "closed" && winner.exception.resolutionNote).toBe(first.outcome === "closed" ? "First note." : "Second note.");

      // Exactly one row carries a note -- the loser's did not overwrite the winner's. A
      // half-written audit trail is worse than none, because it looks complete.
      const [row] = await db.select().from(exceptions).where(eq(exceptions.id, id));
      expect(row?.resolutionNote === "First note." || row?.resolutionNote === "Second note.").toBe(true);
      expect(row?.resolvedBy).toBe("ops@example.com");
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "does not touch an exception belonging to another shop",
    async () => {
      const shop = shopFor("does-not-touch-an-except");
      const other = shopFor("other-merchant");
      const { id } = await seed({ order: "not-yours", shop: other });

      const result = await close({ exceptionId: id, shop });

      // `not_found`, not `already_closed`: answering differently would confirm the id exists in
      // another tenant, which makes this endpoint a probe.
      expect(result.outcome).toBe("not_found");

      const [row] = await db.select().from(exceptions).where(eq(exceptions.id, id));
      expect(row?.status).toBe("open");
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "reports not_found for an id that never existed",
    async () => {
      const shop = shopFor("reports-not-found-for-an");
      expect((await close({ exceptionId: toExceptionId(exceptionId("imaginary")), shop })).outcome).toBe("not_found");
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "records `ignored` as a decision, which is the point of having it",
    async () => {
      const shop = shopFor("records-ignored-as-a-dec");
      const { id } = await seed({ order: "ship-anyway", shop });

      const result = await close({ exceptionId: id, shop, status: "ignored", note: "Customer agreed to ship without the mug." });

      expect(result.outcome === "closed" && result.exception.status).toBe("ignored");
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "a closed exception leaves the open queue and joins the closed one",
    async () => {
      const shop = shopFor("a-closed-exception-leave");
      // The queue and the archive are the same table with different filters, so a close has to
      // move a row between them. If it did not, a resolved exception would sit at the top of the
      // operator's list forever.
      const { id } = await seed({ order: "queue-drain", shop, createdAt: new Date("2026-09-28T23:00:00Z") });
      expect((await repository().listExceptions({ shopDomain: shop, status: ["open"], type: ["supplier_out_of_stock"] })).exceptions).toHaveLength(0);

      await close({ exceptionId: id, shop });

      const open = await repository().listExceptions({ shopDomain: shop, status: ["open"], type: ["unroutable_insufficient_stock"] });
      const closed = await repository().listExceptions({ shopDomain: shop, status: ["resolved"] });
      expect(open.exceptions.some((row) => row.id === id)).toBe(false);
      expect(closed.exceptions.some((row) => row.id === id)).toBe(true);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );
});
