import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { processShopifyOrderWebhook, type ShopifyOrderWebhookRepository } from "@repo/application";
import { PersistenceError } from "@repo/domain";
import { loadRepositoryEnvironment } from "@repo/validation/environment-loader";
import { shopifyOrderWebhookSchema, type ShopifyOrderWebhook, type SupportedShopifyOrderTopic } from "@repo/validation/shopify";
import { getDb } from "../client";
import { createShopifyOrderWebhookRepository } from "../repositories/shopify-order-webhook";
import { auditEvents, orderItems, orders, webhookEvents } from "../schema";

loadRepositoryEnvironment();

/**
 * End-to-end ingestion tests against a real Postgres.
 *
 * These deliberately do NOT use a fake. The behaviour worth protecting here lives in SQL
 * that a fake cannot exercise: the unique index that makes idempotency hold under
 * concurrency, `xmax = 0` distinguishing an insert from an update, and the CHECK
 * constraints. A mocked repository would pass while every one of those was wrong.
 */

const REMOTE_DATABASE_TIMEOUT_MS = 30_000;

/**
 * Integration tests are opt-outable because they are genuinely slow, and a slow suite is a
 * suite people skip -- which is worse than useless, because then nothing runs.
 *
 * The cost is not our code. Measured against this Neon instance: ~2.1-2.7s for the first
 * query (it scales to zero and must resume), then ~300-500ms per round trip. A dozen tests
 * doing five round trips each is around two minutes. Set `SKIP_DB_INTEGRATION=1` for a fast
 * inner loop; run the full suite before calling a phase done.
 *
 * Note the client uses `prepare: false`. Prepared statements would roughly halve the warm
 * query time (measured: 280ms vs 524ms) but are incompatible with a transaction-mode pooler
 * such as PgBouncer, where the session that created a prepared statement may not be the one
 * that later uses it. Two minutes of honest slowness is the cheaper trade than a driver
 * error that only appears in production, behind a proxy the developer never touches.
 */
const runIntegration = process.env.SKIP_DB_INTEGRATION !== "1";

/**
 * A fresh shop AND fresh webhook ids per run.
 *
 * The unique index on `webhook_events` is `(provider, external_event_id)` and is
 * deliberately *not* scoped to a shop, because Shopify's `X-Shopify-Webhook-Id` is a
 * globally unique UUID per delivery, so scoping it would be redundant. The consequence for
 * these tests is that fixed webhook ids would collide with rows left behind by a previous
 * run that was interrupted before its cleanup hook, and the claim would then return
 * `already_processed` for a "first" delivery. Scoping the ids to the run makes each run
 * independent of whatever the last one left behind.
 */
const RUN = `${Date.now()}`;
const SHOP = `ingestion-test-${RUN}.myshopify.com`;
const eventId = (name: string) => `evt-${RUN}-${name}`;
const db = getDb();

const databaseReachable = runIntegration
  ? await (async () => {
      try {
        await db.execute("select 1");
        return true;
      } catch {
        return false;
      }
    })()
  : false;

function payloadFor(shopifyOrderId: string | number, overrides: Record<string, unknown> = {}): ShopifyOrderWebhook {
  return shopifyOrderWebhookSchema.parse({
    id: shopifyOrderId,
    order_number: 1001,
    email: "buyer@example.com",
    currency: "USD",
    total_price: "149.99",
    created_at: "2026-09-28T10:00:00Z",
    line_items: [
      { id: 1, sku: "KNT-TSHIRT-BLK-M", variant_id: 900, title: "Kinetous Tee", quantity: 2, price: "59.99" },
      { id: 2, sku: "KNT-MUG-WHT", variant_id: 901, title: "Kinetous Mug", quantity: 1, price: "30.01" },
    ],
    shipping_address: { name: "Ada L", address1: "1 Main St", city: "Austin", province: "TX", zip: "78701", country_code: "us" },
    ...overrides,
  });
}

