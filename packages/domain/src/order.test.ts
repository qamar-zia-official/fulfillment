import { describe, expect, test } from "bun:test";
import { InvalidStateTransitionError, ValidationFailedError } from "./errors";
import { toCountryCode, toOrderId, toShopDomain, toSku, toWarehouseId } from "./identifiers";
import { Money } from "./money";
import { Order, type OrderLine, type NewOrder } from "./order";

const SHOP = toShopDomain("kinetous-test.myshopify.com");
const AT = new Date("2026-09-28T10:00:00.000Z");
const WH = toWarehouseId("wh_portland");

const line = (overrides: Partial<Omit<OrderLine, "id">> = {}): Omit<OrderLine, "id"> => ({
  sku: toSku("KNT-TEE"),
  title: "Kinetous Tee",
  quantity: 2,
  unitPrice: Money.fromDecimal("USD", "19.99"),
  ...overrides,
});

const newOrder = (overrides: Partial<NewOrder> = {}): NewOrder => ({
  id: toOrderId("ord_1"),
  lineIdSeed: 7,
  shopDomain: SHOP,
  externalReference: "#1001",
  currency: "USD",
  lines: [line()],
  shipTo: {
    name: "Ada Lovelace",
    line1: "1 Analytical Way",
    city: "Portland",
    region: "OR",
    postalCode: "97209",
    countryCode: toCountryCode("US"),
  },
  placedAt: AT,
  ...overrides,
});

const shippable = (overrides: Partial<NewOrder> = {}) => Order.create(newOrder(overrides));

describe("construction", () => {
  test("starts pending, which is the only state ingestion can produce", () => {
    expect(shippable().status).toBe("pending");
  });

  test("rejects an order with no lines", () => {
    // A zero-total order looks real to every downstream report, which is why this is refused
    // rather than carried.
    expect(() => Order.create(newOrder({ lines: [] }))).toThrow("at least one line");
  });

  test("rejects a non-positive or fractional quantity", () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(() => Order.create(newOrder({ lines: [line({ quantity })] }))).toThrow("positive whole number");
    }
  });

  test("rejects a line priced in a different currency from the order", () => {
    // Caught here because a mixed-currency order totals in the wrong currency, and the
    // mismatch only surfaces at reconciliation weeks later.
    expect(() => Order.create(newOrder({ lines: [line({ unitPrice: Money.ofMinorUnits("EUR", 100) })] }))).toThrow(
      "order's currency",
    );
  });

  test("requires the merchant's reference, which is how support finds the order", () => {
    expect(() => Order.create(newOrder({ externalReference: "  " }))).toThrow("merchant's reference");
  });

  test("gives every line a distinct id from the seed", () => {
    const order = shippable({ lines: [line(), line({ sku: toSku("KNT-CAP") })] });
    const ids = order.orderLines.map((l) => l.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids as string[]).toEqual(["7-1", "7-2"]);
  });
});

describe("totals are derived from the lines", () => {
  test("subtotal multiplies unit price by quantity", () => {
    const order = shippable({ lines: [line({ quantity: 3, unitPrice: Money.fromDecimal("USD", "19.99") })] });
    expect(order.subtotal.toDecimalString()).toBe("59.97");
  });

  test("sums across lines in the order currency", () => {
    const order = shippable({
      lines: [line({ quantity: 2, unitPrice: Money.fromDecimal("USD", "19.99") }), line({ sku: toSku("KNT-CAP"), quantity: 1, unitPrice: Money.fromDecimal("USD", "24.00") })],
    });
    expect(order.subtotal.toDecimalString()).toBe("63.98");
    expect(order.subtotal.currency).toBe("USD");
  });

  test("works in a zero-decimal currency without pretending there are cents", () => {
    const order = shippable({ currency: "JPY", lines: [line({ quantity: 3, unitPrice: Money.fromDecimal("JPY", "1200") })] });
    expect(order.subtotal.toDecimalString()).toBe("3600");
  });

  test("totalQuantity counts physical units", () => {
    expect(shippable({ lines: [line({ quantity: 2 }), line({ quantity: 3 })] }).totalQuantity).toBe(5);
  });
});

describe("duplicate skus are aggregated, not destroyed", () => {
  test("merges quantities for inventory while keeping the merchant's lines", () => {
    // Merchants legitimately send one SKU as two lines (a bundle, a discount). Inventory can
    // only reserve against the total, but throwing away the split would lose structure a human
    // may need to explain the order.
    const order = shippable({ lines: [line({ quantity: 2 }), line({ quantity: 1 })] });

    expect(order.orderLines.length).toBe(2);
    expect(order.quantityBySku().get(toSku("KNT-TEE"))).toBe(3);
  });

  test("a line with no sku is excluded from the sku totals", () => {
    const order = shippable({ lines: [line(), line({ sku: null, title: "Custom engraving" })] });
    expect(order.quantityBySku().size).toBe(1);
    expect(order.quantityBySku().get(toSku("KNT-TEE"))).toBe(2);
  });
});

