import { describe, expect, test } from "bun:test";
import { type Sku, toCountryCode, toSku, toWarehouseId } from "./identifiers";
import { StockLevel } from "./stock";
import { type WarehouseCandidate, selectWarehouse } from "./routing";

const US = toCountryCode("US");
const DE = toCountryCode("DE");
const tee = toSku("KNT-TEE");
const cap = toSku("KNT-CAP");
const hat = toSku("KNT-HAT");

type Counts = Record<string, number>;

/**
 * Builds a stock map from on-hand and reserved counts.
 *
 * The two are keyed separately and unioned. Merging them into one object first would let a
 * reserved value silently overwrite the matching on-hand value, so `stockAt({TEE: 10}, {TEE: 3})`
 * would quietly describe 3 on hand rather than 10.
 */
const stockAt = (onHand: Counts, reserved: Counts = {}) => {
  const skus = new Set([...Object.keys(onHand), ...Object.keys(reserved)]);
  return new Map(
    [...skus].map((sku) => [toSku(sku), StockLevel.create(sku, onHand[sku] ?? 0, reserved[sku] ?? 0)]),
  );
};

const site = (id: string, countries: readonly string[], stock: ReturnType<typeof stockAt>, priority = 10): WarehouseCandidate => ({
  warehouseId: toWarehouseId(id),
  routes: countries.map((code) => ({ countryCode: toCountryCode(code), priority })),
  stock,
});

/** `basket("KNT-TEE", 2, "KNT-CAP", 1)` -- flat pairs, which reads better at call sites than tuples. */
const basket = (...entries: (string | number)[]): Map<Sku, number> => {
  const result = new Map<Sku, number>();
  for (let index = 0; index < entries.length; index += 2) {
    result.set(toSku(entries[index] as string), entries[index + 1] as number);
  }
  return result;
};

describe("an order that is not a candidate is never routed", () => {
  const candidates = [site("wh_portland", ["US"], stockAt({ [tee]: 100 }))];

  test("refuses a test order, missing SKU, or incomplete address", () => {
    // Rule 1 is checked before any warehouse is considered: searching harder cannot fix a
    // problem in the order, and reserving stock for an order that can never ship is how you
    // cause the stock-out you were trying to prevent.
    expect(selectWarehouse({ countryCode: US, requirements: basket("KNT-TEE", 1), candidates, orderIsRoutable: false })).toEqual({
      outcome: "unroutable",
      reason: "order_not_routable",
    });
  });

  test("reports the order as the cause even when a warehouse has plenty of stock", () => {
    // The reason an operator gets must be the order, not the stock. Blaming stock here
    // sends them to reorder a product that was never the problem.
    const decision = selectWarehouse({
      countryCode: US,
      requirements: basket("KNT-TEE", 1),
      candidates: [site("wh_portland", ["US"], stockAt({ [tee]: 10_000 }))],
      orderIsRoutable: false,
    });
    expect(decision.outcome === "unroutable" && decision.reason).toBe("order_not_routable");
  });
});

describe("country is a hard filter, not a preference", () => {
  test("refuses when no site is responsible for the destination", () => {
    const decision = selectWarehouse({
      countryCode: toCountryCode("JP"),
      requirements: basket("KNT-TEE", 1),
      candidates: [site("wh_portland", ["US"], stockAt({ [tee]: 100 }))],
      orderIsRoutable: true,
    });
    expect(decision).toEqual({ outcome: "unroutable", reason: "no_warehouse_for_country" });
  });

  test("a nearer site with stock loses to a site that actually serves the country", () => {
    // A German warehouse holding more stock must not be chosen for a US order. Cross-border
    // fulfilment is a business decision with customs and cost attached, not a fallback.
    const decision = selectWarehouse({
      countryCode: US,
      requirements: basket("KNT-TEE", 1),
      candidates: [site("wh_berlin", ["DE"], stockAt({ [tee]: 10_000 }), 1), site("wh_portland", ["US"], stockAt({ [tee]: 1 }))],
      orderIsRoutable: true,
    });
    expect(decision.outcome === "routed" && decision.warehouseId).toBe(toWarehouseId("wh_portland"));
  });

  test("a missing destination country is unroutable rather than a crash", () => {
    expect(selectWarehouse({ countryCode: null, requirements: basket("KNT-TEE", 1), candidates: [], orderIsRoutable: true })).toEqual({
      outcome: "unroutable",
      reason: "no_warehouse_for_country",
    });
  });
});