function deliver(
  repository: ShopifyOrderWebhookRepository,
  input: { webhookId: string; topic?: SupportedShopifyOrderTopic; payload: ShopifyOrderWebhook },
) {
  return processShopifyOrderWebhook(repository, {
    shopDomain: SHOP,
    webhookId: input.webhookId,
    topic: input.topic ?? "orders/create",
    payload: input.payload,
    rawPayload: JSON.stringify(input.payload),
  });
}

const orderRows = () => db.select().from(orders).where(sql`${orders.shopDomain} = ${SHOP}`);

/**
 * `order_items` has no `shop_domain` column, so filtering it by one needs the parent ids
 * first. Joining instead would be one round trip instead of two, but these tests read the
 * orders anyway to make their assertions, so the ids are already in hand.
 */
async function itemRows() {
  const ids = (await orderRows()).map((order) => order.id);
  if (ids.length === 0) return [];
  return db.select().from(orderItems).where(inArray(orderItems.orderId, ids));
}

const eventRows = () => db.select().from(webhookEvents).where(sql`${webhookEvents.shopDomain} = ${SHOP}`);

afterAll(async () => {
  if (!databaseReachable) return;
  // Deletes in FK order: audit rows reference nothing, items cascade from orders, and the
  // webhook events are independent of both.
  const owned = await db.select({ id: orders.id }).from(orders).where(sql`${orders.shopDomain} = ${SHOP}`);
  for (const order of owned) await db.delete(auditEvents).where(eq(auditEvents.entityId, order.id));
  await db.delete(webhookEvents).where(sql`${webhookEvents.shopDomain} = ${SHOP}`);
  await db.delete(orders).where(sql`${orders.shopDomain} = ${SHOP}`);
}, REMOTE_DATABASE_TIMEOUT_MS);