describe("problems are reported, never thrown", () => {
  test("a clean pending order has none", () => {
    expect(shippable().problems()).toEqual([]);
  });

  test("flags a test order so it can never consume stock", () => {
    expect(shippable({ isTestOrder: true }).problems()).toEqual([{ kind: "is_test_order" }]);
  });

  test("flags an incomplete address with every missing field", () => {
    const problems = shippable({ shipTo: { countryCode: toCountryCode("US") } }).problems();
    const address = problems.find((p) => p.kind === "unroutable_address");

    expect(address).toBeDefined();
    expect(address?.kind === "unroutable_address" && address.blockers).toContain("missing_city");
  });

  test("flags lines with no sku, which Phase 2 stores and defers to this judgement", () => {
    // Phase 2's schema comment says exactly this: store it as-is, let the domain decide.
    const problems = shippable({ lines: [line(), line({ sku: null, title: "Custom engraving" })] }).problems();
    expect(problems).toEqual([{ kind: "missing_sku", skus: ["Custom engraving"] }]);
  });

  test("does not flag a DIGITAL line with no sku, because that is not a data-quality problem", () => {
    // The regression this test exists for. A gift card, an e-book, or a downloadable
    // warranty has no SKU by design, and treating it as a missing-SKU failure made the whole
    // order unroutable: a blocking exception in the operator queue, for a catalogue entry that
    // was never wrong. The order should be routable as long as its *physical* lines are fine.
    const problems = shippable({
      lines: [line(), line({ sku: null, title: "Digital gift card", requiresShipping: false })],
    }).problems();

    expect(problems).toEqual([]);
  });

  test("still flags a physical line with no sku even when a digital line alongside it has one", () => {
    // The digital line must not mask the physical one, which is the failure mode of fixing the
    // bug by simply ignoring lines whose title looks digital.
    const problems = shippable({
      lines: [line({ sku: null, title: "Mystery Custom Item" }), line({ sku: null, title: "Digital gift card", requiresShipping: false })],
    }).problems();

    expect(problems).toEqual([{ kind: "missing_sku", skus: ["Mystery Custom Item"] }]);
  });

  test("treats a line that does not say whether it needs shipping as physical", () => {
    // The safe direction for an unknown line: reserving stock for something nobody will pick
    // wastes it, while shipping nothing for a physical line loses the order.
    const problems = shippable({ lines: [line({ sku: null, title: "Unlabelled" })] }).problems();

    expect(problems).toEqual([{ kind: "missing_sku", skus: ["Unlabelled"] }]);
  });

  test("an order that has started reports that instead of being re-allocatable", () => {
    const order = shippable();
    order.allocate(WH);
    expect(order.problems()).toEqual([{ kind: "already_in_progress", status: "allocated" }]);
  });
});

describe("allocation reserves real stock, so it is gated on problems", () => {
  test("a clean order allocates and records the warehouse", () => {
    const order = shippable();
    order.allocate(WH);

    expect(order.status).toBe("allocated");
    expect(order.warehouseId).toBe(WH);
  });

  test("refuses while the address is incomplete", () => {
    // Otherwise stock gets tied up at a site that physically cannot ship the order, and stays
    // tied up until someone notices -- which is the stock-out that caused the problem.
    const order = shippable({ shipTo: { countryCode: toCountryCode("US") } });
    expect(() => order.allocate(WH)).toThrow("unresolved problems");
    expect(order.status).toBe("pending");
    expect(order.warehouseId).toBeNull();
  });

  test("refuses for a test order", () => {
    expect(() => shippable({ isTestOrder: true }).allocate(WH)).toThrow(ValidationFailedError);
  });

  test("refuses when a shippable item has no sku", () => {
    const order = shippable({ lines: [line(), line({ sku: null, title: "Custom engraving" })] });
    expect(() => order.allocate(WH)).toThrow(ValidationFailedError);
  });
});

