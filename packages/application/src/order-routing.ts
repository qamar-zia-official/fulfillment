import {
  type FulfillmentException,
  type OrderId,
  type OrderProblem,
  type Sku,
  type StockLevel,
  type WarehouseCandidate,
  type WarehouseId,
  createFulfillmentException,
  exceptionForShortfall,
  selectWarehouse,
} from "@repo/domain";

/**
 * The order as the router needs to see it, loaded by the repository.
 *
 * A projection, not the `orders` row and not the Phase 3 `Order` aggregate. Two reasons, and
 * the difference matters:
 *
 *   - The aggregate owns transitions and enforces them by throwing. The router must never be
 *     able to *change* an order; it decides where stock goes and asks the repository to record
 *     that. Handing it a mutable aggregate would invite a transition inside the routing
 *     transaction, which is the one place an allocation must not be able to accidentally
 *     cancel the order it is allocating.
 *   - The repository needs raw columns to write back. Reconstructing an aggregate only to
 *     take it apart again would hide the real transaction boundary behind ceremony.
 */
export type RoutableOrder = {
  /**
   * Branded, not a bare string. Every exception constructor in the domain takes an `OrderId`,
   * and this is the only place a raw column becomes one -- doing it here means a warehouse id
   * or a Shopify id cannot reach an exception by a mix-up, and the mismatch is a compile
   * error rather than a row in `exceptions` pointing at the wrong order.
   */
  readonly orderId: OrderId;
  readonly status: string;
  readonly isTestOrder: boolean;
  /** Uppercased ISO 3166-1 alpha-2, or null when the merchant supplied no country. */
  readonly shippingCountryCode: string | null;
  /** The lines that could need a warehouse. */
  readonly items: readonly RoutableOrderItem[];
  /**
   * The result of `Order.problems()`.
   *
   * Carried as a value rather than recomputed, because the repository has already read
   * everything `problems()` needs and duplicating that logic here would be a second place for
   * the rules to drift out of step. Only `kind` is used for routing; the payload travels in
   * the exception so an operator sees *which* lines or blockers, not just that there were some.
   */
  readonly problems: readonly OrderProblem[];
};

export type RoutableOrderItem = {
  readonly shopifyLineItemId: string;
  readonly sku: string | null;
  readonly fulfillableQuantity: number;
  readonly requiresShipping: boolean;
};

/**
 * Persistence port for the routing engine.
 *
 * The single `routeOrder` method is the whole design, and the reason is a correctness problem
 * that cannot be solved by splitting it.
 *
 * The obvious design is `listCandidates()` then `reserve()`: read the stock, decide, write.
 * It is wrong, and wrong in the way that only appears under load. Between the read and the
 * write, another request reserves the last unit, so this request has chosen a warehouse on
 * the strength of stock that no longer exists. The result is either an oversell or a
 * confusing "insufficient stock" exception for an order that *was* routable when it was
 * evaluated. No amount of retry logic in application code fixes it, because the window is
 * inside the repository and application cannot see it.
 *
 * So the decision and the write are one operation, and the decision is re-evaluated against
 * locked rows *inside* the transaction. `selectWarehouse` stays pure and testable; the
 * repository owns the isolation. That split is the entire point of keeping the policy in
 * `@repo/domain` and the transaction here.
 */
export interface OrderRoutingRepository {
  /**
   * Order ids that are waiting to be routed, oldest first.
   *
   * The backing query is served by `orders_routable_idx`, a partial index over `(created_at)`
   * WHERE `status = 'pending' AND is_test_order = false` that has existed since Phase 2. Oldest
   * first, not newest: an order that arrived during an outage should be routed before a new one,
   * or the backlog grows without bound while the shop keeps taking orders.
   *
   * There is deliberately no "claim" method. A worker that claimed a batch would need its own
   * claim state to release on crash, and Phase 4 already made `routeOrder` idempotent and
   * row-locked, so running the same order twice is a no-op for the second caller. Claiming
   * would be a second mechanism solving a problem that is already solved, and it would add a
   * state that can be stranded.
   */
  listRoutableOrderIds(limit: number): Promise<readonly string[]>;

  /**
   * Routes an order, or records why it cannot be routed.
   *
   * Must be atomic: either the order is allocated to a warehouse with every SKU reserved, or
   * it is left untouched with an open exception. A partial reservation is not an outcome.
   *
   * Must be idempotent: re-running for an order already `allocated` to a warehouse with
   * active reservations must return that allocation without reserving anything twice.
   * Shopify redelivers, operators re-run jobs by hand, and a retry that double-books stock is
   * a stock-out nobody can explain.
   */
  routeOrder(input: { orderId: string }): Promise<RoutingOutcome>;
}

export type RoutingOutcome =
  | {
      readonly outcome: "allocated";
      readonly orderId: OrderId;
      readonly warehouseId: WarehouseId;
      /** Empty when this call was a no-op because the order was already allocated. */
      readonly reserved: ReadonlyMap<Sku, number>;
    }
  | {
      readonly outcome: "unroutable";
      readonly orderId: OrderId;
      readonly exception: FulfillmentException;
    }
  /** Cancelled, test, or already past allocation. Nobody's job to route, and not an error. */
  | { readonly outcome: "not_routable"; readonly orderId: string };