describe("one site must cover the whole basket", () => {
  test("falls through to the next site when the first cannot cover it", () => {
    // The bug this guards: returning on the first eligible site with a shortfall, which
    // makes rule 3 a no-op and strands every order the preferred site cannot fully serve.
    const decision = selectWarehouse({
      countryCode: US,
      requirements: basket("KNT-TEE", 2, "KNT-CAP", 1),
      candidates: [
        site("wh_portland", ["US"], stockAt({ [tee]: 99, [cap]: 0 }), 1),
        site("wh_reno", ["US"], stockAt({ [tee]: 50, [cap]: 20 }), 2),
      ],
      orderIsRoutable: true,
    });

    expect(decision.outcome).toBe("routed");
    expect(decision.outcome === "routed" && decision.warehouseId).toBe(toWarehouseId("wh_reno"));
  });

  test("never splits an order across two sites, even when that would be the only way", () => {
    // Two labels, two carriers, two delivery windows, and a customer receiving half an order
    // a month apart. A legitimate strategy, but one to choose on purpose.
    //
    // Portland (priority 1) has only the tees and Reno (priority 2) only the caps, so the
    // only way to fulfil is to split. Reported shortfall is Portland's gap, because that is
    // the site we would otherwise have used.
    const decision = selectWarehouse({
      countryCode: US,
      requirements: basket("KNT-TEE", 5, "KNT-CAP", 5),
      candidates: [
        site("wh_portland", ["US"], stockAt({ [tee]: 5 }), 1),
        site("wh_reno", ["US"], stockAt({ [cap]: 5 }), 2),
      ],
      orderIsRoutable: true,
    });

    expect(decision).toEqual({
      outcome: "unroutable",
      reason: "insufficient_stock",
      shortfall: new Map([[cap, 5]]),
    });
  });

  test("a SKU the site does not stock at all is short in full", () => {
    const decision = selectWarehouse({
      countryCode: US,
      requirements: basket("KNT-HAT", 2),
      candidates: [site("wh_portland", ["US"], stockAt({ [tee]: 100 }))],
      orderIsRoutable: true,
    });
    expect(decision.outcome === "unroutable" && decision.shortfall?.get(hat)).toBe(2);
  });

  test("already-reserved stock does not count as coverable", () => {
    const decision = selectWarehouse({
      countryCode: US,
      requirements: basket("KNT-TEE", 3),
      candidates: [site("wh_portland", ["US"], stockAt({ [tee]: 3 }, { [tee]: 3 }))],
      orderIsRoutable: true,
    });
    expect(decision.outcome).toBe("unroutable");
  });
});

describe("the shortfall reported is the best-ranked site's, not the last one checked", () => {
  test("names what the site we wanted was missing", () => {
    // An exception saying "short by 1" when the preferred site is short by 40 sends the
    // operator to reorder the wrong quantity.
    const decision = selectWarehouse({
      countryCode: US,
      requirements: basket("KNT-TEE", 50),
      candidates: [
        site("wh_portland", ["US"], stockAt({ [tee]: 10 }), 1),
        site("wh_reno", ["US"], stockAt({ [tee]: 0 }), 2),
      ],
      orderIsRoutable: true,
    });

    expect(decision).toEqual({ outcome: "unroutable", reason: "insufficient_stock", shortfall: new Map([[tee, 40]]) });
  });
});