describe.skipIf(!databaseReachable)("ingestion", () => {
  test(
    "a first delivery creates one order, its items, an audit record, and marks the event processed",
    async () => {
      const repository = createShopifyOrderWebhookRepository(db);
      const result = await deliver(repository, { webhookId: eventId("create-1"), payload: payloadFor(7001) });

      expect(result).toMatchObject({ duplicate: false, created: true, auditEventType: "ORDER_CREATED" });
      expect(result.orderId).toBeString();

      // By id, not by position -- see the note on `orderRows` in the integrity block.
      const order = (await orderRows()).find((row) => row.id === result.orderId);
      expect(order?.shippingCountryCode).toBe("US");
      expect(order?.isTestOrder).toBe(false);
      expect((await itemRows()).length).toBe(2);

      const [event] = await eventRows();
      expect(event?.status).toBe("processed");
      expect(event?.processedAt).toBeInstanceOf(Date);
      expect(event?.attempts).toBe(1);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "a redelivery of the same webhook id does no work and increments the attempt counter",
    async () => {
      const repository = createShopifyOrderWebhookRepository(db);
      const result = await deliver(repository, { webhookId: eventId("create-1"), payload: payloadFor(7001) });

      expect(result.duplicate).toBe(true);
      // Still one order. The attempt count moving proves we observed the redelivery rather
      // than ignoring it, which is the signal operators use to spot a misbehaving sender.
      expect((await orderRows()).length).toBe(1);
      const [event] = await eventRows();
      expect(event?.attempts).toBe(2);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "a NEW webhook id for an order we already have updates it rather than duplicating it",
    async () => {
      // This is the read-then-write race the unique index exists to arbitrate. Two
      // deliveries arriving together both "see" the order absent, and the index turns the
      // loser into an update instead of an error.
      const repository = createShopifyOrderWebhookRepository(db);
      const result = await deliver(repository, {
        webhookId: eventId("update-1"),
        topic: "orders/updated",
        payload: payloadFor(7001, { total_price: "129.99", financial_status: "paid" }),
      });


      expect(result.created).toBe(false);
      expect(result.auditEventType).toBe("ORDER_UPDATED");
      // One read, three assertions: each `await orderRows()` is a round trip to a database
      // that may be resuming from cold, so repeating it in a test is pure latency.
      const current = await orderRows();
      expect(current.length).toBe(1);
      expect(current[0]?.totalPrice).toBe("129.99");
      expect(current[0]?.financialStatus).toBe("paid");
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "replacing items is a real delete, so a removed line cannot linger in a pick list",
    async () => {
      const repository = createShopifyOrderWebhookRepository(db);
      await deliver(repository, {
        webhookId: eventId("update-2"),
        topic: "orders/updated",
        payload: payloadFor(7001, { line_items: [{ id: 1, sku: "KNT-TSHIRT-BLK-M", title: "Kinetous Tee", quantity: 1, price: "59.99" }] }),
      });

      const remaining = await itemRows();
      expect(remaining.length).toBe(1);
      expect(remaining[0]?.shopifyLineItemId).toBe("1");
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "a cancellation marks the order cancelled and records why",
    async () => {
      const repository = createShopifyOrderWebhookRepository(db);
      const result = await deliver(repository, {
        webhookId: eventId("cancel-1"),
        topic: "orders/cancelled",
        payload: payloadFor(7001, { cancelled_at: "2026-09-28T11:00:00Z", cancel_reason: "customer" }),
      });

      expect(result.auditEventType).toBe("ORDER_CANCELLED");
      const order = (await orderRows()).find((row) => row.id === result.orderId);
      expect(order?.status).toBe("cancelled");
      expect(order?.cancelReason).toBe("customer");
      expect(order?.cancelledAt).toBeInstanceOf(Date);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "a test-store order is flagged so it can never be allocated to a real warehouse",
    async () => {
      const repository = createShopifyOrderWebhookRepository(db);
      await deliver(repository, { webhookId: eventId("test-1"), payload: payloadFor(7002, { test: true }) });

      const testOrder = (await orderRows()).find((order) => order.shopifyOrderId === "7002");
      expect(testOrder?.isTestOrder).toBe(true);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "the orders/cancelled topic cancels even when the payload omits cancelled_at",
    async () => {
      // Found by live testing. Trusting only the payload's cancelled_at wrote
      // status="pending" for a cancellation, leaving a dead order in the pick queue.
      const repository = createShopifyOrderWebhookRepository(db);
      const result = await deliver(repository, { webhookId: eventId("cancel-2"), topic: "orders/cancelled", payload: payloadFor(7006) });

      expect(result.auditEventType).toBe("ORDER_CANCELLED");
      const order = (await orderRows()).find((row) => row.shopifyOrderId === "7006");
      expect(order?.status).toBe("cancelled");
      // Backfilled from receipt time, so "cancelled" always implies a known moment.
      expect(order?.cancelledAt).toBeInstanceOf(Date);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "cancellation is sticky: a later update cannot resurrect a cancelled order",
    async () => {
      // The application cannot see current status, so this guard has to live in the SQL.
      // Getting it wrong means shipping to a customer who already cancelled and asked for
      // a refund, so the guarantee is enforced by the database rather than by a convention.
      const repository = createShopifyOrderWebhookRepository(db);
      await deliver(repository, { webhookId: eventId("sticky-1"), topic: "orders/cancelled", payload: payloadFor(7007) });

      const before = (await orderRows()).find((row) => row.shopifyOrderId === "7007");
      expect(before?.status).toBe("cancelled");
      expect(before?.cancelledAt).toBeInstanceOf(Date);

      // A stale orders/updated redelivery with no cancelled_at in the payload.
      await deliver(repository, { webhookId: eventId("sticky-2"), topic: "orders/updated", payload: payloadFor(7007, { total_price: "77.00" }) });

      const after = (await orderRows()).find((row) => row.shopifyOrderId === "7007");
      expect(after?.status).toBe("cancelled");
      // The regression this file already had once: freezing the status but not the fields
      // let a stale update null out cancelled_at, leaving an order that claimed to be
      // cancelled with no record of when. Status, timestamp and reason move as one fact.
      expect(after?.cancelledAt).toBeInstanceOf(Date);
      expect(after?.cancelledAt?.getTime()).toBe(before?.cancelledAt?.getTime());
      // Genuine changes to other columns are still applied -- only the cancellation is frozen.
      expect(after?.totalPrice).toBe("77.00");
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );
});

describe.skipIf(!databaseReachable)("failure handling", () => {
  test(
    "a failure is recorded against the event, leaving a reason an operator can act on",
    async () => {
      // The real repository is used for claim and recordFailure, so the actual UPDATE and
      // the CHECK constraint are exercised. Only applyOrder is stubbed, because making a
      // real write genuinely fail would mean corrupting the database.
      const real = createShopifyOrderWebhookRepository(db);
      const failing: ShopifyOrderWebhookRepository = {
        claimDelivery: (input) => real.claimDelivery(input),
        recordFailure: (input) => real.recordFailure(input),
        applyOrder: () => Promise.reject(new PersistenceError("connection terminated unexpectedly", { cause: new Error("ECONNRESET") })),
      };

      await expect(deliver(failing, { webhookId: eventId("fail-1"), payload: payloadFor(7003) })).rejects.toThrow("connection terminated unexpectedly");

      const event = (await eventRows()).find((row) => row.externalEventId === eventId("fail-1"));
      expect(event?.status).toBe("failed");
      expect(event?.errorMessage).toContain("PERSISTENCE_FAILED");
      expect(event?.failedAt).toBeInstanceOf(Date);
      expect(event?.processedAt).toBeNull();

      // Critically: no partial order. The failed transaction left nothing behind.
      expect((await orderRows()).filter((order) => order.shopifyOrderId === "7003").length).toBe(0);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "redelivering a failed webhook re-attempts the work instead of dropping the order",
    async () => {
      // The single most important behaviour in this file. If a redelivery of a failed
      // delivery were acknowledged as a duplicate, the order would be lost permanently and
      // nothing anywhere would show an error. Shopify retries; we must actually try again.
      const real = createShopifyOrderWebhookRepository(db);
      const failing: ShopifyOrderWebhookRepository = {
        claimDelivery: (input) => real.claimDelivery(input),
        recordFailure: (input) => real.recordFailure(input),
        applyOrder: () => Promise.reject(new PersistenceError("still down")),
      };

      await expect(deliver(failing, { webhookId: eventId("fail-2"), payload: payloadFor(7004) })).rejects.toThrow();

      // Same webhook id, now with a healthy repository.
      const result = await deliver(real, { webhookId: eventId("fail-2"), payload: payloadFor(7004) });

      expect(result.created).toBe(true);
      expect(result.duplicate).toBe(false);
      expect((await orderRows()).filter((order) => order.shopifyOrderId === "7004").length).toBe(1);

      const event = (await eventRows()).find((row) => row.externalEventId === eventId("fail-2"));
      expect(event?.status).toBe("processed");
      // The stale reason is cleared, or an operator would read a resolved failure forever.
      expect(event?.errorMessage).toBeNull();
      expect(event?.failedAt).toBeNull();
      expect(event?.attempts).toBe(2);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "a policy rejection is recorded as a failure rather than silently claimed forever",
    async () => {
      const real = createShopifyOrderWebhookRepository(db);

      // Phase 2 used a missing-SKU payload for this. That rejection is gone as of Phase 4 --
      // a line with no SKU is now routed to an exception instead of failing ingestion -- so
      // the trigger is an empty basket, caught by the defensive invariant in
      // `assertIntentIsCoherent`. The invariant under test is unchanged: whatever rejects
      // after the claim, the claim must not be left dangling.
      //
      // Cast because `payloadFor` validates on the way in and would throw before the claim,
      // which would test nothing about the try/catch this exists for.
      const emptyBasket = {
        id: 7005,
        currency: "USD",
        total_price: "10.00",
        created_at: "2026-09-28T10:00:00Z",
        line_items: [],
      } as unknown as ShopifyOrderWebhook;

      await expect(deliver(real, { webhookId: eventId("reject-1"), payload: emptyBasket })).rejects.toThrow(/at least one line item/);

      const event = (await eventRows()).find((row) => row.externalEventId === eventId("reject-1"));
      expect(event?.status).toBe("failed");
      expect(event?.errorMessage).toContain("VALIDATION_FAILED");
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );
});

describe.skipIf(!databaseReachable)("integrity constraints", () => {
  /**
   * Drizzle wraps driver failures, and Postgres names the violated constraint in the
   * innermost message. `error.message` is the generic "Failed query: ...", so asserting on
   * it would pass for the wrong reason.
   */
  const constraintMessage = async (operation: Promise<unknown>): Promise<string> => {
    const messages: string[] = [];
    let current: unknown;
    try {
      await operation;
    } catch (error) {
      current = error;
    }
    while (current instanceof Error) {
      messages.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return messages.join(" | ");
  };

  test(
    "the database refuses an order that claims to be cancelled with no cancellation time",
    async () => {
      // The CHECK is the only thing that can guarantee this invariant, because it spans a
      // transaction. Application tests cannot see it coming: a single delivery produces a
      // perfectly valid intent, and it is the *combination* of two deliveries that produces
      // the impossible state. This exact row existed in this database before the CHECK was
      // added, and the constraint is what surfaced it.
      // Found by status, not by position. `orderRows()` has no ORDER BY, so `[0]` is whatever
      // the planner returns -- and a `pending` row found that way accepts `cancelledAt: null`
      // quite happily, because the constraint only bites for a cancelled order. The test then
      // passed or failed on table size rather than on the constraint, which is the worst way for
      // a constraint test to behave.
      const [row] = await db
        .select()
        .from(orders)
        .where(and(sql`${orders.shopDomain} = ${SHOP}`, eq(orders.status, "cancelled")))
        .limit(1);
      // Asserted rather than asserted-and-poked-at: no cancelled order means the fixture is
      // missing, and without this the update would match nothing and the test would pass on a
      // vacuous success.
      expect(row).toBeDefined();

      const message = await constraintMessage(db.update(orders).set({ cancelledAt: null }).where(eq(orders.id, row!.id)));
      expect(message).toContain("orders_cancelled_requires_timestamp_check");
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );

  test(
    "the database refuses a webhook status it does not recognise",
    async () => {
      const [event] = await eventRows();
      const message = await constraintMessage(
        db.update(webhookEvents).set({ status: "wat" as never }).where(eq(webhookEvents.id, event!.id)),
      );
      expect(message).toContain("webhook_events_status_check");
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );
});

describe.skipIf(!databaseReachable)("concurrent delivery", () => {
  test(
    "two simultaneous deliveries of the same webhook id produce exactly one order",
    async () => {
      // The real guarantee idempotency rests on. A boolean flag checked in application code
      // would let both through; only the unique index makes this hold.
      const repository = createShopifyOrderWebhookRepository(db);
      const payload = payloadFor(7010);

      const results = await Promise.all([
        deliver(repository, { webhookId: eventId("race-1"), payload }),
        deliver(repository, { webhookId: eventId("race-1"), payload }),
      ]);

      expect((await orderRows()).filter((order) => order.shopifyOrderId === "7010").length).toBe(1);
      expect((await eventRows()).filter((event) => event.externalEventId === eventId("race-1")).length).toBe(1);
      // Exactly one delivery did the work; the other saw it already handled.
      expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    },
    REMOTE_DATABASE_TIMEOUT_MS,
  );
});
