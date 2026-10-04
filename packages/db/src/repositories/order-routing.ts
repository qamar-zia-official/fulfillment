import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  Money,
  Order,
  PersistenceError,
  StockLevel,
  ValidationFailedError,
  selectWarehouse,
  toCountryCode,
  toCurrency,
  toOrderId,
  toShopDomain,
  toSku,
  toWarehouseId,
  type OrderStatus,
  type Sku,
} from "@repo/domain";
import {
  buildRoutableBasket,
  toRoutingException,
  toWarehouseCandidate,
  type OrderRoutingRepository,
  type RoutableOrder,
  type RoutingOutcome,
} from "@repo/application";
import type { Database } from "../client";
import { toFulfillmentException } from "../rows";
import { auditEvents, exceptions, inventory, inventoryReservations, orderItems, orders, warehouseRoutes, warehouses } from "../schema";

/**
 * Raised when a stock decrement reports that it changed no rows *after* the rows were locked.
 *
 * This is not a "someone beat us to it" signal and must not be retried as one. Every candidate
 * inventory row is locked with `FOR UPDATE` before the routing decision is made, so the
 * decision was computed from data no other transaction can be modifying. A conditional update
 * matching zero rows therefore means the database state contradicts a decision that was just
 * taken against it -- a genuine invariant violation. Swallowing it into a retry would hide a
 * bug behind a livelock.
 */
class InventoryInvariantError extends Error {}

/**
 * Hard ceiling on a single batch, independent of what the caller asks for.
 *
 * Routing takes row locks on every candidate inventory row for an order's basket, so batch size
 * is a lock-hold duration. A caller that could ask for an unbounded batch could take row locks
 * across the whole queue and turn a routine backfill into an outage.
 */
const MAX_ROUTING_BATCH_SIZE = 200;

