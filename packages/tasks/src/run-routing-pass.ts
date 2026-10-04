import { routePendingOrders, type OrderRoutingRepository, type RoutingBatchResult } from "@repo/application";

/**
 * One pass of the routing worker, with no Trigger.dev import in sight.
 *
 * This split is the reason the behaviour is testable at all. A `task()` wrapper closes over
 * the Trigger runtime, so a test that imports the task file can only assert that the module
 * loads -- and a test that asserts "the module loads" is a test that passes when the worker is
 * broken. The interesting decisions here (does a failure become visible, or does the pass
 * report success and route nothing?) live in this function, so this is where they live.
 *
 * The repository is a parameter rather than a `getDb()` call for the same reason: injecting it
 * is what lets a test drive both the success and failure paths without a database, and it keeps
 * the rule that a Trigger task is a thin adapter over a use case.
 */
export const runRoutingPass = async (repository: OrderRoutingRepository, limit?: number): Promise<RoutingBatchResult> => {
  const result = await routePendingOrders(repository, { limit });

  // Per-order failures come back in the result rather than being thrown mid-batch, so one bad
  // row cannot abandon the orders queued behind it. They still have to reach someone: a worker
  // that routes nothing and reports nothing is indistinguishable from a healthy idle worker,
  // and the affected orders just sit in `pending` while the shop keeps taking more.
  //
  // So the pass fails, but only after the batch is done. Trigger.dev then retries, which is the
  // right response to "some orders are stuck", and the retry is safe because `routeOrder` is
  // idempotent and row-locked -- the same orders come back as a no-op.
  if (result.failed.length > 0) {
    throw new Error(
      `Routing pass had ${result.failed.length} failed order(s): ${result.failed.map((failure) => failure.orderId).join(", ")}. ` +
        `First error: ${result.failed[0]?.message ?? "unknown"}`,
    );
  }

  return result;
};
