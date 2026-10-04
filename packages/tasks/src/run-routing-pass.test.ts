import { describe, expect, test } from "bun:test";
import { toOrderId, toWarehouseId } from "@repo/domain";
import { DEFAULT_ROUTING_BATCH_SIZE, type OrderRoutingRepository, type RoutingOutcome } from "@repo/application";
import { runRoutingPass } from "./run-routing-pass";

/**
 * Tests for the worker's decision layer.
 *
 * The routing policy and the database are tested in their own packages. What is untestable
 * anywhere else is the question this file answers: when orders fail, does the worker go quiet or
 * does it fail loudly. That is the difference between "fulfillment is broken" and "fulfillment
 * looks fine and is quietly not happening", and it is the failure mode that costs a business an
 * afternoon.
 */

const allocated = (orderId: string): RoutingOutcome => ({
  outcome: "allocated",
  orderId: toOrderId(orderId),
  warehouseId: toWarehouseId("wh-1"),
  reserved: new Map(),
});

const repositoryWhere = (route: (orderId: string) => RoutingOutcome | Promise<RoutingOutcome>, listed: string[]): OrderRoutingRepository => ({
  async listRoutableOrderIds() {
    return listed;
  },
  routeOrder: ({ orderId }) => Promise.resolve(route(orderId)),
});

describe("runRoutingPass", () => {
  test("returns the batch result when every order routes", async () => {
    const repository = repositoryWhere(allocated, ["ord-1", "ord-2"]);

    const result = await runRoutingPass(repository);

    expect(result).toMatchObject({ attempted: 2, allocated: 2, failed: [] });
  });

  /**
   * The assertion this file is for.
   *
   * `routePendingOrders` deliberately swallows per-order failures so one bad row cannot abandon
   * the queue behind it. The cost of swallowing is that a pass can finish reporting success
   * having routed nothing. The worker therefore has to fail -- but only after the batch, so the
   * orders that *could* be routed already were.
   */
  test("fails when any order failed, so a stuck order cannot pass as a healthy run", async () => {
    const repository = repositoryWhere(
      (orderId) => {
        if (orderId === "ord-stuck") throw new Error("Order must carry a line with a title.");
        return allocated(orderId);
      },
      ["ord-stuck", "ord-fine"],
    );

    // The good order behind the bad one is still routed -- isolation is preserved.
    const promise = runRoutingPass(repository);

    await expect(promise).rejects.toThrow(/ord-stuck/);
  });

  test("names every failed order and the first error, so the log is actionable", async () => {
    const repository = repositoryWhere(
      (orderId) => {
        throw new Error(orderId === "ord-a" ? "first problem" : "second problem");
      },
      ["ord-a", "ord-b"],
    );

    await expect(runRoutingPass(repository)).rejects.toThrow(/ord-a, ord-b/);
    await expect(runRoutingPass(repository)).rejects.toThrow(/first problem/);
  });

  test("an empty queue is a success, not a failure", async () => {
    // Idling is the normal state between batches. Treating "nothing to do" as an error would
    // retry forever and fill the Trigger dashboard with red.
    const repository = repositoryWhere(allocated, []);

    await expect(runRoutingPass(repository)).resolves.toMatchObject({ attempted: 0, allocated: 0 });
  });

  test("passes the limit through to the repository", async () => {
    const asked: number[] = [];
    const repository: OrderRoutingRepository = {
      async listRoutableOrderIds(limit) {
        asked.push(limit);
        return [];
      },
      async routeOrder() {
        throw new Error("unused");
      },
    };

    await runRoutingPass(repository, 5);
    await runRoutingPass(repository);

    // The manual trigger supplies one; the schedule supplies none, and that must resolve to the
    // use case's default *before* the repository is called. `undefined` reaching the port would
    // push the default into every implementation, and the first one written would forget.
    expect(asked).toEqual([5, DEFAULT_ROUTING_BATCH_SIZE]);
  });
});