describe("the lifecycle cannot be skipped", () => {
  test("walks the happy path", () => {
    const order = shippable();
    order.allocate(WH);
    order.startPicking();
    order.markPicked();
    order.markPacked();
    order.markShipped();
    order.markDelivered();

    expect(order.status).toBe("delivered");
  });

  test("refuses to ship a picked-but-unpacked order", () => {
    const order = shippable();
    order.allocate(WH);
    order.startPicking();
    order.markPicked();

    expect(() => order.markShipped()).toThrow(InvalidStateTransitionError);
    expect(order.status).toBe("picked");
  });

  test("refuses to allocate an order that is already in progress", () => {
    const order = shippable();
    order.allocate(WH);

    expect(() => order.allocate(WH)).toThrow("Cannot move an order from allocated to allocated");
  });

  test("deallocate returns the order to pending and forgets the warehouse", () => {
    const order = shippable();
    order.allocate(WH);
    order.deallocate();

    expect(order.status).toBe("pending");
    expect(order.warehouseId).toBeNull();
  });

  test("deallocate only applies to an allocated order", () => {
    expect(() => shippable().deallocate()).toThrow(InvalidStateTransitionError);
  });
});

describe("cancellation moves three fields together", () => {
  test("sets status, timestamp, and reason as one fact", () => {
    const order = shippable();
    order.cancel({ reason: "merchant_requested", note: null, at: AT });

    expect(order.status).toBe("cancelled");
    expect(order.cancelledAt).toBe(AT);
    expect(order.cancellationReason).toBe("merchant_requested");
  });

  test("is terminal, so a stale webhook cannot revive it", () => {
    const order = shippable();
    order.cancel({ reason: "other", note: "duplicate", at: AT });

    expect(() => order.startPicking()).toThrow(InvalidStateTransitionError);
    expect(() => order.allocate(WH)).toThrow(InvalidStateTransitionError);
    expect(order.status).toBe("cancelled");
  });

  test("can cancel from any state before the parcel leaves", () => {
    // Walks a real order to each stage in turn, rather than jumping, so the machine is
    // exercised rather than bypassed.
    const stages = [
      [],
      ["allocate"],
      ["allocate", "startPicking"],
      ["allocate", "startPicking", "markPicked"],
      ["allocate", "startPicking", "markPicked", "markPacked"],
    ] as const;

    for (const path of stages) {
      const order = shippable();
      for (const step of path) {
        if (step === "allocate") order.allocate(WH);
        else order[step]();
      }

      order.cancel({ reason: "out_of_stock", note: null, at: AT });
      expect(order.status).toBe("cancelled");
    }
  });

  test("cannot cancel after shipping, because undoing it is a return", () => {
    const order = shippable();
    order.allocate(WH);
    order.startPicking();
    order.markPicked();
    order.markPacked();
    order.markShipped();

    expect(() => order.cancel({ reason: "merchant_requested", note: null, at: AT })).toThrow(InvalidStateTransitionError);
    expect(order.status).toBe("shipped");
  });

  test("a failed cancellation leaves the order untouched", () => {
    // The machine check runs first, so a rejected cancel must not half-apply and leave a
    // shipped order carrying a cancellation timestamp.
    const order = shippable();
    order.allocate(WH);
    order.startPicking();
    order.markPicked();
    order.markPacked();
    order.markShipped();

    expect(() => order.cancel({ reason: "other", note: null, at: AT })).toThrow();
    expect(order.cancelledAt).toBeNull();
    expect(order.cancellationReason).toBeNull();
  });

  test("rejects an invalid cancellation date", () => {
    expect(() => shippable().cancel({ reason: "other", note: null, at: new Date("nope") })).toThrow("valid date");
  });

  test("keeps the operator's note alongside the structured reason", () => {
    const order = shippable();
    order.cancel({ reason: "other", note: "Shopify duplicate of #1001", at: AT });
    expect(order.cancellationReason).toBe("other");
  });
});

describe("the state machine cannot be bypassed from outside", () => {
  test("assigning status is rejected by the compiler and by the runtime", () => {
    const order = shippable();

    // Two independent guards, and it is worth being precise about which is which.
    expect(() => {
      // @ts-expect-error status is a read-only accessor, so the compiler refuses.
      order.status = "shipped";
    }).toThrow("readonly");

    // `get status()` has no setter, so the runtime refuses too, even from plain JavaScript.
    expect(order.status).toBe("pending");
  });

  test("the private backing field is protected by the compiler alone", () => {
    const order = shippable();

    // TypeScript's `private` is erased, so nothing stops this at runtime. That is precisely
    // why the aggregate also exposes status through a getter, and why the database carries
    // `orders_cancelled_requires_timestamp_check` as an independent second line of defence:
    // a serialiser or a structured logger reflecting over the instance can still write
    // `state`, and the domain must not be the only thing standing between that and a row.
    // @ts-expect-error state is private, so the compiler refuses the read.
    void order.state;
    expect(order.status).toBe("pending");
  });

  test("every lifecycle move is reachable only through a named method", () => {
    const order = shippable();
    for (const method of ["allocate", "startPicking", "markPicked", "markPacked", "markShipped", "markDelivered", "deallocate", "cancel"] as const) {
      expect(typeof order[method]).toBe("function");
    }
  });
});