export function createOrderRoutingRepository(db: Database): OrderRoutingRepository {
  return {
    /**
     * The queue the routing worker drains.
     *
     * Oldest first, and only genuinely routable orders: `pending`, and not a test order. The
     * predicate is written to match `orders_routable_idx` exactly, so this is an index-only
     * scan of a partial index rather than a filter over the whole table -- which matters once
     * the table holds years of delivered and cancelled orders and only a handful are pending.
     *
     * The limit is clamped rather than trusted. A caller passing `limit: 100000` would not
     * corrupt anything, but it would hold a very large number of row locks for the length of
     * the batch, and the batch size is a reliability parameter, not a preference.
     */
    async listRoutableOrderIds(limit) {
      const bounded = Math.max(1, Math.min(Math.trunc(limit), MAX_ROUTING_BATCH_SIZE));

      const rows = await db
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.status, "pending"), eq(orders.isTestOrder, false)))
        .orderBy(asc(orders.createdAt), asc(orders.id))
        .limit(bounded);

      return rows.map((row) => row.id);
    },

    /**
     * Phase 4: choose a warehouse and commit the choice, or record why there isn't one.
     *
     * Everything below happens in ONE transaction, and the ordering of the steps is the
     * concurrency design. The sequence is:
     *
     *   1. Lock the order row (`FOR UPDATE`).
     *   2. Short-circuit if it is already allocated, cancelled, or otherwise not a candidate.
     *   3. Find the active sites responsible for the destination country.
     *   4. Lock every candidate's inventory rows for the SKUs in this basket (`FOR UPDATE`),
     *      in a deterministic order.
     *   5. Decide, using only the locked rows.
     *   6. Write: reserve, record reservations, mark the order allocated -- or record an
     *      exception.
     *
     * Steps 4 and 5 are the ones that are easy to get wrong. The tempting design reads stock
     * in step 4, decides in step 5, and writes in step 6 as three separate operations. The
     * gap between them is where the oversell lives: another request commits a reservation
     * after our read and before our write, and we then allocate against stock that was never
     * ours. Locking the rows before deciding closes the gap by moving the read and the write
     * onto the same row locks, so the decision is made from data that cannot change underneath
     * it. The conditional decrement in step 6 is a second line of defence, not the mechanism.
     *
     * Row locks are ordered by (warehouse, sku) so two transactions routing overlapping
     * baskets always grab them in the same sequence. Without the `ORDER BY`, two requests
     * that need SKUs A+B and B+A can each hold the row the other wants, and Postgres resolves
     * the deadlock by killing one of them -- turning a correct design into an intermittent
     * failure that only reproduces under load.
     */
    async routeOrder({ orderId }): Promise<RoutingOutcome> {
      return db.transaction(async (transaction) => {
        // Step 1. Also the idempotency guard: a second concurrent routing of the same order
        // blocks here until the first commits, then sees the allocated state and short-circuits.
        const [orderRow] = await transaction
          .select()
          .from(orders)
          .where(eq(orders.id, orderId))
          .for("update");

        if (!orderRow) {
          // Routing an order that does not exist is a caller bug, not a business outcome, so
          // it throws rather than returning "not routable" and letting the caller shrug.
          throw new ValidationFailedError("Cannot route an order that does not exist.", { details: { orderId } });
        }

        const itemRows = await transaction.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.shopifyLineItemId));

        const routable = toRoutableOrder(orderRow, itemRows);
        const basket = buildRoutableBasket(routable);

        // Step 2. An already-allocated order reports the allocation it already has. Reserving
        // again would double-book stock, and the partial unique index on active reservations
        // would turn the second attempt into a constraint error instead of a clean no-op.
        if (orderRow.status === "allocated" && orderRow.allocatedWarehouseId !== null) {
          const active = await transaction
            .select({ sku: inventoryReservations.sku, quantity: inventoryReservations.quantity })
            .from(inventoryReservations)
            .where(and(eq(inventoryReservations.orderId, orderId), eq(inventoryReservations.status, "active")));

          return {
            outcome: "allocated",
            orderId: routable.orderId,
            warehouseId: toWarehouseId(orderRow.allocatedWarehouseId),
            reserved: new Map(active.map((row) => [toSku(row.sku), row.quantity])),
          };
        }

        // Cancelled, test, or already being worked. Not an error and not an exception: raising
        // one would put a "no warehouse" row in the queue for an order that is on purpose not
        // shipping, and every cancelled order would generate operator work.
        if (orderRow.status !== "pending" || orderRow.isTestOrder) return { outcome: "not_routable", orderId: routable.orderId };

        if (basket.size === 0) {
          // Nothing to allocate: an order of only digital goods, or one already fully
          // fulfilled. Allocating it to a warehouse would reserve nothing and look successful.
          return { outcome: "not_routable", orderId: routable.orderId };
        }

        // Step 3. Reference data: which active sites are responsible for this country.
        const routeRows = await transaction
          .select({
            warehouseId: warehouseRoutes.warehouseId,
            countryCode: warehouseRoutes.countryCode,
            priority: warehouseRoutes.priority,
          })
          .from(warehouseRoutes)
          .innerJoin(warehouses, eq(warehouses.id, warehouseRoutes.warehouseId))
          .where(and(eq(warehouseRoutes.countryCode, String(routable.shippingCountryCode)), eq(warehouses.isActive, true)))
          .orderBy(asc(warehouseRoutes.priority), asc(warehouseRoutes.warehouseId));

        if (routeRows.length === 0) {
          return persistUnroutable(transaction, routable, { outcome: "unroutable", reason: "no_warehouse_for_country" });
        }

        const warehouseIds = [...new Set(routeRows.map((row) => row.warehouseId))];
        const skus = [...basket.keys()].map(String);

        // Step 4. Lock the candidate stock, ordered deterministically to avoid deadlocks.
        //
        // `is_active` is re-read here rather than trusted from step 3. A site deactivated
        // between the two queries would otherwise be allocated an order after it was closed;
        // the window is milliseconds, but it is free to close, and "we closed that warehouse
        // and it still shipped an order" is not a bug anyone wants to explain.
        const lockedRows = await transaction
          .select({
            warehouseId: inventory.warehouseId,
            sku: inventory.sku,
            onHand: inventory.onHand,
            reserved: inventory.reserved,
            isActive: warehouses.isActive,
          })
          .from(inventory)
          .innerJoin(warehouses, eq(warehouses.id, inventory.warehouseId))
          .where(and(inArray(inventory.warehouseId, warehouseIds), inArray(inventory.sku, skus)))
          .orderBy(asc(inventory.warehouseId), asc(inventory.sku))
          .for("update", { of: inventory });

        const routesByWarehouse = new Map<string, { countryCode: ReturnType<typeof toCountryCode>; priority: number }[]>();
        for (const row of routeRows) {
          const existing = routesByWarehouse.get(row.warehouseId) ?? [];
          existing.push({ countryCode: toCountryCode(String(row.countryCode)), priority: row.priority });
          routesByWarehouse.set(row.warehouseId, existing);
        }

        const stockByWarehouse = new Map<string, Map<Sku, StockLevel>>();
        for (const row of lockedRows) {
          const stock = stockByWarehouse.get(row.warehouseId) ?? new Map<Sku, StockLevel>();
          stock.set(toSku(row.sku), StockLevel.create(toSku(row.sku), row.onHand, row.reserved));
          stockByWarehouse.set(row.warehouseId, stock);
        }

        const candidates = warehouseIds
          .map((id) =>
            toWarehouseCandidate({
              warehouseId: toWarehouseId(id),
              isActive: lockedRows.find((row) => row.warehouseId === id)?.isActive ?? true,
              routes: routesByWarehouse.get(id) ?? [],
              stock: stockByWarehouse.get(id) ?? new Map<Sku, StockLevel>(),
            }),
          )
          .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

        // Step 5. The decision, made entirely from the locked rows.
        const decision = selectWarehouse({
          countryCode: routable.shippingCountryCode === null ? null : toCountryCode(routable.shippingCountryCode),
          requirements: basket,
          candidates,
          orderIsRoutable: routable.problems.length === 0,
        });

        if (decision.outcome === "unroutable") {
          return persistUnroutable(transaction, routable, decision);
        }

        // Step 6. Reserve. Sorted so two transactions reserving overlapping SKUs take the same
        // row order, matching the lock order above and keeping the deadlock argument intact.
        const reservationEntries = [...decision.reservation].sort(([a], [b]) => String(a).localeCompare(String(b)));

        for (const [sku, quantity] of reservationEntries) {
          const updated = await transaction
            .update(inventory)
            .set({ reserved: sql`${inventory.reserved} + ${quantity}`, updatedAt: sql`now()` })
            .where(
              and(
                eq(inventory.warehouseId, decision.warehouseId),
                eq(inventory.sku, String(sku)),
                // The availability guard, restated in the WHERE clause so the row is only
                // touched if the increment is actually legal. The CHECK constraint would
                // reject it too, but it aborts the whole transaction with an opaque
                // constraint-violation error instead of a diagnosable one.
                sql`${inventory.onHand} - ${inventory.reserved} >= ${quantity}`,
              ),
            )
            .returning({ id: inventory.id });

          if (updated.length === 0) {
            // Rolls the transaction back, so the SKUs already incremented in this loop are
            // undone. Partial reservations are not an outcome this system has.
            throw new InventoryInvariantError(`Locked inventory row for ${String(sku)} could not cover a reservation of ${quantity}.`);
          }
        }

        await transaction.insert(inventoryReservations).values(
          reservationEntries.map(([sku, quantity]) => ({
            id: crypto.randomUUID(),
            orderId,
            warehouseId: decision.warehouseId,
            sku: String(sku),
            quantity,
            status: "active" as const,
          })),
        );

        // Conditional on still being `pending`, so a cancellation that committed while this
        // transaction waited on a stock lock cannot be overwritten by an allocation. Zero rows
        // means the order was cancelled underneath us; throwing rolls the reservations back.
        const marked = await transaction
          .update(orders)
          .set({ status: "allocated", allocatedWarehouseId: decision.warehouseId, updatedAt: sql`now()` })
          .where(and(eq(orders.id, orderId), eq(orders.status, "pending")))
          .returning({ id: orders.id });

        if (marked.length === 0) {
          throw new InventoryInvariantError(`Order ${orderId} left the pending state while stock was being reserved.`);
        }

        await transaction.insert(auditEvents).values(auditEventsForAllocation(orderId, decision.warehouseId, reservationEntries));

        return { outcome: "allocated", orderId: routable.orderId, warehouseId: decision.warehouseId, reserved: decision.reservation };
      });
    },
  };
}

