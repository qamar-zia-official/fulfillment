import { type ShippabilityVerdict, type PostalAddress, classifyShippability, toPostalAddress } from "./address";
import { ValidationFailedError } from "./errors";
import { type Currency, Money, sumMoney, toCurrency } from "./money";
import { type OrderStatus, assertTransition } from "./order-status";
import {
  type OrderId,
  type OrderLineId,
  type ShopDomain,
  type Sku,
  type WarehouseId,
  toOrderId,
  toOrderLineId,
} from "./identifiers";

/**
 * Why an order cannot begin fulfillment.
 *
 * Returned by {@link Order.problems} rather than thrown. The distinction is the same one that
 * separates an exception from an error: a missing SKU is not a malfunction, it is a real
 * order that needs a human. Throwing here would fail the job, and failing the job loses the
 * order -- the exact outcome Phase 2 avoided by storing the item and deferring the judgement.
 */
export type OrderProblem =
  | { readonly kind: "is_test_order" }
  | { readonly kind: "unroutable_address"; readonly blockers: readonly string[] }
  | { readonly kind: "missing_sku"; readonly skus: readonly string[] }
  | { readonly kind: "already_in_progress"; readonly status: OrderStatus };

export type CancellationReason =
  | "merchant_requested"
  | "payment_failed"
  | "out_of_stock"
  | "fraud_detected"
  | "other";

export interface OrderLine {
  readonly id: OrderLineId;
  /** Null when the merchant did not supply one. Not an error; see {@link Order.problems}. */
  readonly sku: Sku | null;
  readonly title: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  /**
   * Whether a courier has to move this line. Optional, defaulting to true.
   *
   * Defaults to `true` rather than being required, because "shippable" is the safe assumption
   * for a line whose origin is unknown: treating an unmarked digital line as physical reserves
   * stock for a product nobody will pick, while treating an unmarked physical line as digital
   * ships nothing. A caller that knows better says so.
   *
   * It exists at all because of {@link Order.problems}. A gift card or an e-book has no SKU
   * and must never be held up as a data-quality failure, and the only way to tell it apart from
   * a mis-catalogued physical variant is to carry the flag into the aggregate.
   */
  readonly requiresShipping?: boolean;
}

export interface NewOrder {
  id: OrderId;
  lineIdSeed: number;
  shopDomain: ShopDomain;
  externalReference: string;
  currency: Currency;
  lines: ReadonlyArray<Omit<OrderLine, "id">>;
  shipTo: PostalAddress | null;
  isTestOrder?: boolean;
  placedAt: Date;
  status?: OrderStatus;
}

export interface Cancellation {
  readonly reason: CancellationReason;
  readonly note: string | null;
  readonly at: Date;
}

/**
 * The order aggregate root.
 *
 * Mutable, and that is a deliberate reversal of the immutable style used by `Money` and
 * `StockLevel`. An aggregate is a consistency boundary: the invariant "a cancelled order has
 * a cancellation timestamp" spans several fields, and enforcing it needs a single place that
 * sees all of them and can refuse the change. Spreading that check across callers means every
 * new caller has to remember it, and the one that forgets writes the impossible row.
 *
 * The private fields plus readonly accessors keep callers from assigning `status` directly and
 * bypassing the machine; they can only advance the order by asking it to.
 */
export class Order {
  private state: OrderStatus;
  private readonly lines: readonly OrderLine[];
  private assignedWarehouse: WarehouseId | null = null;
  private cancellation: Cancellation | null = null;

  private constructor(
    readonly id: OrderId,
    readonly shopDomain: ShopDomain,
    readonly externalReference: string,
    readonly currency: Currency,
    lines: readonly OrderLine[],
    readonly shipTo: PostalAddress | null,
    readonly isTestOrder: boolean,
    readonly placedAt: Date,
    status: OrderStatus,
  ) {
    this.lines = lines;
    this.state = status;
  }

  static create(input: NewOrder): Order {
    if (input.lines.length === 0) {
      // An order with no lines has nothing to fulfil, and a zero total would quietly look
      // like a real order to every downstream report.
      throw new ValidationFailedError("An order must have at least one line.", { details: { orderId: input.id } });
    }
    if (input.externalReference.trim().length === 0) {
      throw new ValidationFailedError("An order must carry the merchant's reference.", { details: { orderId: input.id } });
    }

    const currency = toCurrency(input.currency);
    const lines = input.lines.map((line, index) => buildLine(line, index, input.lineIdSeed, currency));

    return new Order(
      toOrderId(input.id),
      input.shopDomain,
      input.externalReference.trim(),
      currency,
      lines,
      input.shipTo === null ? null : toPostalAddress(input.shipTo),
      input.isTestOrder ?? false,
      input.placedAt,
      input.status ?? "pending",
    );
  }

  get status(): OrderStatus {
    return this.state;
  }

  get orderLines(): readonly OrderLine[] {
    return this.lines;
  }

  get warehouseId(): WarehouseId | null {
    return this.assignedWarehouse;
  }

  get cancelledAt(): Date | null {
    return this.cancellation?.at ?? null;
  }

  get cancellationReason(): CancellationReason | null {
    return this.cancellation?.reason ?? null;
  }

  get totalQuantity(): number {
    return this.lines.reduce((total, line) => total + line.quantity, 0);
  }

  /** Sum of unit price times quantity. Derived, so it cannot contradict the lines. */
  get subtotal(): Money {
    return sumMoney(this.lines.map((line) => line.unitPrice.multiply(line.quantity)), this.currency);
  }

