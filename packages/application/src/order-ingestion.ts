import { ValidationFailedError, type FulfillmentError } from "@repo/domain";
import type { ShopifyOrderWebhook, ShopifyShippingAddress, SupportedShopifyOrderTopic } from "@repo/validation/shopify";

export const AUDIT_EVENT_TYPES = ["ORDER_CREATED", "ORDER_UPDATED", "ORDER_CANCELLED"] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** Flattened ship-to, with Shopify's naming dropped at the boundary. */
export type NormalizedShippingAddress = {
  name: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  /** Uppercased ISO 3166-1 alpha-2. Uppercasing here means every consumer and index can assume one form. */
  countryCode: string | null;
  phone: string | null;
};

export type NormalizedLineItem = {
  shopifyLineItemId: string;
  sku: string | null;
  variantId: string | null;
  title: string;
  quantity: number;
  unitPrice: string;
  fulfillableQuantity: number;
  requiresShipping: boolean;
};

/**
 * The complete desired state of an order, computed by policy and written by the repository.
 *
 * This shape is deliberately "everything, flattened, already normalised". The alternative
 * is passing a raw payload plus a topic and letting the repository decide what to write,
 * which pushes business rules into the persistence layer where they cannot be unit tested
 * and are trivially bypassed by the next caller. Here, application owns *what should be
 * true*; the repository owns only *how to make it true atomically*.
 */
export type OrderIntent = {
  shopDomain: string;
  shopifyOrderId: string;
  orderNumber: number | null;
  customerEmail: string | null;
  currency: string;
  totalPrice: string;
  status: string;
  financialStatus: string | null;
  shipping: NormalizedShippingAddress;
  cancelledAt: Date | null;
  cancelReason: string | null;
  isTestOrder: boolean;
  sourceCreatedAt: Date;
  lineItems: NormalizedLineItem[];
  auditEventType: AuditEventType;
};

/**
 * The outcome of trying to take exclusive ownership of a delivery id.
 *
 * `retry` is the branch that gives the design its value. Without it, a delivery that failed
 * once is indistinguishable from one that succeeded, and the redelivery Shopify sends would
 * be swallowed as a duplicate -- the order would be permanently lost, silently. Collapsing
 * these three states into a boolean `duplicate` is the mistake this type exists to prevent.
 */
export type WebhookDeliveryClaim =
  | { outcome: "claimed"; webhookEventId: string }
  /** Already fully handled. A duplicate delivery: acknowledge and do nothing. */
  | { outcome: "already_processed"; webhookEventId: string }
  /** We have seen this before and it failed. Re-attempt the work. */
  | { outcome: "retry"; webhookEventId: string };

export type AppliedOrder = { orderId: string; created: boolean };

/**
 * Persistence port for Shopify order ingestion.
 *
 * The asymmetry between `claimDelivery`/`recordFailure` (each its own transaction) and
 * `applyOrder` (one transaction covering order + items + audit + event status) is the whole
 * design, and it is what makes a failure observable without weakening atomicity.
 */
export interface ShopifyOrderWebhookRepository {
  /**
   * Records the delivery and takes ownership of it.
   *
   * This must commit on its own. If it shared a transaction with the work it guards, a
   * failure would roll the record back too and we would have no evidence the delivery ever
   * arrived -- which is precisely the state that makes an incident undebuggable.
   */
  claimDelivery(input: {
    shopDomain: string;
    webhookId: string;
    topic: SupportedShopifyOrderTopic;
    rawPayload: unknown;
    triggeredAt: Date | null;
  }): Promise<WebhookDeliveryClaim>;

  /**
   * Writes the order, its items, an audit record, and the terminal `processed` status in a
   * single transaction. All or nothing: an order with no items is never visible, and no
   * event is ever marked processed for work that did not land.
   */
  applyOrder(input: { intent: OrderIntent; webhookEventId: string }): Promise<AppliedOrder>;

  /**
   * Marks a delivery failed, outside the transaction that failed, so the reason survives
   * for operators and for the next redelivery's decision to retry.
   */
  recordFailure(input: { webhookEventId: string; error: FulfillmentError }): Promise<void>;
}

export type ProcessOrderWebhookResult = {
  /**
   * Empty when the delivery was a duplicate: we skipped the work, so there is no order to
   * point at. Returning the pre-existing id here would be a small lie that makes a
   * duplicate look like a successful write in the operations log.
   */
  orderId: string;
  /**
   * True only when this delivery id was already fully handled and we did no work.
   *
   * It deliberately does NOT mean "the order already existed". A fresh `orders/updated`
   * delivery that updates an order we already have is real work, and reporting it as a
   * duplicate would hide genuine updates from the dashboard. `created` carries the
   * other half of the story.
   */
  duplicate: boolean;
  /** Whether this delivery created the order row, as opposed to updating an existing one. */
  created: boolean;
  webhookEventId: string;
  /** Null on a duplicate: we skipped the work, so we do not know which audit type it produced. */
  auditEventType: AuditEventType | null;
};

export class IngestionInvariantError extends ValidationFailedError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { details });
  }
}

