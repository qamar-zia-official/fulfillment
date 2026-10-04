import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";
import { toWarehouseId } from "@repo/domain";
import { loadRepositoryEnvironment } from "@repo/validation/environment-loader";
import { getDb } from "../client";
import { createOrderRoutingRepository } from "../repositories/order-routing";
import { auditEvents, exceptions, inventory, inventoryReservations, orderItems, orders, warehouseRoutes, warehouses } from "../schema";

loadRepositoryEnvironment();

/**
 * Routing tests against a real Postgres, including the concurrency proof.
 *
 * The behaviour worth protecting is not the policy -- `@repo/domain` tests that exhaustively,
 * and it is pure, so a fake would serve fine. What cannot be faked is the interaction between
 * the policy and the database: row locks, the conditional decrement, transaction rollback on a
 * partial basket, and the partial unique index that makes re-routing idempotent. Every one of
 * those is a claim about Postgres, and a mocked repository asserts nothing about any of them.
 */

const REMOTE_DATABASE_TIMEOUT_MS = 60_000;
const runIntegration = process.env.SKIP_DB_INTEGRATION !== "1";

/**
 * Run-scoped ids.
 *
 * The partial unique index on active reservations, and the unique index on
 * (warehouse, sku), both mean a leftover row from an interrupted run would make a later run's
 * "first" assertion fail in a way that looks like a concurrency bug. Scoping every id to this
 * run makes each run independent of whatever the last one left behind.
 *
 * Ids alone are NOT enough, and the first draft of this file got that wrong in a way worth
 * recording. Every test seeded a US-serving warehouse, so all of them were live candidates for
 * every other test's order: the "inactive warehouse is ignored" test was allocated by a
 * warehouse that an earlier test had created, and the "does not split" test was allocated by
 * one that had not stocked its second SKU. Unique ids do not prevent this, because ids are not
 * what routing filters on.
 *
 * The isolation that actually works is a distinct destination country per test, because the
 * country is a hard filter in the policy and a real ISO code per test. Each test's sites are
 * unreachable from every other test's order, so no test can observe another's stock.
 */
const RUN = `${Date.now()}`;
const warehouseId = (name: string) => `wh-${RUN}-${name}`;
const orderId = (name: string) => `ord-${RUN}-${name}`;
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

type OrderOptions = {
  country?: string | null;
  items?: { sku: string | null; quantity: number; requiresShipping?: boolean }[];
  status?: string;
  isTestOrder?: boolean;
  address?: { name?: string | null; line1?: string | null; city?: string | null };
};

/**
 * Creates an order plus items directly.
 *
 * Going through the ingestion repository instead would couple routing tests to webhook
 * plumbing, and a failure would then not tell us which layer broke. The one thing that
 * matters for realism -- a cancelled order carrying a cancellation timestamp -- is set
 * explicitly so the CHECK constraints still apply to these fixtures.
 */
async function seedOrder(name: string, options: OrderOptions = {}) {
  const id = orderId(name);
  const items = options.items ?? [{ sku: "KNT-TEE", quantity: 1 }];
  const cancelled = options.status === "cancelled";

  await db.insert(orders).values({
    id,
    shopDomain: `routing-test-${RUN}.myshopify.com`,
    shopifyOrderId: `gid://shopify/Order/${RUN}-${name}`,
    currency: "USD",
    totalPrice: "100.00",
    status: options.status ?? "pending",
    isTestOrder: options.isTestOrder ?? false,
    shippingName: options.address?.name ?? "Ada Lovelace",
    shippingAddressLine1: options.address?.line1 ?? "1 Main St",
    shippingCity: options.address?.city ?? "Austin",
    shippingProvince: "TX",
    shippingPostalCode: "78701",
    shippingCountryCode: options.country === undefined ? "US" : options.country,
    cancelledAt: cancelled ? new Date("2026-09-28T11:00:00Z") : null,
    sourceCreatedAt: new Date("2026-09-28T10:00:00Z"),
  });

  await db.insert(orderItems).values(
    items.map((item, index) => ({
      id: crypto.randomUUID(),
      orderId: id,
      shopifyLineItemId: `${RUN}-${name}-${index}`,
      sku: item.sku,
      title: `Item ${index}`,
      quantity: item.quantity,
      fulfillableQuantity: item.quantity,
      unitPrice: "50.00",
      requiresShipping: item.requiresShipping ?? true,
    })),
  );

  return id;
}