  /**
   * Quantity needed per SKU, for the routing phase.
   *
   * Merchants legitimately send the same SKU as two separate lines (a bundle, a discount
   * line), and inventory can only be reserved against the total. Aggregating here instead of
   * merging the lines keeps the merchant's structure intact for display and invoicing while
   * still giving stock the single number it needs. Destroying the lines to achieve that would
   * throw away data a human might need.
   */
  quantityBySku(): Map<Sku, number> {
    const totals = new Map<Sku, number>();
    for (const line of this.lines) {
      if (line.sku === null) continue;
      totals.set(line.sku, (totals.get(line.sku) ?? 0) + line.quantity);
    }
    return totals;
  }

  /** Every reason this order cannot begin fulfillment. Empty means it can. */
  problems(): readonly OrderProblem[] {
    const found: OrderProblem[] = [];

    if (this.isTestOrder) {
      // Test orders are real orders that must never consume stock or create a label. Saying
      // so explicitly beats a dashboard filter nobody remembers to apply.
      found.push({ kind: "is_test_order" });
    }

    if (this.state !== "pending") {
      found.push({ kind: "already_in_progress", status: this.state });
    }

    // A missing address is a distinct failure from an incomplete one, and inventing a
    // placeholder country just to run the classifier would report blockers for a country
    // nobody supplied.
    if (this.shipTo === null) {
      found.push({ kind: "unroutable_address", blockers: ["missing_address"] });
    } else {
      const verdict = classifyShippability(this.shipTo);
      if (!verdict.shippable) {
        found.push({ kind: "unroutable_address", blockers: verdict.blockers });
      }
    }

    // Only *physical* lines matter here. Flagging a digital line for having no SKU is a
    // false positive with a real cost: the order becomes unroutable, a blocking exception is
    // filed, and an operator is sent to fix a catalogue entry that was never wrong.
    const shippableWithoutSku = this.lines.filter((line) => line.sku === null && (line.requiresShipping ?? true));
    if (shippableWithoutSku.length > 0) {
      found.push({
        kind: "missing_sku",
        // The line title stands in for the missing SKU, because a list of `null`s tells an
        // operator nothing they can act on.
        skus: shippableWithoutSku.map((line) => line.title),
      });
    }

    return found;
  }

  get shippability(): ShippabilityVerdict | null {
    return this.shipTo === null ? null : classifyShippability(this.shipTo);
  }

  /**
   * Advances the lifecycle.
   *
   * The single choke point: every status change goes through {@link assertTransition}, so a
   * transition cannot be legal in the database and illegal here, or vice versa.
   */
  private transitionTo(next: OrderStatus): void {
    assertTransition(this.state, next);
    this.state = next;
  }

  /**
   * Assigns the order to a warehouse.
   *
   * Refuses while any {@link problems} remain, because allocating a warehouse reserves real
   * stock. An order with an incomplete address and no SKU would otherwise tie up inventory at
   * a site that physically cannot ship it, and the stock would stay tied up until a human
   * noticed -- which is exactly the stock-out that caused the problem in the first place.
   */
  allocate(warehouseId: WarehouseId): void {
    // Transition legality first, then business problems.
    //
    // The order matters for diagnosability. Checked the other way round, an attempt to
    // allocate a *cancelled* order reports "unresolved problems" -- technically true, since
    // "already in progress" is one of them, but it hides the actual cause. The operator is
    // sent looking for a data problem on an order that is simply finished.
    assertTransition(this.state, "allocated");

    const problems = this.problems();
    if (problems.length > 0) {
      throw new ValidationFailedError("Order cannot be allocated while it has unresolved problems.", {
        details: { orderId: this.id, problems: problems.map((problem) => problem.kind) },
      });
    }

    this.assignedWarehouse = warehouseId;
    this.transitionTo("allocated");
  }

  /** Returns an allocated order to the pool so a different warehouse can be tried. */
  deallocate(): void {
    this.transitionTo("pending");
    this.assignedWarehouse = null;
  }

  startPicking(): void {
    this.transitionTo("picking");
  }

  markPicked(): void {
    this.transitionTo("picked");
  }

  markPacked(): void {
    this.transitionTo("packed");
  }

  markShipped(): void {
    this.transitionTo("shipped");
  }

  markDelivered(): void {
    this.transitionTo("delivered");
  }

  /**
   * Cancels the order, moving status, timestamp, and reason in one step.
   *
   * These three are a single fact: "cancelled" is meaningless without knowing when and why.
   * Setting them in separate calls is how a row ends up cancelled with a null timestamp, which
   * is precisely what the `orders_cancelled_requires_timestamp_check` constraint in Phase 2
   * exists to catch. Enforcing the invariant in the domain means the constraint should never
   * actually fire -- and if it ever does, the cause is a writer that bypassed this class.
   */
  cancel(cancellation: Cancellation): void {
    if (Number.isNaN(cancellation.at.getTime())) {
      throw new ValidationFailedError("Cancellation must carry a valid date.");
    }
    this.transitionTo("cancelled");
    this.cancellation = cancellation;
  }
}

function buildLine(
  line: Omit<OrderLine, "id">,
  index: number,
  idSeed: number,
  orderCurrency: Currency,
): OrderLine {
  if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
    throw new ValidationFailedError("A line quantity must be a positive whole number.", {
      details: { index, quantity: line.quantity },
    });
  }
  if (line.title.trim().length === 0) {
    throw new ValidationFailedError("A line must carry a title.", { details: { index } });
  }
  if (line.unitPrice.currency !== orderCurrency) {
    // Caught here because a mixed-currency order produces a total in the wrong currency, and
    // the mismatch only becomes visible much later, in a reconciliation.
    throw new ValidationFailedError("Every line must be priced in the order's currency.", {
      details: { index, line: line.unitPrice.currency, order: orderCurrency },
    });
  }

  return { ...line, requiresShipping: line.requiresShipping ?? true, id: toOrderLineId(`${idSeed}-${index + 1}`) };
}
