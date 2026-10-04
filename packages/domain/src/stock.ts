import { ConflictError, ValidationFailedError } from "./errors";

/**
 * Stock for one SKU at one location.
 *
 * The whole design rests on a single decision: **`available` is derived, never stored.**
 *
 * Storing `onHand`, `reserved`, and `available` as three columns is the obvious design and
 * it is wrong. Three stored numbers can disagree, and they will: a concurrent reserve that
 * updates two of them and is then interrupted by a crash leaves `available` promising units
 * that `reserved` has already given away. The damage shows up as an oversell, discovered by
 * the customer. Deriving it means there is nothing to keep in sync, so the inconsistency
 * cannot be represented.
 *
 * Immutable: every operation returns a new `StockLevel`. Reservations are made across many
 * SKUs in one transaction, and an immutable value can be held in a map, compared, and rolled
 * back by simply discarding it.
 */
export class StockLevel {
  private constructor(
    readonly sku: string,
    readonly onHand: number,
    readonly reserved: number,
  ) {}

  static create(sku: string, onHand = 0, reserved = 0): StockLevel {
    requireQuantity(onHand, "onHand");
    requireQuantity(reserved, "reserved");
    // The invariant that a stored `available` column cannot enforce.
    if (reserved > onHand) {
      throw new ValidationFailedError("Reserved stock cannot exceed on-hand stock.", {
        details: { sku, onHand, reserved },
      });
    }
    return new StockLevel(sku, onHand, reserved);
  }

  /**
   * Units that may still be promised to a new order.
   *
   * Derived, and the reason this class cannot be corrupted into overselling.
   */
  get available(): number {
    return this.onHand - this.reserved;
  }

  /**
   * Whether this location can cover a requirement in full.
   *
   * Deliberately all-or-nothing. Splitting an order across locations is a real strategy, but
   * it is the *routing* phase's decision to make with knowledge of all locations, and doing it
   * per-location here would let a caller commit to a partial allocation it cannot honour.
   */
  canSatisfy(quantity: number): boolean {
    requireQuantity(quantity, "quantity");
    return this.available >= quantity;
  }

  /** Stock arrives from a purchase order, a transfer, or a return. */
  receive(quantity: number): StockLevel {
    requireQuantity(quantity, "quantity");
    return new StockLevel(this.sku, this.onHand + quantity, this.reserved);
  }

  /**
   * Promises stock to an order without removing it from on-hand.
   *
   * On-hand is untouched because the units are still physically present and still sellable;
   * only the *promise* changes. Removing them here would make `release` impossible to
   * implement correctly -- a cancelled order would have to invent stock that physically
   * never left the shelf.
   */
  reserve(quantity: number): StockLevel {
    requireQuantity(quantity, "quantity");
    if (quantity > this.available) {
      // Conflict, not validation. The request is well-formed; it just cannot be satisfied
      // against the stock that exists right now, which is precisely the distinction that
      // tells an operator "wait for a restock" instead of "fix the request".
      throw new ConflictError("Insufficient available stock to reserve.", {
        details: { sku: this.sku, requested: quantity, available: this.available, onHand: this.onHand, reserved: this.reserved },
      });
    }
    return new StockLevel(this.sku, this.onHand, this.reserved + quantity);
  }

  /**
   * Gives a reservation back: the order was cancelled, deallocated, or never picked.
   *
   * `ConflictError` rather than a clamp. A request to release more than was reserved means
   * the caller's bookkeeping disagrees with the database's, and quietly releasing what is
   * there would let the discrepancy hide until it produced phantom availability.
   */
  release(quantity: number): StockLevel {
    requireQuantity(quantity, "quantity");
    if (quantity > this.reserved) {
      throw new ConflictError("Cannot release more than is reserved.", {
        details: { sku: this.sku, requested: quantity, reserved: this.reserved },
      });
    }
    return new StockLevel(this.sku, this.onHand, this.reserved - quantity);
  }

  /**
   * Consumes a reservation: the parcel has physically left.
   *
   * Both counters fall together. This is the only operation that reduces on-hand, and doing
   * it in one step is what keeps `reserved <= onHand` true by construction rather than by
   * careful ordering elsewhere in the codebase.
   */
  commit(quantity: number): StockLevel {
    requireQuantity(quantity, "quantity");
    if (quantity > this.reserved) {
      throw new ConflictError("Cannot commit more than is reserved.", {
        details: { sku: this.sku, requested: quantity, reserved: this.reserved },
      });
    }
    return new StockLevel(this.sku, this.onHand - quantity, this.reserved - quantity);
  }

  /** Manual correction from a stock count. Use sparingly, and always with a reason attached. */
  adjustToCounted(onHand: number): StockLevel {
    requireQuantity(onHand, "onHand");
    if (onHand < this.reserved) {
      throw new ConflictError("Cannot set on-hand below the amount already reserved.", {
        details: { sku: this.sku, counted: onHand, reserved: this.reserved },
      });
    }
    return new StockLevel(this.sku, onHand, this.reserved);
  }

  toString(): string {
    return `StockLevel(${this.sku} onHand=${this.onHand} reserved=${this.reserved} available=${this.available})`;
  }
}

const requireQuantity = (value: number, label: string): void => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationFailedError(`${label} must be a non-negative safe integer.`, { details: { received: value } });
  }
};

/**
 * Checks whether a whole basket can be covered.
 *
 * Returns a per-SKU shortfall map rather than a boolean, because the routing phase's next
 * step is to decide between "try another warehouse" and "raise an insufficient-stock
 * exception", and both need to know exactly which items are short and by how much. A boolean
 * answer forces one of those paths to re-check and re-report.
 */
export const findShortfall = <TKey extends string>(
  requirements: ReadonlyMap<TKey, number>,
  stock: ReadonlyMap<TKey, StockLevel>,
): Map<TKey, number> => {
  const shortfall = new Map<TKey, number>();

  for (const [sku, quantity] of requirements) {
    requireQuantity(quantity, `requirement for ${sku}`);
    const held = stock.get(sku);
    const available = held?.available ?? 0;
    if (quantity > available) {
      shortfall.set(sku, quantity - available);
    }
  }

  return shortfall;
};

export const canFulfilAll = <TKey extends string>(
  requirements: ReadonlyMap<TKey, number>,
  stock: ReadonlyMap<TKey, StockLevel>,
): boolean => findShortfall(requirements, stock).size === 0;
