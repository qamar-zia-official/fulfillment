import { describe, expect, test } from "bun:test";
import { InvalidStateTransitionError } from "./errors";
import {
  ORDER_STATUSES,
  assertOrderStatus,
  assertTransition,
  canTransition,
  isCancellable,
  isOrderStatus,
  isTerminalStatus,
  nextStatuses,
} from "./order-status";

describe("the transition table is the single source of truth", () => {
  test("the happy path walks forward one step at a time", () => {
    const happyPath = ["pending", "allocated", "picking", "picked", "packed", "shipped", "delivered"] as const;

    for (let i = 0; i < happyPath.length - 1; i += 1) {
      const from = happyPath[i]!;
      const to = happyPath[i + 1]!;
      expect(canTransition(from, to)).toBe(true);
    }
  });

  test("no status skips a step, which is how a package ends up shipped but never packed", () => {
    expect(canTransition("pending", "shipped")).toBe(false);
    expect(canTransition("picking", "packed")).toBe(false);
    expect(canTransition("allocated", "shipped")).toBe(false);
  });

  test("a status never transitions to itself", () => {
    // Self-transitions look harmless and hide bugs: a repeated "pack" event silently
    // succeeds instead of revealing that the scanner is replaying.
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  test("every status appears in the table exactly once", () => {
    // Guards the failure mode where a new status is added to ORDER_STATUSES and the table
    // is not updated -- which TypeScript would not catch, since the table is a Record.
    const covered = new Set(ORDER_STATUSES.flatMap((status) => nextStatuses(status)));
    expect([...covered].sort()).toEqual([...ORDER_STATUSES].sort());
  });
});

describe("cancellation", () => {
  test("is reachable from every state before the parcel leaves the building", () => {
    for (const status of ["pending", "allocated", "picking", "picked", "packed"] as const) {
      expect(canTransition(status, "cancelled")).toBe(true);
      expect(isCancellable(status)).toBe(true);
    }
  });

  test("is impossible once shipped, because undoing it is a return not a cancellation", () => {
    expect(canTransition("shipped", "cancelled")).toBe(false);
    expect(canTransition("delivered", "cancelled")).toBe(false);
    expect(isCancellable("shipped")).toBe(false);
  });

  test("is terminal and not escapable, matching the database CHECK from Phase 2", () => {
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(nextStatuses("cancelled")).toEqual([]);
    expect(() => assertTransition("cancelled", "pending")).toThrow(InvalidStateTransitionError);
  });

  test("a stale update webhook cannot resurrect a cancelled order", () => {
    // This is the exact scenario the SQL check constraint was written for.
    expect(canTransition("cancelled", "picking")).toBe(false);
  });
});

describe("deallocation is the one backwards edge", () => {
  test("an allocated order can return to pending for re-routing", () => {
    expect(canTransition("allocated", "pending")).toBe(true);
  });

  test("nothing else can skip backwards", () => {
    expect(canTransition("picking", "pending")).toBe(false);
    expect(canTransition("picked", "allocated")).toBe(false);
    expect(canTransition("packed", "picked")).toBe(false);
  });
});

describe("assertTransition reports what was actually allowed", () => {
  test("lists the legal moves so the caller is not left guessing", () => {
    expect(() => assertTransition("pending", "delivered")).toThrow("Allowed: allocated, cancelled");

    try {
      assertTransition("pending", "delivered");
    } catch (error) {
      expect((error as InvalidStateTransitionError).code).toBe("INVALID_STATE_TRANSITION");
      expect((error as InvalidStateTransitionError).details).toEqual({
        from: "pending",
        to: "delivered",
        allowed: ["allocated", "cancelled"],
      });
    }
  });

  test("says so plainly when there are no legal moves at all", () => {
    expect(() => assertTransition("delivered", "pending")).toThrow("accepts no further transitions");
  });

  test("is distinguishable from a validation failure", () => {
    // Different code, different investigation. This is a conflict between two correct
    // actors, not a malformed request.
    try {
      assertTransition("shipped", "cancelled");
    } catch (error) {
      expect((error as InvalidStateTransitionError).code).not.toBe("VALIDATION_FAILED");
    }
  });
});

describe("status guards", () => {
  test("isOrderStatus narrows known values and rejects everything else", () => {
    expect(isOrderStatus("pending")).toBe(true);
    for (const bad of ["PENDING", "awaiting_payment", "", null, 7, undefined]) {
      expect(isOrderStatus(bad)).toBe(false);
    }
  });

  test("assertOrderStatus refuses a status it does not recognise", () => {
    // orders.status is free text by design, so this gate is what keeps a typo from
    // becoming a row no query knows how to interpret.
    expect(() => assertOrderStatus("awaiting_payment")).toThrow("Unknown order status");
    expect(assertOrderStatus("picked")).toBe("picked");
  });
});

/**
 * The database CHECK constraint added alongside this machine must accept exactly this list.
 * When that constraint is added to `orders.status`, assert it against this array rather than
 * retyping the values -- two hand-maintained lists drift, and the drift is silent until an
 * order cannot be written at all.
 */
describe("the set of statuses the database will need to accept", () => {
  test("is exactly ORDER_STATUSES", () => {
    expect([...ORDER_STATUSES]).toEqual([
      "pending",
      "allocated",
      "picking",
      "picked",
      "packed",
      "shipped",
      "delivered",
      "cancelled",
    ]);
  });
});
