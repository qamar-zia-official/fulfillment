import type { OrderRoutingRepository, RoutingOutcome } from "./order-routing";

/**
 * Default batch size.
 *
 * Bounded because of what routing costs: each order takes a row lock on itself and on every
 * candidate inventory row for its basket, then writes. A batch of 500 holds 500 orders' worth of
 * locks and runs for minutes, which is a long window in which a deploy, a connection drop, or
 * an operator's manual correction collides with it. Smaller batches mean more frequent, shorter
 * runs and a slower ceiling on throughput if the backlog is large.
 */
export const DEFAULT_ROUTING_BATCH_SIZE = 50;

/**
 * What one pass over the queue did.
 *
 * Counted rather than logged-and-forgotten, because a worker that silently stops routing is
 * the failure mode nobody notices: no errors, no alerts, orders just sit in `pending` forever
 * while the shop takes more.
 */
export type RoutingBatchResult = {
  /** Orders the batch attempted, which is the list length rather than the number that worked. */
  readonly attempted: number;
  readonly allocated: number;
  readonly unroutable: number;
  readonly notRoutable: number;
  /**
   * Orders that threw. Non-fatal by design -- see below -- but never dropped, because a
   * persistent failure is a bug or a corrupt row and needs a human either way.
   */
  readonly failed: readonly { readonly orderId: string; readonly message: string }[];
};

/**
 * Routes a batch of waiting orders.
 *
 * The reason this is a use case and not a loop in the task file: the loop is where the
 * interesting decisions live, and a loop in a Trigger task cannot be unit tested.
 *
 * **One failing order must not stop the batch.** This is the property that matters most here,
 * and it is not a nicety. An order whose row is internally inconsistent -- a line with no
 * title, a currency that does not match its lines -- makes `routeOrder` throw every single time
 * it is reached. In a loop that rethrows, that one order sits at the head of the oldest-first
 * queue forever, and every order behind it is never routed. The shop keeps taking orders, the
 * worker keeps running, nothing is logged as an error, and fulfillment is simply broken in a
 * way that looks like it is working.
 *
 * So each order is isolated: failures are collected and reported, and the pass continues. The
 * caller decides what to do about them, and `routingBatch` reporting a non-empty `failed` is the
 * signal a Trigger task can raise an alert on.
 *
 * Note what is deliberately *not* here: no retry. A retry belongs to the trigger's own policy
 * (Trigger.dev handles that with attempts and backoff), and doing it here would compound with
 * it. A per-order retry inside a batch is also the wrong shape, because it turns a bounded unit
 * of work into an unbounded one.
 */
export const routePendingOrders = async (
  repository: OrderRoutingRepository,
  options: { limit?: number } = {},
): Promise<RoutingBatchResult> => {
  const limit = options.limit ?? DEFAULT_ROUTING_BATCH_SIZE;
  const orderIds = await repository.listRoutableOrderIds(limit);

  let allocated = 0;
  let unroutable = 0;
  let notRoutable = 0;
  const failed: { orderId: string; message: string }[] = [];

  for (const orderId of orderIds) {
    let outcome: RoutingOutcome;

    try {
      outcome = await repository.routeOrder({ orderId });
    } catch (error) {
      // Isolated, not swallowed: recorded and re-surfaced through the return value, so the
      // task can alert. Rethrowing here would abandon the remaining orders in the batch.
      failed.push({ orderId, message: error instanceof Error ? error.message : String(error) });
      continue;
    }

    if (outcome.outcome === "allocated") allocated += 1;
    else if (outcome.outcome === "unroutable") unroutable += 1;
    else notRoutable += 1;
  }

  return { attempted: orderIds.length, allocated, unroutable, notRoutable, failed };
};