describe("ranking is by declared priority, then by id", () => {
  test("lower priority number wins", () => {
    const decision = selectWarehouse({
      countryCode: US,
      requirements: basket("KNT-TEE", 1),
      candidates: [site("wh_far", ["US"], stockAt({ [tee]: 10 }), 50), site("wh_near", ["US"], stockAt({ [tee]: 10 }), 1)],
      orderIsRoutable: true,
    });
    expect(decision.outcome === "routed" && decision.warehouseId).toBe(toWarehouseId("wh_near"));
  });

  test("priority is per country, not per site", () => {
    // A hub is far from one country and near another. A single per-site number cannot
    // express that and would make one of the two routings wrong.
    const hub: WarehouseCandidate = {
      warehouseId: toWarehouseId("wh_hub"),
      routes: [
        { countryCode: US, priority: 90 },
        { countryCode: DE, priority: 1 },
      ],
      stock: stockAt({ [tee]: 10 }),
    };

    const toGermany = selectWarehouse({ countryCode: DE, requirements: basket("KNT-TEE", 1), candidates: [hub], orderIsRoutable: true });
    const toUnitedStates = selectWarehouse({ countryCode: US, requirements: basket("KNT-TEE", 1), candidates: [hub], orderIsRoutable: true });

    expect(toGermany.outcome === "routed" && toGermany.warehouseId).toBe(toWarehouseId("wh_hub"));
    expect(toUnitedStates.outcome).toBe("routed");
  });

  test("ties break on id, so the same order always routes the same way", () => {
    // Without a total order, the winner depends on whatever order the database returned, and
    // "why did this go to Reno?" becomes unanswerable after a retry moves it.
    const first = selectWarehouse({
      countryCode: US,
      requirements: basket("KNT-TEE", 1),
      candidates: [site("wh_reno", ["US"], stockAt({ [tee]: 5 })), site("wh_portland", ["US"], stockAt({ [tee]: 5 }))],
      orderIsRoutable: true,
    });
    const second = selectWarehouse({
      countryCode: US,
      requirements: basket("KNT-TEE", 1),
      candidates: [site("wh_portland", ["US"], stockAt({ [tee]: 5 })), site("wh_reno", ["US"], stockAt({ [tee]: 5 }))],
      orderIsRoutable: true,
    });

    expect(first).toEqual(second);
    expect(first.outcome === "routed" && first.warehouseId).toBe(toWarehouseId("wh_portland"));
  });

  test("is stable across repeated evaluation, which is what makes it auditable", () => {
    const candidates = [
      site("wh_c", ["US"], stockAt({ [tee]: 1 })),
      site("wh_a", ["US"], stockAt({ [tee]: 1 })),
      site("wh_b", ["US"], stockAt({ [tee]: 1 })),
    ];
    const run = () =>
      JSON.stringify(selectWarehouse({ countryCode: US, requirements: basket("KNT-TEE", 1), candidates, orderIsRoutable: true }));

    expect(run()).toBe(run());
    expect(run()).toBe(run());
  });
});

describe("a routed decision states exactly what to reserve", () => {
  test("hands back the full requirement set, never a partial one", () => {
    const decision = selectWarehouse({
      countryCode: US,
      requirements: basket("KNT-TEE", 2, "KNT-CAP", 1),
      candidates: [site("wh_portland", ["US"], stockAt({ [tee]: 10, [cap]: 10 }))],
      orderIsRoutable: true,
    });

    expect(decision.outcome).toBe("routed");
    expect(decision.outcome === "routed" && [...decision.reservation]).toEqual([
      [tee, 2],
      [cap, 1],
    ]);
  });

  test("an empty requirement set does not crash, and reserves nothing", () => {
    // Unreachable in practice: `Order.create` refuses an order with no lines. Defensive only,
    // because a routing decision that throws on a degenerate input takes down the worker
    // rather than reporting the problem.
    const decision = selectWarehouse({
      countryCode: US,
      requirements: new Map(),
      candidates: [site("wh_portland", ["US"], stockAt({ [tee]: 10 }))],
      orderIsRoutable: true,
    });

    expect(decision.outcome === "routed" && [...decision.reservation]).toEqual([]);
  });
});