async function seedWarehouse(name: string, options: { country: string; priority: number; isActive?: boolean; stock?: Record<string, [number, number]> }) {
  const id = warehouseId(name);
  await db.insert(warehouses).values({ id, name, countryCode: "US", isActive: options.isActive ?? true });
  await db.insert(warehouseRoutes).values({ warehouseId: id, countryCode: options.country, priority: options.priority });
  await db.insert(inventory).values(
    Object.entries(options.stock ?? {}).map(([sku, [onHand, reserved]]) => ({ id: crypto.randomUUID(), warehouseId: id, sku, onHand, reserved })),
  );
  return id;
}

const stockOf = async (warehouse: string, sku: string) => {
  const [row] = await db.select().from(inventory).where(sql`${inventory.warehouseId} = ${warehouse} and ${inventory.sku} = ${sku}`);
  return row;
};

const exceptionsFor = (order: string) => db.select().from(exceptions).where(eq(exceptions.orderId, order));

const reservationsFor = (order: string) =>
  db.select().from(inventoryReservations).where(and(eq(inventoryReservations.orderId, order), eq(inventoryReservations.status, "active")));

const rowFor = (id: string) => db.select().from(orders).where(eq(orders.id, id)).then((rows) => rows[0]);

/**
 * Deletes every row this file's *fixture scheme* could have left behind, from this run or any
 * earlier one.
 *
 * The pattern is the fixture id shape, `wh-<13 digits>-<slug>`, which is deliberately narrower
 * than `wh-%`: a hand-created warehouse is called `wh-ams` or `wh-manual`, so the timestamp
 * cannot match one and this cannot quietly delete a row someone made on purpose.
 *
 * The 13-digit run token is there because a partial unique index on active reservations and a
 * unique index on `(warehouse, sku)` both mean a leftover row makes a later "first" assertion
 * fail in a way that reads as a concurrency bug. Run-scoped ids already prevent that for
 * *ids*, which is the case the comment above this block originally covered.
 *
 * What they do not prevent is a dead run's warehouse still being a live routing candidate for
 * the next run. Isolation here rests on a distinct destination country per test, and a country
 * is a real ISO code -- so a warehouse left behind by a run that was interrupted before its
 * `afterAll` serves the same country as this run's fixtures and competes for the same orders.
 * That is not hypothetical: it is how "an allocated order leaves the queue" failed here, with
 * the assertion naming a `queue-drain` warehouse from a previous run.
 *
 * So this runs before the suite as well as after it. Reclaiming first makes each run start
 * from a known state, which is what the run-scoped ids were supposed to guarantee.
 */
const reclaimFixtures = async () => {
  // FK order: reservations and exceptions cascade from orders; inventory references
  // warehouses with ON DELETE RESTRICT, so warehouses cannot go until the stock rows do.
  await db.delete(orders).where(sql`${orders.shopDomain} like ${"routing-test-%"}`);
  await db.delete(warehouseRoutes).where(sql`${warehouseRoutes.warehouseId} ~ ${"^wh-[0-9]{13}-"}`);
  await db.delete(inventory).where(sql`${inventory.warehouseId} ~ ${"^wh-[0-9]{13}-"}`);
  await db.delete(warehouses).where(sql`${warehouses.id} ~ ${"^wh-[0-9]{13}-"}`);
};

beforeAll(async () => {
  if (!databaseReachable) return;
  await reclaimFixtures();
}, REMOTE_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  if (!databaseReachable) return;
  await reclaimFixtures();
}, REMOTE_DATABASE_TIMEOUT_MS);