/**
 * Writes the exception and returns the outcome, inside the caller's transaction.
 *
 * Taking the transaction as a parameter rather than opening its own is deliberate: the
 * exception must land in the same transaction as the decision it describes. A separate
 * commit could succeed where the decision rolled back, leaving a queue entry for a routing
 * that did not happen -- the mirror image of the stranded-webhook problem Phase 2 fixed.
 */
async function persistUnroutable(
  transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  order: RoutableOrder,
  decision: ReturnType<typeof selectWarehouse>,
): Promise<RoutingOutcome> {
  // `new Date()` rather than a passed-in clock: the repository is the only place that knows
  // when the decision was actually committed, which is what `created_at` should record.
  const exception = toRoutingException(order, decision, new Date());

  // `onConflictDoNothing` against `exceptions_open_order_type_unique`, not an unconditional
  // insert. The order stays `pending` when it cannot be routed -- that is deliberate, and it is
  // what makes a restock self-heal on the next pass -- which means this code runs again every
  // five minutes for as long as the problem lasts. An unconditional insert would either pile up
  // a duplicate queue entry per pass (288 a day per order, burying every other problem the
  // operator has) or start throwing once the unique index landed, which would take the worker
  // down for the one condition an operator most needs to see.
  const inserted = await transaction
    .insert(exceptions)
    .values({
      id: exception.id,
      orderId: order.orderId,
      type: exception.type,
      severity: exception.severity,
      status: "open",
      reason: exception.reason,
      details: exception.details,
      createdAt: exception.createdAt,
    })
    .onConflictDoNothing({
      target: [exceptions.orderId, exceptions.type],
      where: sql`${exceptions.status} = 'open'`,
    })
    .returning({ id: exceptions.id });

  // Nothing came back, so an open exception of this type is already on file. Report *that* one
  // rather than the freshly-built one: the outcome is the same "this order is unroutable" in
  // both cases, and handing back an exception that was never persisted would leave the caller
  // holding an id it cannot look up.
  if (inserted.length === 0) {
    const [existing] = await transaction
      .select()
      .from(exceptions)
      .where(and(eq(exceptions.orderId, order.orderId), eq(exceptions.type, exception.type), eq(exceptions.status, "open")))
      .limit(1);

    if (!existing) {
      // The conflict fired but the row is not there, which means the index and this query
      // disagree. Failing loudly is right: silently continuing would report an unroutable
      // order with no queue entry behind it, which is the exact silent-stall this whole
      // mechanism exists to prevent.
      throw new PersistenceError(
        `Conflicting exception for order ${order.orderId} (${exception.type}) is not readable.`,
      );
    }

    return { outcome: "unroutable", orderId: order.orderId, exception: toFulfillmentException(existing) };
  }

  return { outcome: "unroutable", orderId: order.orderId, exception };
}

