import { describe, expect, test } from "bun:test";
import { ValidationFailedError } from "./errors";
import { toCountryCode, toOrderId } from "./identifiers";
import { classifyShippability } from "./address";
import {
  FULFILLMENT_EXCEPTION_TYPES,
  addressBlockersOf,
  blocksFulfillment,
  closeException,
  createFulfillmentException,
  exceptionForShortfall,
  exceptionForShippability,
} from "./exceptions";
import { findShortfall, StockLevel } from "./stock";

const ORDER = toOrderId("ord_1");
const AT = new Date("2026-09-28T10:00:00.000Z");
const ACTOR = "ops@kinetous.test";

describe("severity is a property of the situation, not of who noticed it", () => {
  test("an order that cannot be routed is blocking", () => {
    const exception = createFulfillmentException({ orderId: ORDER, type: "unroutable_no_warehouse", reason: "no warehouse serves IE", createdAt: AT });
    expect(exception.severity).toBe("blocking");
    expect(blocksFulfillment(exception)).toBe(true);
  });

  test("a carrier hiccup is a warning, so the order keeps moving", () => {
    const exception = createFulfillmentException({ orderId: ORDER, type: "carrier_error", reason: "carrier 503", createdAt: AT });
    expect(exception.severity).toBe("warning");
    expect(blocksFulfillment(exception)).toBe(false);
  });

  test("every declared type has a severity, so no type can be unhandled", () => {
    for (const type of FULFILLMENT_EXCEPTION_TYPES) {
      const exception = createFulfillmentException({ orderId: ORDER, type, reason: "because", createdAt: AT });
      expect(["blocking", "warning"]).toContain(exception.severity);
    }
  });

  test("a warning can be escalated when the caller has evidence the order cannot proceed", () => {
    const exception = createFulfillmentException({
      orderId: ORDER,
      type: "carrier_error",
      reason: "carrier rejected the label as undeliverable",
      createdAt: AT,
      severity: "blocking",
    });
    expect(blocksFulfillment(exception)).toBe(true);
  });
});

describe("an exception with no reason is worse than none at all", () => {
  test("a blank reason is rejected", () => {
    // A record in the exceptions queue with nothing to act on looks like work already triaged.
    expect(() => createFulfillmentException({ orderId: ORDER, type: "unroutable_no_warehouse", reason: "   ", createdAt: AT })).toThrow(
      "must carry a reason",
    );
  });

  test("an unknown type is rejected rather than stored as free text", () => {
    expect(() => createFulfillmentException({ orderId: ORDER, type: "wat" as never, reason: "x", createdAt: AT })).toThrow(
      ValidationFailedError,
    );
  });

  test("an invalid date is rejected, so createdAt is always sortable", () => {
    expect(() => createFulfillmentException({ orderId: ORDER, type: "carrier_error", reason: "x", createdAt: new Date("nope") })).toThrow(
      "valid date",
    );
  });
});

describe("closing an exception leaves an audit trail", () => {
  const open = () => createFulfillmentException({ orderId: ORDER, type: "unroutable_no_warehouse", reason: "no warehouse", createdAt: AT });

  test("records who closed it, why, and when", () => {
    const closed = closeException(open(), { status: "resolved", actor: ACTOR, note: "added a Dublin 3PL", at: new Date("2026-09-28T11:00:00Z") });

    expect(closed.status).toBe("resolved");
    expect(closed.resolvedBy).toBe(ACTOR);
    expect(closed.resolutionNote).toBe("added a Dublin 3PL");
    expect(closed.resolvedAt?.toISOString()).toBe("2026-09-28T11:00:00.000Z");
  });

  test("a resolved exception stops blocking, or the order is wedged forever", () => {
    // Both halves of this check have to agree: severity alone would block forever once
    // something is resolved, which is the single most likely way this design goes wrong.
    const closed = closeException(open(), { status: "resolved", actor: ACTOR, note: "resolved", at: AT });
    expect(closed.severity).toBe("blocking");
    expect(closed.status).toBe("resolved");
    expect(blocksFulfillment(closed)).toBe(false);
  });

  test("ignored is distinguishable from resolved, so shipping anyway is recorded as a decision", () => {
    const closed = closeException(open(), { status: "ignored", actor: ACTOR, note: "merchant agreed to ship anyway", at: AT });
    expect(closed.status).toBe("ignored");
    expect(blocksFulfillment(closed)).toBe(false);
  });

  test("demands an actor and a note", () => {
    expect(() => closeException(open(), { status: "resolved", actor: " ", note: "why", at: AT })).toThrow("who closed it");
    expect(() => closeException(open(), { status: "resolved", actor: ACTOR, note: " ", at: AT })).toThrow("why");
  });

  test("refuses to close twice, so the audit trail cannot be overwritten", () => {
    const closed = closeException(open(), { status: "resolved", actor: ACTOR, note: "first", at: AT });
    expect(() => closeException(closed, { status: "resolved", actor: ACTOR, note: "second", at: AT })).toThrow("already resolved");
  });
});

describe("an address verdict becomes the exception Phase 2 promised", () => {
  test("a complete address produces no exception", () => {
    const good = { name: "A", line1: "1 St", city: "Cork", countryCode: toCountryCode("IE") };
    expect(exceptionForShippability(ORDER, classifyShippability(good), AT)).toBeNull();
  });

  test("an incomplete address produces a blocking exception carrying every blocker", () => {
    const bad = { countryCode: toCountryCode("US") };
    const exception = exceptionForShippability(ORDER, classifyShippability(bad), AT);

    expect(exception?.type).toBe("unroutable_incomplete_address");
    expect(blocksFulfillment(exception!)).toBe(true);
    expect(addressBlockersOf(exception!)).toEqual([
      "missing_recipient_name",
      "missing_street_line",
      "missing_city",
      "missing_region",
      "missing_postal_code",
    ]);
  });

  test("the reason names the blockers, so the queue is readable without opening a record", () => {
    const exception = exceptionForShippability(ORDER, classifyShippability({ countryCode: toCountryCode("US") }), AT);
    expect(exception?.reason).toContain("missing_city");
  });
});

describe("a stock shortfall becomes an exception", () => {
  test("no shortfall produces no exception rather than an empty record", () => {
    // An exception with nothing in it is a queue entry nobody can action.
    expect(exceptionForShortfall(ORDER, findShortfall(new Map([["KNT-TEE", 1]]), new Map([["KNT-TEE", StockLevel.create("KNT-TEE", 5)]])), AT)).toBeNull();
    expect(exceptionForShortfall(ORDER, new Map(), AT)).toBeNull();
  });

  test("a shortfall names each sku and by how much", () => {
    const requirements = new Map([
      ["KNT-TEE", 5],
      ["KNT-CAP", 2],
    ]);
    const stock = new Map([
      ["KNT-TEE", StockLevel.create("KNT-TEE", 3)],
      ["KNT-CAP", StockLevel.create("KNT-CAP", 0)],
    ]);
    const exception = exceptionForShortfall(ORDER, findShortfall(requirements, stock), AT);

    expect(exception?.type).toBe("unroutable_insufficient_stock");
    expect(exception?.reason).toContain("KNT-TEE short by 2");
    expect(exception?.reason).toContain("KNT-CAP short by 2");
    expect(exception?.details).toEqual({ shortfall: { "KNT-TEE": 2, "KNT-CAP": 2 } });
  });
});