describe.skipIf(!databaseReachable)("order routing", () => {
  test(
    "reserves the whole basket at the highest-priority site and marks the order allocated",
    async () => {
      const site = await seedWarehouse("primary", { country: "US", priority: 1, stock: { "KNT-TEE": [10, 0], "KNT-MUG": [4, 0] } });
      const order = await seedOrder("happy", { country: "US", items: [{ sku: "KNT-TEE", quantity: 2 }, { sku: "KNT-MUG", quantity: 1 }] });

      const outcome = await createOrderRoutingRepository(db).routeOrder({ orderId: order });

      expect(outcome.outcome).toBe("allocated");
      if (outcome.outcome !== "allocated") throw new Error("expected allocation");
      expect(outcome.warehouseId).toBe(toWarehouseId(site));
      // Normalised before comparing, because the returned map iterates in basket order (the
      // order's line-item order) while the assertion is written sorted. The order of a Map's
      // entries is not part of what routing promises, so pinning it would make this test fail
      // for a change that is not a defect.
      expect([...outcome.reserved].map(([sku, quantity]) => [String(sku), quantity]).sort()).toEqual([
        ["KNT-MUG", 1],
        ["KNT-TEE", 2],
      ]);

      // Reserved counts moved, on-hand did not. This is the distinction between "held" and
      // "shipped", and conflating them is what makes a stock count impossible.
      expect(await stockOf(site, "KNT-TEE")).toMatchObject({ onHand: 10, reserved: 2 });
      expect(await stockOf(site, "KNT-MUG")).toMatchObject({ onHand: 4, reserved: 1 });
      expect(await rowFor(order)).toMatchObject({ status: "allocated", allocatedWarehouseId: site });

      const reservations = await reservationsFor(order);
      expect(reservations).toHaveLength(2);
      expect(reservations.every((row) => row.warehouseId === site && row.status === "active")).toBe(true);

      const audit = await db.select().from(auditEvents).where(sql`${auditEvents.entityId} = ${order} and ${auditEvents.eventType} = 'ORDER_ALLOCATED'`);
      expect(audit).toHaveLength(1);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "skips a site that cannot cover the basket and uses the next one down",
    async () => {
      const thin = await seedWarehouse("thin", { country: "CA", priority: 1, stock: { "KNT-TEE": [10, 0], "KNT-MUG": [0, 0] } });
      const fat = await seedWarehouse("fat", { country: "CA", priority: 2, stock: { "KNT-TEE": [10, 0], "KNT-MUG": [5, 0] } });
      const order = await seedOrder("fallback", { country: "CA", items: [{ sku: "KNT-TEE", quantity: 2 }, { sku: "KNT-MUG", quantity: 1 }] });

      const outcome = await createOrderRoutingRepository(db).routeOrder({ orderId: order });

      if (outcome.outcome !== "allocated") throw new Error(`expected allocation, got ${outcome.outcome}`);
      expect(outcome.warehouseId).toBe(toWarehouseId(fat));
      // The preferred site was evaluated and rejected, and left completely untouched.
      expect(await stockOf(thin, "KNT-MUG")).toMatchObject({ onHand: 0, reserved: 0 });
      expect(await stockOf(fat, "KNT-MUG")).toMatchObject({ onHand: 5, reserved: 1 });
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "never splits a basket across two sites, and reports the preferred site's shortfall",
    async () => {
      await seedWarehouse("half-a", { country: "GB", priority: 1, stock: { "KNT-TEE": [5, 0] } });
      await seedWarehouse("half-b", { country: "GB", priority: 2, stock: { "KNT-MUG": [5, 0] } });
      const order = await seedOrder("split", { country: "GB", items: [{ sku: "KNT-TEE", quantity: 2 }, { sku: "KNT-MUG", quantity: 1 }] });

      const outcome = await createOrderRoutingRepository(db).routeOrder({ orderId: order });

      expect(outcome.outcome).toBe("unroutable");
      if (outcome.outcome !== "unroutable") throw new Error("expected unroutable");
      expect(outcome.exception.type).toBe("unroutable_insufficient_stock");
      expect(outcome.exception.details.shortfall).toEqual({ "KNT-MUG": 1 });

      // Nothing was reserved anywhere, and the order is still pending and re-routable.
      expect(await reservationsFor(order)).toHaveLength(0);
      expect(await rowFor(order)).toMatchObject({ status: "pending", allocatedWarehouseId: null });
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  /**
   * The test that keeps the operations queue usable.
   *
   * An unroutable order stays `pending` on purpose -- that is what makes a restock self-heal on
   * the next pass -- and the worker runs every five minutes. So without a guard this code path
   * executes 288 times a day for a single never-restocked order, writing 288 identical queue
   * entries and burying every other problem the operator has. The assertion is on the *count*,
   * not on the content, because the count is the whole defect.
   */
  test(
    "re-evaluating an unroutable order adds to the queue rather than multiplying it",
    async () => {
      await seedWarehouse("dedupe", { country: "NO", priority: 1, stock: { "KNT-TEE": [0, 0] } });
      const order = await seedOrder("dedupe", { country: "NO" });
      const repository = createOrderRoutingRepository(db);

      const first = await repository.routeOrder({ orderId: order });
      const second = await repository.routeOrder({ orderId: order });
      const third = await repository.routeOrder({ orderId: order });

      // Each pass still reports the problem -- the outcome is not laundered into a success just
      // because the queue already knows about it -- and each hands back the id of the exception
      // that actually exists. Returning the freshly-built one would report an id the caller
      // cannot look up, and the difference is invisible until someone follows the link.
      const seen = new Set<string>();
      const raisedAt = new Set<string>();
      for (const outcome of [first, second, third]) {
        if (outcome.outcome !== "unroutable") throw new Error("expected unroutable");
        // A warehouse for NO exists but has no stock, so the decision is a shortfall rather
        // than a missing site. Either way the order stays pending and this loop runs again.
        expect(outcome.exception.type).toBe("unroutable_insufficient_stock");
        seen.add(outcome.exception.id);
        raisedAt.add(outcome.exception.createdAt.toISOString());
      }

      expect(await exceptionsFor(order)).toHaveLength(1);
      expect([...seen]).toHaveLength(1);
      // The original discovery time survives, so the queue shows how long this has been broken
      // rather than restamping it on every pass and making a three-day-old problem look new.
      expect([...raisedAt]).toHaveLength(1);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "a closed exception does not block a genuinely new one for the same order",
    async () => {
      // The unique index is partial on `status = 'open'` for a reason: an operator closing an
      // exception and the problem coming back is the truth, not a constraint violation. If this
      // test needs a blanket unique index instead, that is the design regressing.
      await seedWarehouse("reopen", { country: "FI", priority: 1, stock: { "KNT-TEE": [0, 0] } });
      const order = await seedOrder("reopen", { country: "FI" });
      const repository = createOrderRoutingRepository(db);

      const first = await repository.routeOrder({ orderId: order });
      if (first.outcome !== "unroutable") throw new Error("expected unroutable");

      await db
        .update(exceptions)
        .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: "ops@example.com", resolutionNote: "Restocked, retrying." })
        .where(eq(exceptions.orderId, order));

      const later = await repository.routeOrder({ orderId: order });
      if (later.outcome !== "unroutable") throw new Error("expected unroutable");

      // Two rows survive and only one is open. The history reads "happened, handled, happened
      // again" instead of raising a constraint error, and the queue still has exactly one entry
      // -- which is the property the partial index exists to protect.
      const rows = await exceptionsFor(order);
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.status === "open")).toHaveLength(1);
      expect(later.exception.id).not.toBe(first.exception.id);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "raises an exception and reserves nothing when no site serves the destination country",
    async () => {
      // The site serves JP; the order goes to DE. No test seeds DE sites, so this failure is
      // genuinely "no site serves this country" and not a shortfall from a neighbour.
      await seedWarehouse("domestic-only", { country: "JP", priority: 1, stock: { "KNT-TEE": [50, 0] } });
      const order = await seedOrder("wrong-country", { country: "DE" });

      const outcome = await createOrderRoutingRepository(db).routeOrder({ orderId: order });

      if (outcome.outcome !== "unroutable") throw new Error("expected unroutable");
      expect(outcome.exception.type).toBe("unroutable_no_warehouse");
      expect(outcome.exception.reason).toContain("DE");

      const raised = await exceptionsFor(order);
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({ status: "open", severity: "blocking" });
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "raises an address exception without touching stock when the order has a missing SKU",
    async () => {
      const site = await seedWarehouse("for-missing-sku", { country: "FR", priority: 1, stock: { "KNT-TEE": [50, 0] } });
      // The Phase 2 behaviour rejected this order at ingestion. Phase 4 stores it, so the
      // revenue is visible and the specific line is named for a human to fix.
      const order = await seedOrder("no-sku", { country: "FR", items: [{ sku: "KNT-TEE", quantity: 1 }, { sku: null, quantity: 1 }] });

      const outcome = await createOrderRoutingRepository(db).routeOrder({ orderId: order });

      if (outcome.outcome !== "unroutable") throw new Error("expected unroutable");
      expect(outcome.exception.type).toBe("unroutable_no_warehouse");
      expect(outcome.exception.reason).toContain("no SKU");

      // Plentiful stock, and still not reserved: an order that cannot ship must not hold
      // stock hostage while it waits for a human.
      expect(await stockOf(site, "KNT-TEE")).toMatchObject({ onHand: 50, reserved: 0 });
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "does not treat a digital line with no sku as a data-quality problem",
    async () => {
      // The real path, not just the domain unit test. A gift card has no SKU and never will,
      // and the repository has to carry `requires_shipping` into the aggregate for
      // `problems()` to make that distinction. Without it the order is unroutable and a
      // blocking exception is filed for a catalogue entry that was never wrong.
      const site = await seedWarehouse("for-digital", { country: "IT", priority: 1, stock: { "KNT-TEE": [5, 0] } });
      const order = await seedOrder("digital", {
        country: "IT",
        items: [
          { sku: "KNT-TEE", quantity: 1 },
          { sku: null, quantity: 1, requiresShipping: false },
        ],
      });

      const outcome = await createOrderRoutingRepository(db).routeOrder({ orderId: order });

      if (outcome.outcome !== "allocated") throw new Error(`expected allocation, got ${outcome.outcome}`);
      expect(outcome.warehouseId).toBe(toWarehouseId(site));
      // Only the physical line is reserved. A digital line must not put a phantom SKU against
      // inventory.
      expect([...outcome.reserved].map(([sku, quantity]) => [String(sku), quantity])).toEqual([["KNT-TEE", 1]]);
      expect(await exceptionsFor(order)).toHaveLength(0);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "is idempotent: re-routing an allocated order reserves nothing a second time",
    async () => {
      const site = await seedWarehouse("idempotent", { country: "AU", priority: 1, stock: { "KNT-TEE": [5, 0] } });
      const order = await seedOrder("retry", { country: "AU", items: [{ sku: "KNT-TEE", quantity: 2 }] });
      const repository = createOrderRoutingRepository(db);

      const first = await repository.routeOrder({ orderId: order });
      const second = await repository.routeOrder({ orderId: order });

      if (first.outcome !== "allocated") throw new Error("expected first allocation");
      if (second.outcome !== "allocated") throw new Error("expected idempotent allocation");
      expect(second.warehouseId).toBe(toWarehouseId(site));
      expect(second.reserved).toEqual(first.reserved);
      expect(await stockOf(site, "KNT-TEE")).toMatchObject({ onHand: 5, reserved: 2 });
      expect(await reservationsFor(order)).toHaveLength(1);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "does not treat a cancelled order as unroutable, because nobody needs to fix it",
    async () => {
      await seedWarehouse("for-cancelled", { country: "NZ", priority: 1, stock: { "KNT-TEE": [5, 0] } });
      const order = await seedOrder("cancelled", { country: "NZ", status: "cancelled" });

      const outcome = await createOrderRoutingRepository(db).routeOrder({ orderId: order });

      // An exception here would fill the operator queue with "no warehouse" rows for orders
      // that are on purpose not shipping.
      expect(outcome.outcome).toBe("not_routable");
      expect(await exceptionsFor(order)).toHaveLength(0);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "ignores an inactive warehouse even when it is the only site with the stock",
    async () => {
      const site = await seedWarehouse("deactivated", { country: "IE", priority: 1, isActive: false, stock: { "KNT-TEE": [50, 0] } });
      const order = await seedOrder("closed-site", { country: "IE", items: [{ sku: "KNT-TEE", quantity: 1 }] });

      const outcome = await createOrderRoutingRepository(db).routeOrder({ orderId: order });

      if (outcome.outcome !== "unroutable") throw new Error("expected unroutable");
      expect(outcome.exception.type).toBe("unroutable_no_warehouse");
      expect(await stockOf(site, "KNT-TEE")).toMatchObject({ onHand: 50, reserved: 0 });
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "leaves no partial reservation when a later SKU in the basket cannot be covered",
    async () => {
      // The first SKU in iteration order is plentiful, the second is not. If the increments
      // were not in one transaction, the first would be committed and the order would hold
      // stock it can never ship.
      const site = await seedWarehouse("partial-rollback", { country: "NL", priority: 1, stock: { "AAA-TEE": [10, 0], "ZZZ-MUG": [0, 0] } });
      const order = await seedOrder("rollback", {
        country: "NL",
        items: [
          { sku: "AAA-TEE", quantity: 1 },
          { sku: "ZZZ-MUG", quantity: 1 },
        ],
      });

      const outcome = await createOrderRoutingRepository(db).routeOrder({ orderId: order });

      if (outcome.outcome !== "unroutable") throw new Error("expected unroutable");
      // The policy already rejects this before any write (best-ranked site lacks ZZZ-MUG), so
      // this asserts the decision, and the counter check below asserts no write happened.
      expect(await stockOf(site, "AAA-TEE")).toMatchObject({ onHand: 10, reserved: 0 });
      expect(await reservationsFor(order)).toHaveLength(0);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  describe("the routable queue", () => {
    test("lists only pending, non-test orders, oldest first", async () => {
      // The predicate must match `orders_routable_idx` exactly, or the worker either re-routes
      // work that is already done or skips work that is not.
      const routable = await seedOrder("queue-a", { country: "AT" });
      const alsoRoutable = await seedOrder("queue-b", { country: "AT" });
      await seedOrder("queue-cancelled", { country: "AT", status: "cancelled" });
      await seedOrder("queue-test", { country: "AT", isTestOrder: true });

      const repository = createOrderRoutingRepository(db);
      const listed = await repository.listRoutableOrderIds(500);

      // Both routable ids are present. Their relative order is not asserted here because every
      // fixture in this file shares one `source_created_at`, so `created_at` ties and the
      // secondary sort on id decides -- which is covered by the ordering test below.
      expect(listed).toContain(routable);
      expect(listed).toContain(alsoRoutable);
      expect(listed).not.toContain(orderId("queue-cancelled"));
      expect(listed).not.toContain(orderId("queue-test"));
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

    test("stops at the limit, oldest first", async () => {
      // Oldest-first matters under backlog: an order that arrived during an outage should route
      // before a newer one, or the queue grows without bound while the shop keeps taking orders.
      for (let index = 0; index < 3; index += 1) {
        await seedOrder(`page-${index}`, { country: "BE" });
      }

      const repository = createOrderRoutingRepository(db);
      const firstPage = await repository.listRoutableOrderIds(2);

      expect(firstPage).toHaveLength(2);
      // The ids sort lexicographically by construction, so ascending order here is ascending
      // `created_at`-then-id order, which is the documented contract.
      expect([...firstPage].sort()).toEqual([...firstPage]);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

    test("clamps an absurd limit rather than honouring it", async () => {
      // Batch size is a lock-hold duration, not a preference. A caller asking for a million
      // would take row locks across the whole queue and turn a routine backfill into an outage,
      // so the ceiling is enforced here rather than trusted.
      const repository = createOrderRoutingRepository(db);

      // No exception, and a small result: the point is that it does not attempt the ask.
      expect((await repository.listRoutableOrderIds(1_000_000)).length).toBeLessThan(200);
      // A nonsense limit yields at least one row rather than none, so a bad caller still makes
      // progress instead of silently stalling the worker forever.
      expect((await repository.listRoutableOrderIds(0)).length).toBeGreaterThan(0);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

    test("an allocated order leaves the queue", async () => {
      // The queue is the worker's only input. If an order stayed listed after being allocated,
      // every pass would re-route it forever -- safe, because routing is idempotent, but pure
      // load with no benefit.
      const site = await seedWarehouse("queue-drain", { country: "SE", priority: 1, stock: { "KNT-TEE": [10, 0] } });
      const order = await seedOrder("queue-drained", { country: "SE", items: [{ sku: "KNT-TEE", quantity: 1 }] });
      const repository = createOrderRoutingRepository(db);

      expect(await repository.listRoutableOrderIds(500)).toContain(order);

      const outcome = await repository.routeOrder({ orderId: order });
      if (outcome.outcome !== "allocated") throw new Error("expected allocation");
      expect(outcome.warehouseId).toBe(toWarehouseId(site));

      expect(await repository.listRoutableOrderIds(500)).not.toContain(order);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );
  });

  /**
   * The test that justifies the whole locking design.
   *
   * Ten orders each want 1 unit of a SKU that has 3. They are routed in parallel from ten
   * separate connections, so the reads genuinely interleave in Postgres rather than being
   * serialised by a single-threaded test. Exactly 3 must succeed.
   *
   * The failure mode this guards against is specific and quiet: without the `FOR UPDATE`
   * lock, all ten transactions can read `reserved = 0`, all ten compute the same decision
   * from the same snapshot, and all ten commit. The CHECK constraint catches the ones that
   * would make `reserved > on_hand`, but the visible symptom is a scattering of
   * `InventoryInvariantError`s and aborted transactions rather than an oversell -- so
   * asserting only "no oversell" would pass even with a badly broken implementation.
   * Asserting "exactly 3 succeed" is what pins the actual guarantee.
   */
  test(
    "never oversells: ten parallel orders competing for three units produce exactly three allocations",
    async () => {
      const site = await seedWarehouse("contended", { country: "ES", priority: 1, stock: { "KNT-SCARCE": [3, 0] } });
      const orders = await Promise.all(
        Array.from({ length: 10 }, (_, index) => seedOrder(`race-${index}`, { country: "ES", items: [{ sku: "KNT-SCARCE", quantity: 1 }] })),
      );

      const repository = createOrderRoutingRepository(db);
      const outcomes = await Promise.all(orders.map(async (id) => {
        try {
          return await repository.routeOrder({ orderId: id });
        } catch (error) {
          // Serialization failures and lock timeouts are legitimate outcomes under
          // contention and must not be mistaken for overselling, so they are recorded and
          // checked below rather than allowed to fail the test directly.
          return { outcome: "threw" as const, error };
        }
      }));

      const allocated = outcomes.filter((outcome) => outcome.outcome === "allocated");
      const unroutable = outcomes.filter((outcome) => outcome.outcome === "unroutable");
      const threw = outcomes.filter((outcome) => outcome.outcome === "threw");

      expect(threw).toEqual([]);
      expect(allocated).toHaveLength(3);
      expect(unroutable).toHaveLength(7);

      // The invariant that matters, stated directly against the row.
      expect(await stockOf(site, "KNT-SCARCE")).toMatchObject({ onHand: 3, reserved: 3 });
      // Availability is now exactly zero, not negative and not over-reserved.
      const [stock] = [await stockOf(site, "KNT-SCARCE")];
      if (!stock) throw new Error("inventory row missing");
      expect(stock.onHand - stock.reserved).toBe(0);

      // Every success is backed by a real reservation row and a real order transition.
      const allocations = await db
        .select()
        .from(inventoryReservations)
        .where(eq(inventoryReservations.sku, "KNT-SCARCE"));
      const forThisRun = allocations.filter((row) => orders.includes(row.orderId));
      expect(forThisRun).toHaveLength(3);
      expect(forThisRun.every((row) => row.status === "active" && row.quantity === 1)).toBe(true);

      const stillPending = await Promise.all(orders.map((id) => rowFor(id)));
      expect(stillPending.filter((row) => row?.status === "allocated")).toHaveLength(3);
    },
    120_000,
  );
});