/**
 * Reconstructs the domain aggregate so `problems()` is the single source of routing rules.
 *
 * This is the wiring Phase 3 left open. The alternative -- recomputing "is this order
 * shippable" with a second implementation in the repository -- would be the classic way a
 * rule ends up enforced in one place and forgotten in the other. The aggregate is
 * reconstructed read-only and thrown away; the router never gets a mutable copy, so it cannot
 * transition the order it is allocating.
 *
 * A `ValidationFailedError` from the constructor means the row is internally inconsistent
 * (a line with no title, a zero quantity, a mixed-currency order). That is a data defect
 * rather than a business outcome, so it is re-thrown as a `PersistenceError` naming the
 * order -- it must fail loudly rather than be filed as "unroutable", because a corrupt row
 * that quietly becomes an exception sends an operator hunting a data problem that is a code
 * or ingestion problem.
 */
function toRoutableOrder(orderRow: typeof orders.$inferSelect, itemRows: (typeof orderItems.$inferSelect)[]): RoutableOrder {
  const shopTo =
    orderRow.shippingCountryCode === null
      ? null
      : {
          name: orderRow.shippingName,
          line1: orderRow.shippingAddressLine1,
          line2: orderRow.shippingAddressLine2,
          city: orderRow.shippingCity,
          region: orderRow.shippingProvince,
          postalCode: orderRow.shippingPostalCode,
          countryCode: toCountryCode(orderRow.shippingCountryCode),
        };

  const currency = toCurrency(orderRow.currency);

  const aggregate = Order.create({
    id: toOrderId(orderRow.id),
    // Deterministic and arbitrary. The generated line ids are only used for error detail;
    // nothing in the routing path keys off them, so a stable seed beats a random one.
    lineIdSeed: 0,
    shopDomain: toShopDomain(orderRow.shopDomain),
    externalReference: orderRow.shopifyOrderId,
    currency,
    lines: itemRows.map((item) => ({
      sku: item.sku === null ? null : toSku(item.sku),
      title: item.title,
      quantity: item.quantity,
      unitPrice: // `fromDecimal`, not a minor-unit conversion by hand: the column is `numeric(12,2)`
        // and Postgres renders it as a decimal string, so the exponent-aware parse is the only
        // place that knows whether "10.50" is 1050 or 105000 for this currency.
        Money.fromDecimal(currency, item.unitPrice),
      // Carried into the aggregate so `problems()` can tell a mis-catalogued physical variant
      // from a digital line that was never supposed to have a SKU. Omitting it made every
      // digital order unroutable.
      requiresShipping: item.requiresShipping,
    })),
    shipTo: shopTo,
    isTestOrder: orderRow.isTestOrder,
    placedAt: orderRow.sourceCreatedAt,
    status: orderRow.status as OrderStatus,
  });

  return {
    orderId: aggregate.id,
    status: orderRow.status,
    isTestOrder: orderRow.isTestOrder,
    shippingCountryCode: orderRow.shippingCountryCode,
    items: itemRows.map((item) => ({
      shopifyLineItemId: item.shopifyLineItemId,
      sku: item.sku,
      fulfillableQuantity: item.fulfillableQuantity ?? item.quantity,
      requiresShipping: item.requiresShipping,
    })),
    problems: aggregate.problems(),
  };
}

/**
 * The audit row for a successful allocation.
 *
 * Resonable rather than spread across the `inventory_reservations` rows on purpose: the
 * question an operator asks is "what did we commit for this order, and where", and that is a
 * property of the decision, not of each SKU. The reservations remain the per-SKU record.
 */
function auditEventsForAllocation(orderId: string, warehouseId: string, reservation: readonly (readonly [Sku, number])[]) {
  return [
    {
      id: crypto.randomUUID(),
      entityType: "order",
      entityId: orderId,
      eventType: "ORDER_ALLOCATED",
      metadata: {
        warehouseId: String(warehouseId),
        reserved: Object.fromEntries(reservation.map(([sku, quantity]) => [String(sku), quantity])),
      },
    },
  ];
}
