import { and, eq, sql } from "drizzle-orm";
import { PersistenceError, type FulfillmentError } from "@repo/domain";
import type { ShopifyOrderWebhookRepository, WebhookDeliveryClaim, OrderIntent, AppliedOrder } from "@repo/application";
import type { SupportedShopifyOrderTopic } from "@repo/validation/shopify";
import type { Database } from "../client";
import { auditEvents, orderItems, orders, webhookEvents } from "../schema";

/** The order columns that an `orders/updated` or `orders/cancelled` delivery may change. */
function orderRowFromIntent(intent: OrderIntent) {
  return {
    orderNumber: intent.orderNumber,
    customerEmail: intent.customerEmail,
    currency: intent.currency,
    totalPrice: intent.totalPrice,
    status: intent.status,
    financialStatus: intent.financialStatus,
    shippingName: intent.shipping.name,
    shippingAddressLine1: intent.shipping.addressLine1,
    shippingAddressLine2: intent.shipping.addressLine2,
    shippingCity: intent.shipping.city,
    shippingProvince: intent.shipping.province,
    shippingPostalCode: intent.shipping.postalCode,
    shippingCountryCode: intent.shipping.countryCode,
    shippingPhone: intent.shipping.phone,
    cancelledAt: intent.cancelledAt,
    cancelReason: intent.cancelReason,
    isTestOrder: intent.isTestOrder,
    updatedAt: new Date(),
  };
}

function lineItemRows(intent: OrderIntent, orderId: string) {
  return intent.lineItems.map((lineItem) => ({
    id: crypto.randomUUID(),
    orderId,
    shopifyLineItemId: lineItem.shopifyLineItemId,
    sku: lineItem.sku,
    variantId: lineItem.variantId,
    title: lineItem.title,
    quantity: lineItem.quantity,
    fulfillableQuantity: lineItem.fulfillableQuantity,
    unitPrice: lineItem.unitPrice,
    requiresShipping: lineItem.requiresShipping,
  }));
}