function normaliseAddress(address: ShopifyShippingAddress | null): NormalizedShippingAddress {
  return {
    name: address?.name ?? null,
    addressLine1: address?.address1 ?? null,
    addressLine2: address?.address2 ?? null,
    city: address?.city ?? null,
    province: address?.province ?? null,
    postalCode: address?.zip ?? null,
    countryCode: address?.country_code ? address.country_code.toUpperCase() : null,
    phone: address?.phone ?? null,
  };
}

/**
 * Rejects an intent that violates a rule we own, before it reaches the database.
 *
 * Worth the lines: a policy bug (say, marking an order cancelled without a timestamp) is
 * cheap to catch here and expensive to catch as unexplained data six months later. This is
 * validation across a boundary we control, which is exactly where it pays for itself.
 *
 * Exported so it can be tested directly. Every one of these checks is defensive against a
 * *future* refactor rather than reachable from today's payloads -- `buildOrderIntent` derives
 * `status: "cancelled"` from a non-null `cancelledAt`, so the first check cannot fire yet.
 * That is the point: it is a tripwire for the day someone adds a "void" or "on hold" path
 * and forgets to carry the timestamp with it.
 */
export function assertIntentIsCoherent(intent: OrderIntent): void {
  if (intent.lineItems.length === 0) {
    throw new IngestionInvariantError("An order intent must contain at least one line item.", {
      shopifyOrderId: intent.shopifyOrderId,
    });
  }

  if (intent.status === "cancelled" && intent.cancelledAt === null) {
    throw new IngestionInvariantError("A cancelled order must carry a cancellation timestamp.", {
      shopifyOrderId: intent.shopifyOrderId,
    });
  }

  // Deliberately NO check for shippable lines missing a SKU, and this is a change from Phase 2.
  //
  // Phase 2 threw when *every* shippable line had no SKU, on the theory that a wholly
  // unroutable order is a bad payload. That contradicted the `order_items.sku` column, which
  // is nullable precisely because real Shopify orders contain custom products and
  // mis-catalogued variants, and it contradicted the partially-unroutable case this same
  // function already allowed. One order with one mystery line was rejected; the same order
  // with one mystery line *and* one real line was accepted. The line between them was not a
  // rule, it was an accident of how the filter was written.
  //
  // A missing SKU is now `Order.problems()` -> `selectWarehouse` -> an unroutable exception
  // for a human, so the order is stored, the revenue is visible, and the missing line is
  // named. Ingestion only rejects orders it cannot faithfully represent at all.
}

/**
 * Turns a validated payload plus its topic into the order state we want persisted.
 *
 * This is the policy seam, and it is where the two pieces of evidence have to be combined.
 * A cancellation can be signalled two ways and both must be honoured:
 *
 *   - the topic is `orders/cancelled` (Shopify is telling us this delivery is a cancellation), or
 *   - the payload carries `cancelled_at` (the order itself is cancelled).
 *
 * Trusting only the second is a trap I hit in live testing: a cancellation delivery whose
 * payload omitted `cancelled_at` wrote `status = "pending"` and left a dead order sitting in
 * the pick queue. Trusting only the first is worse in the other direction, because a
 * redelivered `orders/updated` for an order cancelled moments earlier would resurrect it.
 * So: either signal cancels, and `receivedAt` backfills the timestamp when Shopify did not
 * send one, keeping "cancelled implies we know when" true.
 *
 * The clock is a parameter rather than a `new Date()` call so this function stays pure and
 * testable, and so a redelivery records when we learned rather than when the order was
 * cancelled, which are genuinely different facts.
 */
export function buildOrderIntent(input: {
  shopDomain: string;
  payload: ShopifyOrderWebhook;
  topic: SupportedShopifyOrderTopic;
  receivedAt: Date;
}): OrderIntent {
  const { shopDomain, payload, topic, receivedAt } = input;

  const cancelledByTopic = topic === "orders/cancelled";
  const cancelled = cancelledByTopic || payload.cancelled_at !== null;
  const status = cancelled ? "cancelled" : "pending";
  const auditEventType: AuditEventType = cancelled ? "ORDER_CANCELLED" : topic === "orders/updated" ? "ORDER_UPDATED" : "ORDER_CREATED";

  const intent: OrderIntent = {
    shopDomain,
    shopifyOrderId: payload.id,
    orderNumber: payload.order_number ?? null,
    customerEmail: payload.email,
    currency: payload.currency.toUpperCase(),
    totalPrice: payload.total_price,
    status,
    financialStatus: payload.financial_status,
    shipping: normaliseAddress(payload.shipping_address),
    cancelledAt: payload.cancelled_at ?? (cancelledByTopic ? receivedAt : null),
    cancelReason: payload.cancel_reason,
    isTestOrder: payload.test,
    sourceCreatedAt: new Date(payload.created_at),
    lineItems: payload.line_items.map((lineItem) => ({
      shopifyLineItemId: lineItem.id,
      sku: lineItem.sku,
      variantId: lineItem.variant_id,
      title: lineItem.title,
      quantity: lineItem.quantity,
      unitPrice: lineItem.price,
      // Fall back to the ordered quantity so downstream readers never branch on null.
      fulfillableQuantity: lineItem.fulfillable_quantity ?? lineItem.quantity,
      requiresShipping: lineItem.requires_shipping,
    })),
    auditEventType,
  };

  assertIntentIsCoherent(intent);
  return intent;
}

