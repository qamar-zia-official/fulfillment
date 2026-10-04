import { describe, expect, test } from "bun:test";
import { PersistenceError, toExceptionId, toWarehouseId } from "@repo/domain";
import { toOrderId } from "@repo/domain";
import { DEFAULT_ROUTING_BATCH_SIZE, routePendingOrders } from "./route-pending-orders";
import type { OrderRoutingRepository, RoutingOutcome } from "./order-routing";

/**
 * Batch-worker tests.
 *
 * The batching decision -- keep going when one order throws -- is the whole point of this file
 * and is not observable in a single-order test. The repository itself is covered against a
 * real database in `@repo/db`.
 */

/**
 * A stand-in that returns a scripted outcome or throw per order id.
 *
 * Scripted rather than generic because the behaviour under test is entirely about *which*
 * orders fail, and a fake that computed outcomes itself would be reimplementing the logic these
 * assertions are meant to check.
 */
/**
 * A script is either an outcome to return or an explicit instruction to throw.
 *
 * The throw is marked rather than inferred with `instanceof Error`, because inference gets it
 * exactly wrong for the case that matters: a thrown non-Error never matches, is silently
 * returned as if it were an outcome, and the failure path under test is never reached. That is
 * the same class of bug this suite exists to catch, so the fake does not get to commit it.
 */
type Script = RoutingOutcome | { throws: unknown };

const repositoryReturning = (scripts: Record<string, Script>) => {
  const listed = Object.keys(scripts);
  const routed: string[] = [];

  const repository: OrderRoutingRepository = {
    async listRoutableOrderIds() {
      return listed;
    },
    async routeOrder({ orderId }) {
      routed.push(orderId);
      const script = scripts[orderId];
      if (script === undefined) throw new Error(`No script for ${orderId}`);
      if ("throws" in script) throw script.throws;
      return script;
    },
  };

  // `routed` is returned alongside rather than bolted onto the repository object, so the port
  // interface stays exactly what production implements and nothing in this file can rely on a
  // field that no real repository has.
  return { repository, routed };
};

const allocated = (orderId: string): RoutingOutcome => ({
  outcome: "allocated",
  orderId: toOrderId(orderId),
  warehouseId: toWarehouseId("wh-1"),
  reserved: new Map(),
});

const unroutable = (orderId: string): RoutingOutcome => ({
  outcome: "unroutable",
  orderId: toOrderId(orderId),
  exception: {
    id: toExceptionId(`exc-${orderId}`),
    orderId: toOrderId(orderId),
    type: "unroutable_no_warehouse",
    severity: "blocking",
    status: "open",
    reason: "no site serves this country",
    details: {},
    createdAt: new Date("2026-09-28T10:00:00Z"),
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
  },
});

describe("routePendingOrders", () => {
  test("counts each outcome so a worker that stops routing is visible", async () => {
    const { repository } = repositoryReturning({
      "ord-1": allocated("ord-1"),
      "ord-2": unroutable("ord-2"),
      "ord-3": { outcome: "not_routable", orderId: toOrderId("ord-3") },
    });

    const result = await routePendingOrders(repository);

    expect(result).toMatchObject({ attempted: 3, allocated: 1, unroutable: 1, notRoutable: 1, failed: [] });
  });

  /**
   * The regression this file exists for.
   *
   * An order whose row is internally inconsistent throws on every single attempt. In a loop that
   * rethrows, that order occupies the head of the oldest-first queue permanently and every
   * order behind it is never routed -- with no error logged, while the shop keeps taking
   * orders. Fulfillment looks like it is working and is entirely broken.
   */
  test("keeps routing after an order throws, so one bad row cannot block the queue", async () => {
    const { repository } = repositoryReturning({
      "ord-poison": { throws: new PersistenceError("Order must carry a line with a title.") },
      "ord-after-1": allocated("ord-after-1"),
      "ord-after-2": allocated("ord-after-2"),
    });

    const result = await routePendingOrders(repository);

    // Both orders behind the failure were still routed.
    expect(result.allocated).toBe(2);
    expect(result.attempted).toBe(3);
    expect(result.failed).toEqual([{ orderId: "ord-poison", message: "Order must carry a line with a title." }]);
  });

  test("reports the failure rather than swallowing it, so the task can alert", async () => {
    // Isolation must not mean silence. A failure that is caught, dropped, and not reported is
    // worse than one that crashes, because it looks like success.
    const { repository } = repositoryReturning({ "ord-bad": { throws: new Error("connection terminated unexpectedly") } });

    const result = await routePendingOrders(repository);

    expect(result.failed).toEqual([{ orderId: "ord-bad", message: "connection terminated unexpectedly" }]);
    expect(result.allocated).toBe(0);
  });

  test("does not let a non-Error throw escape as [object Object]", async () => {
    const { repository } = repositoryReturning({ "ord-weird": { throws: "just a string" } });

    const result = await routePendingOrders(repository);

    expect(result.failed).toEqual([{ orderId: "ord-weird", message: "just a string" }]);
  });

  test("attempts every listed order in order", async () => {
    // Oldest-first ordering is the repository's contract; this asserts the use case does not
    // reorder or short-circuit, which would break the "backlog first" guarantee.
    const { repository, routed } = repositoryReturning({ a: allocated("a"), b: allocated("b"), c: allocated("c") });

    await routePendingOrders(repository);

    expect(routed).toEqual(["a", "b", "c"]);
  });

  test("an empty queue is a no-op, not an error", async () => {
    const { repository } = repositoryReturning({});

    const result = await routePendingOrders(repository);

    expect(result).toMatchObject({ attempted: 0, allocated: 0, failed: [] });
  });

  test("defaults the batch size rather than requiring the caller to pick one", async () => {
    // Collected in an array rather than assigned to a `let`. A `let` initialised to `null` is
    // narrowed to `null` by control-flow analysis, because the assignment happens inside a
    // callback the compiler cannot see being called -- so `toBe(50)` would be a type error
    // against `null` and the narrowing is what makes the mistake.
    const askedFor: number[] = [];
    const repository: OrderRoutingRepository = {
      async listRoutableOrderIds(limit) {
        askedFor.push(limit);
        return [];
      },
      async routeOrder() {
        throw new Error("unused");
      },
    };

    await routePendingOrders(repository);

    expect(askedFor).toEqual([DEFAULT_ROUTING_BATCH_SIZE]);
  });
});
