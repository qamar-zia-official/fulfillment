import { logger, schedules, task } from "@trigger.dev/sdk";
import { createOrderRoutingRepository, getDb } from "@repo/db";
import { runRoutingPass } from "../run-routing-pass";

/**
 * Routes the orders that are waiting for a warehouse.
 *
 * Declared with `schedules.task`, not `task`. That is the Trigger.dev v4 shape: a plain `task()`
 * has no `cron` property, and a task with one is a different type. Getting it wrong is a compile
 * error rather than a silent misconfiguration, which is the one good thing about the SDK's types
 * here.
 *
 * A scheduled task's payload is fixed by the platform, so there is no `{ limit }` parameter and
 * none is offered. Tuning the batch size is a code change on purpose: it is a lock-hold
 * duration, and something an operator can change from a dashboard at 3am is how you get a run
 * that holds a warehouse's row locks for an hour.
 *
 * A poller, rather than a call from the webhook handler, because of a timeout. The webhook has
 * a few seconds to acknowledge before Shopify retries, and routing takes row locks on the order
 * and on every candidate inventory row for its basket. Doing that inline means a slow query
 * gets the request killed mid-transaction: the lock wait is wasted and the order is still
 * unrouted. Decoupling keeps ingestion fast and durable and lets routing retry on its own
 * schedule. It also narrows the blast radius -- a webhook failure is retried by Shopify, a
 * worker failure by Trigger.dev, and since routing is idempotent a re-run is a no-op rather than
 * a double reservation.
 */
export const routePendingOrdersTask = schedules.task({
  id: "route-pending-orders",
  // Every five minutes, on the minute. A rounded cron rather than an offset so runs are easy to
  // correlate with something else that happened at a particular time.
  cron: "*/5 * * * *",
  run: async () => {
    const result = await runRoutingPass(createOrderRoutingRepository(getDb()));
    logger.info("Routing pass complete", {
      attempted: result.attempted,
      allocated: result.allocated,
      unroutable: result.unroutable,
      notRoutable: result.notRoutable,
    });
    return result;
  },
});

/**
 * The same work, triggered by hand.
 *
 * Separate from the schedule on purpose: this is how an operator drains a backlog right after
 * restocking, without waiting up to five minutes and without editing a cron. It takes a limit so
 * a cautious first run is possible -- a manual trigger that drains the entire queue in one go is
 * the same mistake as the 3am dashboard slider, just pressed by a person instead of a clock.
 */
export const routePendingOrdersManually = task({
  id: "route-pending-orders-manual",
  run: async (payload: { limit?: number }) => runRoutingPass(createOrderRoutingRepository(getDb()), payload.limit),
});