export function createShopifyOrderWebhookRepository(db: Database): ShopifyOrderWebhookRepository {
  return {
    /**
     * Phase 1: take ownership of the delivery.
     *
     * Committed independently of the work it guards, on purpose. The unique index on
     * (provider, external_event_id) is the actual idempotency guarantee -- it is enforced
     * by Postgres, not by our read-then-write logic, so two concurrent redeliveries
     * arriving at the same instant cannot both win.
     *
     * The status decides the third branch. A row that exists and is `processed` (or
     * in-flight `processing`) means there is nothing to do. A row that exists and is
     * `failed` means Shopify is retrying something we genuinely failed at, so the work
     * must be re-attempted rather than acknowledged. Silently treating that as a
     * duplicate is how an order disappears with no error anywhere.
     */
    async claimDelivery({ shopDomain, webhookId, topic, rawPayload, triggeredAt }): Promise<WebhookDeliveryClaim> {
      const inserted = await db
        .insert(webhookEvents)
        .values({
          id: crypto.randomUUID(),
          provider: "shopify",
          topic,
          externalEventId: webhookId,
          shopDomain,
          rawPayload,
          status: "processing",
          triggeredAt,
        })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });

      const claimedId = inserted[0]?.id;
      if (claimedId) return { outcome: "claimed", webhookEventId: claimedId };

      // The conflict branch. Re-read to find out what happened last time.
      const existing = await db.query.webhookEvents.findFirst({
        where: and(eq(webhookEvents.provider, "shopify"), eq(webhookEvents.externalEventId, webhookId)),
      });

      if (!existing) {
        throw new PersistenceError("Webhook idempotency record disappeared during processing.", {
          details: { webhookId, shopDomain },
        });
      }

      if (existing.status === "failed") {
        // Re-attempt. Bump the counter so the row shows how hard Shopify had to push.
        await db
          .update(webhookEvents)
          .set({ status: "processing", attempts: sql`${webhookEvents.attempts} + 1`, errorMessage: null, failedAt: null })
          .where(eq(webhookEvents.id, existing.id));
        return { outcome: "retry", webhookEventId: existing.id };
      }

      // Count the duplicate arrival anyway: repeated deliveries are a signal about
      // Shopify's retry behaviour and about whether our 200s are actually landing.
      await db.update(webhookEvents).set({ attempts: sql`${webhookEvents.attempts} + 1` }).where(eq(webhookEvents.id, existing.id));
      return { outcome: "already_processed", webhookEventId: existing.id };
    },

    /**
     * Phase 2: make the order true, atomically.
     *
     * The order upsert, the item replacement, the audit row, and the event's move to
     * `processed` share one transaction. That is the guarantee: an order is never visible
     * without its items, and an event is never marked processed for work that did not
     * land. Either all of it is true or none of it is.
     *
     * Note the upsert uses `onConflictDoUpdate` rather than read-then-write. Checking
     * existence first would be a race: two redeliveries could both see "absent" and both
     * insert, and the unique index would turn the loser into an error instead of an update.
     * Letting Postgres arbitrate is both simpler and correct under concurrency.
     */
    async applyOrder({ intent, webhookEventId }): Promise<AppliedOrder> {
      return db.transaction(async (transaction) => {
        const rows = await transaction
          .insert(orders)
          .values({
            id: crypto.randomUUID(),
            shopDomain: intent.shopDomain,
            shopifyOrderId: intent.shopifyOrderId,
            sourceCreatedAt: intent.sourceCreatedAt,
            ...orderRowFromIntent(intent),
          })
          .onConflictDoUpdate({
            target: [orders.shopDomain, orders.shopifyOrderId],
            // Cancellation is a terminal state, enforced in the database rather than in
            // application code.
            //
            // The application cannot see an order's current status, so it cannot know that
            // this delivery is an `orders/updated` for an order cancelled moments ago. If
            // the payload on such a delivery lacks `cancelled_at`, a straight overwrite
            // would set status back to "pending" and put a cancelled order back into the
            // pick queue -- an item shipped to someone who already cancelled and asked for
            // their money back.
            //
            // `case` keeps the existing status whenever it is already 'cancelled', so the
            // only way out is a new order. That matches the domain: you cancel an order and
            // place a replacement, you do not un-cancel it. A `case` expression rather than
            // a `where` clause because ON CONFLICT DO UPDATE cannot be skipped, and
            // skipping the update would silently drop genuine changes to the other columns.
            //
            // The cancellation *fields* are frozen alongside the status, and that detail is
            // a bug this file already had once: freezing only the status let a stale update
            // null out `cancelled_at`, leaving an order that claimed to be cancelled with no
            // record of when. Status, timestamp, and reason are one fact and must move as
            // one.
            //
            // `sql.param(value, column)` rather than a bare `${value}` is load-bearing.
            // Interpolating a `Date` straight into a `sql` template sends it to the driver
            // as an untyped parameter, and postgres.js then fails with
            // "The string argument must be of type string... Received an instance of Date"
            // because it is asked to byte-length a Date. Passing the column as the encoder
            // makes Drizzle apply the same `mapToDriverValue` it uses on a normal insert, so
            // the fragment stays type-correct instead of working only for strings and nulls.
            //
            // Column references in the SET expression resolve against the pre-update row, so
            // `orders.cancelledAt` reads as the OLD value.
            set: {
              ...orderRowFromIntent(intent),
              status: sql`case when ${orders.status} = 'cancelled' then 'cancelled' else ${sql.param(intent.status, orders.status)} end`,
              cancelledAt: sql`case when ${orders.status} = 'cancelled' then ${orders.cancelledAt} else ${sql.param(intent.cancelledAt, orders.cancelledAt)} end`,
              cancelReason: sql`case when ${orders.status} = 'cancelled' then ${orders.cancelReason} else ${sql.param(intent.cancelReason, orders.cancelReason)} end`,
            },
          })
          .returning({ id: orders.id, inserted: sql<boolean>`xmax = 0` });

        const row = rows[0];
        if (!row) {
          throw new PersistenceError("Order upsert returned no row.", { details: { shopifyOrderId: intent.shopifyOrderId } });
        }
        const orderId = row.id;

        // `xmax` is the transaction id of the last UPDATE/DELETE on the row version, and is
        // 0 for a freshly inserted tuple. So `xmax = 0` is true exactly when the INSERT
        // branch ran and false when the ON CONFLICT DO UPDATE branch did.
        //
        // This replaces the obvious alternative of reading the row first to see whether it
        // existed, which is a race: two redeliveries arriving together can both observe
        // "absent" and both attempt an insert. The unique index would then turn the loser
        // into an error rather than an update, and a duplicate delivery would surface as a
        // 500 that Shopify retries forever. Letting Postgres arbitrate is both simpler and
        // correct, and the flag is read from the same statement that did the work.
        const created = row.inserted;

        // Items are replaced rather than merged. Shopify is the system of record for the
        // line items, so a delivery describes the complete desired set; keeping removed
        // lines around would make pick lists disagree with the order.
        await transaction.delete(orderItems).where(eq(orderItems.orderId, orderId));
        await transaction.insert(orderItems).values(lineItemRows(intent, orderId));

        await transaction.insert(auditEvents).values({
          id: crypto.randomUUID(),
          entityType: "order",
          entityId: orderId,
          eventType: intent.auditEventType,
          metadata: { source: "shopify", webhookEventId, topic: intent.auditEventType === "ORDER_CANCELLED" ? "orders/cancelled" : undefined },
        });

        await transaction
          .update(webhookEvents)
          .set({ status: "processed", processedAt: new Date(), errorMessage: null, failedAt: null })
          .where(eq(webhookEvents.id, webhookEventId));

        return { orderId, created };
      });
    },

    /**
     * Phase 3: record the failure, in its own transaction.
     *
     * Runs after the failed transaction has already rolled back, so nothing here can be
     * undone by the failure it is recording.
     */
    async recordFailure({ webhookEventId, error }: { webhookEventId: string; error: FulfillmentError }) {
      await db
        .update(webhookEvents)
        .set({
          status: "failed",
          errorMessage: `${error.code}: ${error.message}`.slice(0, 2_000),
          failedAt: new Date(),
        })
        .where(eq(webhookEvents.id, webhookEventId));
    },
  };
}