/**
 * Builds the SKU basket the routing policy reasons about.
 *
 * Quantities are aggregated across line items, because two lines for the same SKU are one
 * allocation of five units, not two allocations of three and two. Treating them separately
 * would let a warehouse appear to hold 3 + 2 = 5 and reserve them as two partial holds that
 * a later order could interleave with.
 *
 * `fulfillableQuantity` is used rather than `quantity`, and both are clamped to non-negative.
 * The gap between them is what is *left* to ship after a partial fulfilment, so reserving
 * the original quantity would demand stock for units that have already gone out.
 *
 * Lines with no SKU are *skipped*, not represented as a sentinel key. They are already an
 * `Order.problem` of kind `missing_sku`, so the order is unroutable regardless, and inventing
 * a key here would put a reservation against a product that does not exist.
 */
export const buildRoutableBasket = (order: RoutableOrder): Map<Sku, number> => {
  const basket = new Map<Sku, number>();

  for (const item of order.items) {
    if (!item.requiresShipping) continue;
    if (item.sku === null) continue;

    const quantity = Math.max(0, item.fulfillableQuantity);
    if (quantity === 0) continue;

    basket.set(item.sku as Sku, (basket.get(item.sku as Sku) ?? 0) + quantity);
  }

  return basket;
};

/**
 * Projects warehouse rows into the policy's input.
 *
 * Kept here rather than in the repository so the shape contract is checked by the layer that
 * owns it, and so "only active sites are candidates" is stated exactly once. An inactive site
 * keeps its stock and its reservation history; it simply never receives a new order, which is
 * the difference between closing a warehouse and erasing it.
 */
export const toWarehouseCandidate = (warehouse: {
  readonly warehouseId: WarehouseId;
  readonly isActive: boolean;
  readonly routes: readonly WarehouseCandidate["routes"][number][];
  readonly stock: ReadonlyMap<Sku, StockLevel>;
}): WarehouseCandidate | null => (warehouse.isActive ? { warehouseId: warehouse.warehouseId, routes: warehouse.routes, stock: warehouse.stock } : null);

/**
 * Turns a routing decision into the exception an operator will work from.
 *
 * The mapping is the point of this function. A stock shortfall and an unreachable country
 * both mean "no warehouse", but they need different fixes: one needs a purchase order, the
 * other a carrier contract. Collapsing them into one type would leave the operator reading a
 * message and guessing.
 *
 * `at` is a parameter rather than a `new Date()`. A pure function of its inputs is testable,
 * and an exception's `createdAt` is a fact about when the decision was made -- which for a
 * replayed job is not the moment the code happened to run.
 */
export const toRoutingException = (
  order: RoutableOrder,
  decision: ReturnType<typeof selectWarehouse>,
  at: Date,
): FulfillmentException => {
  if (decision.outcome === "routed") {
    // Unreachable by construction. Throwing beats fabricating: a routed decision has no
    // shortfall, and returning a plausible-looking exception would hide a real caller bug
    // behind a convincing row in the operations queue.
    throw new Error("A routed decision cannot be turned into an exception.");
  }

  if (decision.reason === "insufficient_stock" && decision.shortfall) {
    // Reuses the domain constructor so the shortfall wording stays identical to the one the
    // Phase 3 tests pin, instead of forking a second phrasing here.
    const exception = exceptionForShortfall(order.orderId, decision.shortfall, at);
    if (exception) return exception;
  }

  if (decision.reason === "order_not_routable") {
    const addressProblem = order.problems.find((problem) => problem.kind === "unroutable_address");

    if (addressProblem && addressProblem.kind === "unroutable_address") {
      return createFulfillmentException({
        orderId: order.orderId,
        type: "unroutable_incomplete_address",
        reason: `Shipping address is incomplete: ${addressProblem.blockers.join(", ")}.`,
        details: { blockers: [...addressProblem.blockers] },
        createdAt: at,
      });
    }

    return createFulfillmentException({
      orderId: order.orderId,
      type: "unroutable_no_warehouse",
      reason: summariseProblems(order.problems),
      details: { problems: order.problems },
      createdAt: at,
    });
  }

  return createFulfillmentException({
    orderId: order.orderId,
    type: "unroutable_no_warehouse",
    reason: `No active warehouse is responsible for ${String(order.shippingCountryCode)}.`,
    details: { countryCode: order.shippingCountryCode },
    createdAt: at,
  });
};

/**
 * A human-readable one-liner for the operator queue.
 *
 * Kind names alone would be useless to someone reading a dashboard -- "missing_sku" does not
 * say *which* SKU. Naming the offending values is the difference between a queue that can be
 * worked and a queue that has to be investigated.
 */
const summariseProblems = (problems: readonly OrderProblem[]): string => {
  if (problems.length === 0) return "Order is not routable.";

  return problems
    .map((problem) => {
      switch (problem.kind) {
        case "is_test_order":
          return "test order must never consume stock";
        case "already_in_progress":
          return `order already ${problem.status}`;
        case "unroutable_address":
          return `address incomplete: ${problem.blockers.join(", ")}`;
        case "missing_sku":
          return `lines with no SKU: ${problem.skus.join(", ")}`;
      }
    })
    .join("; ");
};