/**
 * Normalises the send-time header, or gives up and records nothing.
 *
 * Three inputs matter, and the third is the reason this is a function rather than a cast:
 * `receivedAt` would be a lie about when the delivery happened, and a fallback on
 * unparseable input is a lie of a different kind -- a plausible timestamp that will be read
 * later as if Shopify had sent it. Storing null is honest, and it is distinguishable from
 * "Shopify sent no header", which is the other thing null could mean, by comparing against
 * `received_at` on the same row.
 */
const normaliseTriggeredAt = (value: string | Date | null | undefined): Date | null => {
  if (value === null || value === undefined || value === "") return null;

  const parsed = value instanceof Date ? value : new Date(value);
  // `new Date("nonsense")` is an Invalid Date, not a throw, and its `toISOString()` is
  // "Invalid Date" -- which Postgres rejects. Hence the explicit check.
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * Orchestrates one Shopify delivery.
 *
 * Order of operations, and the reasoning:
 *
 *   1. Verify the signature. Done by the transport before we get here; an unauthenticated
 *      caller must not be able to write a single row.
 *   2. Claim the delivery id. Commits immediately, so a later crash leaves evidence.
 *   3. Acknowledge and return if it was already processed. The correct response to a
 *      duplicate is 200, not an error: Shopify retries on non-2xx, and re-delivering work
 *      we already completed wastes everyone's time.
 *   4. Apply the order atomically.
 *   5. On failure, record it and re-throw. The error is re-thrown rather than swallowed so
 *      the transport can return a 5xx, which is what actually triggers Shopify's redelivery
 *      and our own retry policy.
 */
export async function processShopifyOrderWebhook(
  repository: ShopifyOrderWebhookRepository,
  input: {
    shopDomain: string;
    webhookId: string;
    topic: SupportedShopifyOrderTopic;
    payload: ShopifyOrderWebhook;
    rawPayload: string;
    /**
     * When Shopify says it fired the delivery, from `x-shopify-triggered-at`.
     *
     * Accepted as a string because that is what an HTTP header is, and normalised here rather
     * than in the transport so the unparseable case is a tested decision instead of an
     * `Invalid Date` that silently becomes a non-null column.
     */
    triggeredAt?: string | Date | null;
  },
): Promise<ProcessOrderWebhookResult> {
  const { shopDomain, webhookId, topic, payload } = input;
  // Captured once, before any await, so the fallback cancellation timestamp below and the
  // order's own timestamps agree on when we received this.
  const receivedAt = new Date();

  const claim = await repository.claimDelivery({
    shopDomain,
    webhookId,
    topic,
    rawPayload: JSON.parse(input.rawPayload) as unknown,
    triggeredAt: normaliseTriggeredAt(input.triggeredAt),
  });

  if (claim.outcome === "already_processed") {
    return { orderId: "", duplicate: true, created: false, webhookEventId: claim.webhookEventId, auditEventType: null };
  }

  // Everything from here on is fallible, so it all sits inside the try. Building the
  // intent in particular can reject a policy violation, and because the delivery has
  // already been claimed at that point, an unrecorded throw would strand the event in
  // "processing" forever -- visible to nobody and retried by nobody.
  try {
    const intent = buildOrderIntent({ shopDomain, payload, topic, receivedAt });
    const applied = await repository.applyOrder({ intent, webhookEventId: claim.webhookEventId });
    return {
      orderId: applied.orderId,
      duplicate: false,
      created: applied.created,
      webhookEventId: claim.webhookEventId,
      auditEventType: intent.auditEventType,
    };
  } catch (error) {
    await recordFailurePreservingCause(repository, claim.webhookEventId, error);
    throw error;
  }
}

/**
 * Records a failure without ever masking the original error.
 *
 * If `recordFailure` itself throws, the interesting error -- the one that actually
 * explains the incident -- would be replaced by a secondary bookkeeping error. Losing the
 * root cause to lose a status update is a bad trade, so the bookkeeping error is attached
 * as context and the original is what propagates.
 */
async function recordFailurePreservingCause(
  repository: ShopifyOrderWebhookRepository,
  webhookEventId: string,
  error: unknown,
): Promise<void> {
  const asFulfillmentError: FulfillmentError =
    typeof error === "object" && error !== null && "code" in error && "retryable" in error
      ? (error as FulfillmentError)
      : new ValidationFailedError(error instanceof Error ? error.message : "Unknown ingestion failure.", { cause: error });

  try {
    await repository.recordFailure({ webhookEventId, error: asFulfillmentError });
  } catch (recordingError) {
    console.error("Failed to record webhook failure", { webhookEventId, error: asFulfillmentError.toSummary(), recordingError });
  }
}
