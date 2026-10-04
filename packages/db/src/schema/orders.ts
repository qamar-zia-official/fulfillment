import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Lifecycle of a single inbound webhook delivery.
 *
 * Modelled as a CHECK-constrained text column rather than a Postgres `ENUM` on purpose.
 * Both enforce the same rule, but adding a value to an enum requires `ALTER TYPE ... ADD
 * VALUE`, which historically could not run inside a transaction, making it a more awkward
 * migration. Evolving this list is a routine expectation (a new Shopify topic arrives,
 * we add a "dead-lettered" state), so a CHECK is the cheaper thing to live with.
 */
export const WEBHOOK_EVENT_STATUSES = [
  "received",
  "processing",
  "processed",
  "failed",
] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    topic: text("topic").notNull(),
    externalEventId: text("external_event_id").notNull(),
    shopDomain: text("shop_domain").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    status: text("status")
      .$type<WebhookEventStatus>()
      .notNull()
      .default("received"),
    /**
     * Populated only on the `failed` path. Previously this column existed but nothing ever
     * wrote to it, which made it worse than absent: it looked like we recorded failures.
     */
    errorMessage: text("error_message"),
    /**
     * How many times we have *received* this delivery id. Incremented on every redelivery,
     * including ones that are rejected as already-processed, so it shows Shopify's real
     * retry pressure rather than only our processing attempts.
     */
    attempts: integer("attempts").notNull().default(1),
    /** Shopify's `X-Shopify-Triggered-At`, kept so we can measure ingestion lag. */
    triggeredAt: timestamp("triggered_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (table) => [
    /**
     * Deliberately NOT scoped to `shop_domain`.
     *
     * Shopify's `X-Shopify-Webhook-Id` is a globally unique UUID per delivery, so two shops
     * can never mint the same one. Scoping the index to a shop would therefore be redundant
     * work on the hot path (a wider index to maintain) in exchange for nothing.
     *
     * The consequence, which is a feature: this index is what makes delivery idempotency hold
     * under concurrency. It is enforced by Postgres rather than by a read-then-write check in
     * application code, so two simultaneous redeliveries cannot both conclude "not seen yet".
     */
    uniqueIndex("webhook_events_provider_external_id_unique").on(
      table.provider,
      table.externalEventId,
    ),
    index("webhook_events_shop_received_idx").on(
      table.shopDomain,
      table.receivedAt,
    ),
    index("webhook_events_failed_idx")
      .on(table.failedAt)
      .where(sql`${table.status} = 'failed'`),
    check(
      "webhook_events_status_check",
      sql`${table.status} in ('received','processing','processed','failed')`,
    ),
  ],
);

/**
 * The ship-to address lives as columns here rather than in a separate `addresses` table.
 *
 * The deciding factor was what the current phases need. An order has exactly one
 * ship-to destination, and the routing engine that consumes this in a later phase needs
 * to read the country on every single candidate order. Columns mean that read stays on
 * one row with no join and no fan-out risk; a side table would buy normalisation we are
 * not using yet.
 *
 * We will revisit this the moment a second address exists on an order (billing) or an
 * address gains a lifecycle of its own (returns, or history we must retain when a customer
 * edits it mid-fulfilment). Extracting a table later is a mechanical migration; guessing
 * wrong now means every order read pays for a join forever. `shipping_country_code` is
 * stored uppercased and is the column the routing engine will filter on.
 */
