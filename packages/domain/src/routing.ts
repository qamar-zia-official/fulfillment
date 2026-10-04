import { type CountryCode, type Sku, type WarehouseId } from "./identifiers";
import { findShortfall, type StockLevel } from "./stock";

/**
 * A location that could fulfil an order, as the policy sees it.
 *
 * Deliberately not a database row. The routing rules need exactly this information and
 * nothing else, so depending on a wider shape would couple the policy to a table that will
 * change as the warehouse model grows. The repository's job is to project rows into this.
 */
export interface WarehouseCandidate {
  readonly warehouseId: WarehouseId;
  /** Countries this site can ship to, with the closer sites first. */
  readonly routes: readonly WarehouseRoute[];
  readonly stock: ReadonlyMap<Sku, StockLevel>;
}

/**
 * A (country, priority) pair.
 *
 * Priority is a list position, not a distance in kilometres: "which countries is this site
 * responsible for, and in what order" is a commercial decision, and encoding real geography
 * as a number would be a guess dressed up as physics. A site that serves two countries has
 * two independent priorities, which is why this is a list rather than a single field.
 */
export interface WarehouseRoute {
  readonly countryCode: CountryCode;
  /** Lower sorts first. Ties are broken by warehouse id, so the choice is total. */
  readonly priority: number;
}

export type UnroutableReason =
  /** No active site is responsible for the destination country. */
  | "no_warehouse_for_country"
  /** Sites exist for the country, but none holds the whole basket. */
  | "insufficient_stock"
  /** The order itself is not a candidate: test order, incomplete address, or missing SKU. */
  | "order_not_routable";

export type RoutingDecision =
  | {
      readonly outcome: "routed";
      readonly warehouseId: WarehouseId;
      /** What to reserve, per SKU. Never partially applied. */
      readonly reservation: ReadonlyMap<Sku, number>;
    }
  | {
      readonly outcome: "unroutable";
      readonly reason: UnroutableReason;
      /** Which SKUs were short at the best-ranked site, when that is the cause. */
      readonly shortfall?: ReadonlyMap<Sku, number>;
    };

/**
 * Picks the warehouse for an order, or explains why there isn't one.
 *
 * Four rules, in the order they are applied. The order is the design.
 *
 * 1. **The order must be a candidate at all.** A test order, an address without a street, or
 *    a shippable line with no SKU is rejected *before* any warehouse is considered, because
 *    searching harder cannot fix a problem in the order. Reserving stock for an order that
 *    can never ship is how you cause the stock-out you were trying to prevent.
 *
 * 2. **Country is a hard filter, not a preference.** A site that is not responsible for the
 *    destination is not a candidate at any price. This is what keeps a German warehouse from
 *    being chosen for a New Zealand order when it happens to have more stock.
 *
 * 3. **All or nothing.** One site must cover the whole basket. Splitting an order across two
 *    sites means two labels, two carriers, two delivery windows, and a customer who receives
 *    half an order in March. That is a legitimate strategy, but it has to be chosen
 *    deliberately with knowledge of cost -- not discovered as a side effect of a loop.
 *
 * 4. **Rank by declared priority, then by id.** Deterministic on purpose: the same order must
 *    route to the same warehouse every time it is evaluated, or a retry silently moves
 *    inventory and "why did this go to Rotterdam?" becomes unanswerable.
 *
 * Pure and total. No I/O, no clock, no randomness.
 */
export const selectWarehouse = (input: {
  countryCode: CountryCode | null;
  requirements: ReadonlyMap<Sku, number>;
  candidates: readonly WarehouseCandidate[];
  /** False when `Order.problems()` found anything. See rule 1. */
  orderIsRoutable: boolean;
}): RoutingDecision => {
  const { countryCode, requirements, candidates, orderIsRoutable } = input;

  // Rule 1. Checked first, and deliberately: a broken order is unroutable regardless of how
  // much stock exists, and the reason an operator gets must be the order, not the stock.
  if (!orderIsRoutable) return { outcome: "unroutable", reason: "order_not_routable" };

  if (countryCode === null) return { outcome: "unroutable", reason: "no_warehouse_for_country" };

  // Rule 2, then rule 4: filter to responsible sites and sort them by declared preference.
  const eligible = candidates
    .filter((candidate) => candidate.routes.some((route) => route.countryCode === countryCode))
    .sort(compareByPriorityThenId(countryCode));

  if (eligible.length === 0) return { outcome: "unroutable", reason: "no_warehouse_for_country" };

  // Rule 3: the first site that can cover the entire basket wins. Sites that cannot are
  // skipped rather than combined.
  //
  // `firstShortfall` keeps the best-ranked site's gaps even after later sites have been
  // tried, so the exception names the shortfall of the site we *wanted*, not whichever one
  // happened to be checked last.
  let firstShortfall: ReadonlyMap<Sku, number> | null = null;

  for (const candidate of eligible) {
    const shortfall = findShortfall(requirements, candidate.stock);

    if (shortfall.size === 0) {
      return { outcome: "routed", warehouseId: candidate.warehouseId, reservation: requirements };
    }

    firstShortfall ??= shortfall;
  }

  // Every eligible site had a gap. Report the best-ranked site's.
  return { outcome: "unroutable", reason: "insufficient_stock", shortfall: firstShortfall ?? new Map() };
};

/**
 * Sorts eligible sites: declared priority first, warehouse id as the tie-break.
 *
 * The tie-break is not optional politeness. Without it, two sites with equal priority sort
 * in whatever order the database happened to return, and the same order routes differently
 * on a retry. Determinism is what makes "why this warehouse?" answerable after the fact.
 */
const compareByPriorityThenId =
  (countryCode: CountryCode) =>
  (a: WarehouseCandidate, b: WarehouseCandidate): number => {
    const priorityOf = (candidate: WarehouseCandidate): number =>
      candidate.routes.find((route) => route.countryCode === countryCode)?.priority ?? Number.MAX_SAFE_INTEGER;

    const difference = priorityOf(a) - priorityOf(b);
    return difference !== 0 ? difference : String(a.warehouseId).localeCompare(String(b.warehouseId));
  };
