import { describe, expect, test } from "bun:test";
import { ConflictError, ValidationFailedError } from "./errors";
import { StockLevel, canFulfilAll, findShortfall } from "./stock";

describe("available is derived, so it cannot drift", () => {
  test("available is on-hand minus reserved", () => {
    const stock = StockLevel.create("KNT-TEE", 10, 4);
    expect(stock.available).toBe(6);
  });

  test("a full reservation leaves zero available and never negative", () => {
    const stock = StockLevel.create("KNT-TEE", 5, 0).reserve(5);
    expect(stock.available).toBe(0);
    expect(stock.reserved).toBe(5);
    expect(stock.onHand).toBe(5);
  });

  test("the invariant holds after every operation, in every order", () => {
    let stock = StockLevel.create("KNT-TEE", 10);
    stock = stock.reserve(4);
    stock = stock.receive(6);
    stock = stock.commit(4);
    stock = stock.reserve(3);
    stock = stock.release(3);
    stock = stock.adjustToCounted(9);

    expect(stock.reserved).toBeLessThanOrEqual(stock.onHand);
    expect(stock.available).toBe(9);
  });
});

describe("reserve", () => {
  test("does not reduce on-hand, because the units are still on the shelf", () => {
    // Removing them here would make release impossible to implement: a cancelled order
    // would have to invent stock that never physically left.
    const stock = StockLevel.create("KNT-TEE", 10, 0).reserve(3);
    expect(stock.onHand).toBe(10);
    expect(stock.reserved).toBe(3);
  });

  test("refuses to over-reserve, and says how much is actually available", () => {
    const stock = StockLevel.create("KNT-TEE", 10, 8);
    expect(stock.canSatisfy(2)).toBe(true);
    expect(stock.canSatisfy(3)).toBe(false);

    try {
      stock.reserve(3);
      throw new Error("expected a ConflictError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      // The details are what let the routing phase decide "try another warehouse" without
      // re-querying: the shortfall is already computed.
      expect((error as ConflictError).details).toEqual({ sku: "KNT-TEE", requested: 3, available: 2, onHand: 10, reserved: 8 });
    }
  });

  test("reports insufficient stock as a conflict, not a validation failure", () => {
    // The distinction is diagnostic: "wait for a restock" versus "fix the request".
    try {
      StockLevel.create("KNT-TEE", 1).reserve(5);
    } catch (error) {
      expect((error as ConflictError).code).toBe("CONFLICT");
      expect((error as ConflictError).code).not.toBe("VALIDATION_FAILED");
      expect((error as ConflictError).retryable).toBe(false);
    }
  });
});

describe("release and commit", () => {
  test("release returns a promise without inventing stock", () => {
    const stock = StockLevel.create("KNT-TEE", 10, 6).release(6);
    expect(stock.reserved).toBe(0);
    expect(stock.onHand).toBe(10);
    expect(stock.available).toBe(10);
  });

  test("commit consumes both counters together, which keeps the invariant true by construction", () => {
    const stock = StockLevel.create("KNT-TEE", 10, 6).commit(4);
    expect(stock.onHand).toBe(6);
    expect(stock.reserved).toBe(2);
    expect(stock.available).toBe(4);
  });

  test("refuses to release or commit more than is reserved rather than clamping", () => {
    // Clamping would let the caller's bookkeeping disagree with the database's without
    // anyone finding out until it produced phantom availability.
    const stock = StockLevel.create("KNT-TEE", 10, 2);
    expect(() => stock.release(3)).toThrow(ConflictError);
    expect(() => stock.commit(3)).toThrow(ConflictError);
  });
});

describe("a stock count can be corrected but not below what is promised", () => {
  test("adjustToCounted moves on-hand and keeps reservations intact", () => {
    const stock = StockLevel.create("KNT-TEE", 10, 3).adjustToCounted(7);
    expect(stock.onHand).toBe(7);
    expect(stock.reserved).toBe(3);
    expect(stock.available).toBe(4);
  });

  test("refuses a count that would invalidate promised stock", () => {
    // Finding 2 units when 3 are already reserved against open orders is a real situation,
    // and it needs a human. Silently dropping the reservation would oversell.
    expect(() => StockLevel.create("KNT-TEE", 10, 3).adjustToCounted(2)).toThrow(ConflictError);
  });
});

describe("quantities are validated everywhere", () => {
  test("rejects negatives, fractions, and non-integers", () => {
    const stock = StockLevel.create("KNT-TEE", 10);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => stock.reserve(bad)).toThrow(ValidationFailedError);
      expect(() => stock.receive(bad)).toThrow(ValidationFailedError);
    }
  });

  test("rejects an initial state where reserved exceeds on-hand", () => {
    expect(() => StockLevel.create("KNT-TEE", 5, 6)).toThrow("cannot exceed on-hand");
  });
});

describe("basket coverage", () => {
  const requirements = new Map([
    ["KNT-TEE", 3],
    ["KNT-CAP", 1],
  ]);

  test("a fully stocked location satisfies the basket", () => {
    const stock = new Map([
      ["KNT-TEE", StockLevel.create("KNT-TEE", 10, 5)],
      ["KNT-CAP", StockLevel.create("KNT-CAP", 2, 1)],
    ]);
    expect(canFulfilAll(requirements, stock)).toBe(true);
    expect(findShortfall(requirements, stock).size).toBe(0);
  });

  test("reports which sku is short and by how much, not just that something is", () => {
    // A boolean would force the routing phase to re-check and re-report to build the
    // exception, and the two answers would eventually disagree.
    const stock = new Map([
      ["KNT-TEE", StockLevel.create("KNT-TEE", 10, 9)],
      ["KNT-CAP", StockLevel.create("KNT-CAP", 1, 1)],
    ]);
    const shortfall = findShortfall(requirements, stock);

    expect(canFulfilAll(requirements, stock)).toBe(false);
    expect(shortfall.get("KNT-TEE")).toBe(2);
    expect(shortfall.get("KNT-CAP")).toBe(1);
  });

  test("a sku the location does not stock at all is short in full, not treated as zero-ish", () => {
    const stock = new Map([["KNT-TEE", StockLevel.create("KNT-TEE", 10)]]);
    expect(findShortfall(requirements, stock).get("KNT-CAP")).toBe(1);
  });

  test("reserved stock does not count towards coverage", () => {
    const stock = new Map([
      ["KNT-TEE", StockLevel.create("KNT-TEE", 3, 3)],
      ["KNT-CAP", StockLevel.create("KNT-CAP", 1, 0)],
    ]);
    expect(canFulfilAll(requirements, stock)).toBe(false);
  });

  test("an empty requirement is trivially satisfiable", () => {
    expect(canFulfilAll(new Map(), new Map())).toBe(true);
    expect(findShortfall(new Map(), new Map()).size).toBe(0);
  });
});