export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    shopDomain: text("shop_domain").notNull(),
    shopifyOrderId: text("shopify_order_id").notNull(),
    orderNumber: integer("order_number"),
    customerEmail: text("customer_email"),
    currency: text("currency").notNull(),
    totalPrice: numeric("total_price", { precision: 12, scale: 2 }).notNull(),
    /**
     * The order lifecycle, CHECK-constrained as of Phase 4.
     *
     * Phase 2 left this as free text on purpose -- a status machine belongs with the rules that
     * drive it, and constraining the column before `packages/domain` had a lifecycle would have
     * meant a migration the moment it did. That machine now exists (`ORDER_STATUSES` in
     * `@repo/domain`), so the constraint below is the same list, restated where a writer cannot
     * bypass it.
     *
     * The two lists must stay in step. `orders.test.ts` asserts the SQL list against
     * `ORDER_STATUSES` so a new domain state cannot be added without the database accepting it,
     * which is the failure mode that would otherwise surface as an order that cannot be written
     * at all.
     */
    status: text("status").notNull().default("pending"),
    /**
     * Set by the routing engine when it reserves stock. Null for every state that has not been
     * routed, and checked against `status` below.
     *
     * Deliberately NOT a foreign key. `warehouses` needs to reference `orders` (for
     * reservations) and a FK here would point back, and a two-file import cycle between schema
     * modules is a fragile thing to build a correctness argument on. The integrity that
     * actually matters is the CHECK below -- an allocated order always names a warehouse --
     * and warehouses are never deleted, so a dangling id cannot arise. Add the FK in a
     * follow-up migration once the cycle is broken by moving either table.
     */
    allocatedWarehouseId: text("allocated_warehouse_id"),
    financialStatus: text("financial_status"),
    shippingName: text("shipping_name"),
    shippingAddressLine1: text("shipping_address_line1"),
    shippingAddressLine2: text("shipping_address_line2"),
    shippingCity: text("shipping_city"),
    /** Shopify's `province` is the state/region code; region-agnostic by design. */
    shippingProvince: text("shipping_province"),
    shippingPostalCode: text("shipping_postal_code"),
    shippingCountryCode: text("shipping_country_code"),
    shippingPhone: text("shipping_phone"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    /**
     * Orders created through a development/test store. These must never consume real
     * inventory or trigger a real carrier label, so they are marked at ingestion while the
     * Shopify payload that said so is still in hand. Defaulting to true would be the safe
     * direction to fail; it is not, so the default is false and ingestion is explicit.
     */
    isTestOrder: boolean("is_test_order").notNull().default(false),
    sourceCreatedAt: timestamp("source_created_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("orders_shopify_order_unique").on(
      table.shopDomain,
      table.shopifyOrderId,
    ),
    index("orders_status_created_idx").on(table.status, table.createdAt),
    // Partial index matching the routing engine's hot path: "live, real orders waiting to be
    // routed". Phase 4 reads exactly this set.
    index("orders_routable_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending' and ${table.isTestOrder} = false`),
    // The allocation back-reference: "what is this warehouse currently holding?" for every
    // open order, which a partial index answers without scanning cancelled and delivered ones.
    index("orders_warehouse_status_idx")
      .on(table.allocatedWarehouseId)
      .where(sql`${table.allocatedWarehouseId} is not null`),
    // An order that claims to be cancelled but has no cancellation time cannot be reconciled
    // against Shopify or answered in a customer support conversation. This constraint exists
    // because the repository already shipped a bug that produced exactly that state: the
    // upsert froze `status` against resurrection but let a later delivery null out
    // `cancelled_at`. Application-level tests did not catch it because the invariant spans a
    // transaction; a CHECK is the only place that can guarantee it.
    check(
      "orders_cancelled_requires_timestamp_check",
      sql`${table.status} <> 'cancelled' or ${table.cancelledAt} is not null`,
    ),
    check(
      "orders_status_lifecycle_check",
      sql`${table.status} in ('pending','allocated','picking','picked','packed','shipped','delivered','cancelled')`,
    ),
    // A warehouse assignment is only meaningful once the order has been allocated, and an
    // allocated order must say where it went. Without this pair, a half-finished routing write
    // leaves an order that claims to be allocated with no warehouse, and nothing fails.
    check(
      "orders_allocated_requires_warehouse_check",
      sql`${table.status} <> 'allocated' or ${table.allocatedWarehouseId} is not null`,
    ),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    shopifyLineItemId: text("shopify_line_item_id").notNull(),
    /**
     * Nullable on purpose. Real Shopify orders legitimately contain items with no SKU
     * (a custom product, a bundle component, a mis-catalogued variant). Rejecting those
     * orders would drop revenue, and inventing a SKU would corrupt the catalogue, so the
     * item is stored as-is and the routing engine raises them as unroutable exceptions.
     */
    sku: text("sku"),
    /** Shopify's variant id. Stable across renames, unlike the title, so it is what an operator should reconcile against. */
    variantId: text("variant_id"),
    title: text("title").notNull(),
    quantity: integer("quantity").notNull(),
    /**
     * Items a courier can actually ship. Diverges from `quantity` after partial fulfilment,
     * and digital goods report 0, so the routing engine needs it as a separate fact rather
     * than inferring it.
     */
    fulfillableQuantity: integer("fulfillable_quantity"),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
    /**
     * False for digital goods. A non-shippable line must not be allocated to a warehouse or
     * counted against pick capacity, so it has to be a stored column rather than a SKU
     * lookup performed per request.
     */
    requiresShipping: boolean("requires_shipping").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("order_items_order_line_item_unique").on(
      table.orderId,
      table.shopifyLineItemId,
    ),
    // Supports the unroutable-items lookup: "which line items lack a SKU to match against".
    index("order_items_sku_idx").on(table.sku),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    eventType: text("event_type").notNull(),
    metadata: jsonb("metadata").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_events_entity_created_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    // Phase 4 adds ORDER_ALLOCATED. The list is constrained because an audit log is only
    // trustworthy if "what happened" is a closed set: a typo'd event type is invisible to every
    // query written against the known ones, which reads exactly like "it never happened".
    check(
      "audit_events_event_type_check",
      sql`${table.eventType} in ('ORDER_CREATED','ORDER_UPDATED','ORDER_CANCELLED','ORDER_ALLOCATED','ORDER_DEALLOCATED')`,
    ),
  ],
);
