import { describe, expect, test } from "bun:test";
import { PersistenceError, UpstreamUnavailableError } from "@repo/domain";
import { shopifyOrderWebhookSchema, type ShopifyOrderWebhook, type SupportedShopifyOrderTopic } from "@repo/validation/shopify";
import {
  assertIntentIsCoherent,
  buildOrderIntent,
  processShopifyOrderWebhook,
  type OrderIntent,
  type ShopifyOrderWebhookRepository,
  type WebhookDeliveryClaim,
} from "./order-ingestion";

/** A fixed clock, so timestamp assertions are exact rather than approximate. */
const RECEIVED = new Date("2026-09-28T12:00:00Z");

function orderPayload(overrides: Record<string, unknown> = {}): ShopifyOrderWebhook {
  return shopifyOrderWebhookSchema.parse({
    id: 820982911,
    order_number: 1001,
    email: "buyer@example.com",
    currency: "usd",
    total_price: "149.99",
    created_at: "2026-09-28T10:00:00Z",
    line_items: [{ id: 1, sku: "KNT-TSHIRT-BLK-M", variant_id: 9, title: "Kinetous Tee", quantity: 2, price: "59.99" }],
    shipping_address: { name: "Ada L", address1: "1 Main St", city: "Austin", province: "TX", zip: "78701", country_code: "us" },
    ...overrides,
  });
}

/**
 * In-memory stand-in for the persistence port.
 *
 * Using a fake here rather than the real Drizzle repository is deliberate: the use case's
 * job is the *policy* (claim, skip, apply, record failure, re-throw), and that policy is
 * worth testing exhaustively without paying a network round trip per assertion. The
 * repository's SQL is covered separately, against a real database, where it belongs.
 */
function createFakeRepository(options: { claim?: () => Promise<WebhookDeliveryClaim>; failApply?: boolean } = {}) {
  const calls: string[] = [];
  const failures: { webhookEventId: string; code: string }[] = [];
  const claimedTriggeredAt: (Date | null)[] = [];
  let appliedIntent: OrderIntent | undefined;

  const repository: ShopifyOrderWebhookRepository = {
    async claimDelivery(input) {
      calls.push(`claim:${input.topic}:${input.webhookId}`);
      claimedTriggeredAt.push(input.triggeredAt);
      if (options.claim) return options.claim();
      return { outcome: "claimed", webhookEventId: "evt-1" };
    },
    async applyOrder({ intent }) {
      calls.push("applyOrder");
      if (options.failApply) throw new PersistenceError("connection terminated unexpectedly", { cause: new Error("ECONNRESET") });
      appliedIntent = intent;
      return { orderId: "order-1", created: true };
    },
    async recordFailure({ webhookEventId, error }) {
      calls.push("recordFailure");
      failures.push({ webhookEventId, code: error.code });
    },
  };

  return { repository, calls, failures, claimedTriggeredAt, getIntent: () => appliedIntent };
}

/**
 * `x-shopify-triggered-at` is the only record of when Shopify *fired* a delivery, as opposed
 * to when we received it. The two answer different questions, and for a webhook that took a
 * day to arrive only one of them is the one you want.
 */
describe("the send-time header", () => {
  const deliver = (triggeredAt?: string | Date | null) => {
    const fake = createFakeRepository();
    return processShopifyOrderWebhook(fake.repository, {
      shopDomain: "kinetous.myshopify.com",
      webhookId: "wh-1",
      topic: "orders/create",
      payload: orderPayload(),
      rawPayload: JSON.stringify(orderPayload()),
      ...(triggeredAt === undefined ? {} : { triggeredAt }),
    }).then(() => fake);
  };

  test("stores Shopify's send time, not our receive time", async () => {
    const fake = await deliver("2026-09-28T09:00:00Z");

    expect(fake.claimedTriggeredAt[0]?.toISOString()).toBe("2026-09-28T09:00:00.000Z");
  });

  test("records null when the header is absent", async () => {
    // Null, not `receivedAt`. Falsely dating the delivery as received-now would make a slow
    // delivery look instant, which is the one thing this column exists to disprove.
    const fake = await deliver();

    expect(fake.claimedTriggeredAt[0]).toBeNull();
  });

  test("records null for an unparseable header rather than an Invalid Date", async () => {
    // `new Date("nope")` does not throw -- it produces a Date whose `toISOString()` is
    // "Invalid Date", which Postgres rejects outright. Failing the whole delivery over a
    // cosmetic header would be worse, and storing a plausible-looking wrong date is worse
    // than storing nothing.
    const fake = await deliver("not-a-date");

    expect(fake.claimedTriggeredAt[0]).toBeNull();
  });

  test("an empty header is absent, not the epoch", async () => {
    const fake = await deliver("");

    expect(fake.claimedTriggeredAt[0]).toBeNull();
  });

  test("accepts an already-parsed Date", async () => {
    const fake = await deliver(new Date("2026-09-28T09:00:00Z"));

    expect(fake.claimedTriggeredAt[0]?.toISOString()).toBe("2026-09-28T09:00:00.000Z");
  });
});

describe("buildOrderIntent", () => {
  test("normalises currency and country code to upper case so every consumer sees one form", () => {
    const intent = buildOrderIntent({ shopDomain: "kinetous.myshopify.com", payload: orderPayload(), topic: "orders/create", receivedAt: RECEIVED });
    expect(intent.currency).toBe("USD");
    expect(intent.shipping.countryCode).toBe("US");
  });

  test("flattens Shopify's address naming into the shape the database stores", () => {
    const intent = buildOrderIntent({ shopDomain: "kinetous.myshopify.com", payload: orderPayload(), topic: "orders/create", receivedAt: RECEIVED });
    expect(intent.shipping).toEqual({
      name: "Ada L",
      addressLine1: "1 Main St",
      addressLine2: null,
      city: "Austin",
      province: "TX",
      postalCode: "78701",
      countryCode: "US",
      phone: null,
    });
  });

  test("tolerates a digital order with no shipping address rather than dropping it", () => {
    // Rejecting this at ingestion would lose a real, fulfillable order. Missing address is
    // a routing problem, reported as an exception later, not a reason to refuse the order.
    const payload = orderPayload({ shipping_address: undefined, line_items: [{ id: 1, title: "Digital Download", quantity: 1, price: "9.99", requires_shipping: false }] });
    const intent = buildOrderIntent({ shopDomain: "kinetous.myshopify.com", payload, topic: "orders/create", receivedAt: RECEIVED });

    expect(intent.shipping.countryCode).toBeNull();
    expect(intent.lineItems[0]?.requiresShipping).toBe(false);
  });

  test("falls fulfillableQuantity back to quantity so downstream readers never branch on null", () => {
    const intent = buildOrderIntent({ shopDomain: "kinetous.myshopify.com", payload: orderPayload(), topic: "orders/create", receivedAt: RECEIVED });
    expect(intent.lineItems[0]?.fulfillableQuantity).toBe(2);
  });

  test("keeps an explicit fulfillable quantity, which diverges after partial fulfilment", () => {
    const payload = orderPayload({ line_items: [{ id: 1, sku: "A", title: "Tee", quantity: 5, price: "10.00", fulfillable_quantity: 2 }] });
    const intent = buildOrderIntent({ shopDomain: "kinetous.myshopify.com", payload, topic: "orders/create", receivedAt: RECEIVED });
    expect(intent.lineItems[0]).toMatchObject({ quantity: 5, fulfillableQuantity: 2 });
  });

  test("marks a test-store order so it can never be allocated to a real warehouse", () => {
    const intent = buildOrderIntent({ shopDomain: "kinetous.myshopify.com", payload: orderPayload({ test: true }), topic: "orders/create", receivedAt: RECEIVED });
    expect(intent.isTestOrder).toBe(true);
  });

  test("chooses the audit type from the topic", () => {
    const build = (topic: SupportedShopifyOrderTopic) => buildOrderIntent({ shopDomain: "s.myshopify.com", payload: orderPayload(), topic, receivedAt: RECEIVED });
    expect(build("orders/create").auditEventType).toBe("ORDER_CREATED");
    expect(build("orders/updated").auditEventType).toBe("ORDER_UPDATED");
  });

  test("a cancelled payload wins over the topic, so a late update cannot resurrect a cancelled order", () => {
    // This is the failure mode that matters operationally: an orders/updated redelivered
    // after a cancellation would otherwise write status=pending and put a dead order back
    // into the pick queue. The payload is the later, authoritative state.
    const intent = buildOrderIntent({
      shopDomain: "s.myshopify.com",
      payload: orderPayload({ cancelled_at: "2026-09-28T11:00:00Z", cancel_reason: "customer" }),
      topic: "orders/updated",
      receivedAt: RECEIVED,
    });
    expect(intent.status).toBe("cancelled");
    expect(intent.auditEventType).toBe("ORDER_CANCELLED");
    expect(intent.cancelReason).toBe("customer");
  });

  test("the orders/cancelled topic cancels even when the payload omits cancelled_at", () => {
    // Found by live testing, not by reasoning. A cancellation delivery whose payload had
    // no cancelled_at wrote status="pending" and left a dead order in the pick queue. The
    // topic alone is sufficient evidence of a cancellation.
    const intent = buildOrderIntent({ shopDomain: "s", payload: orderPayload(), topic: "orders/cancelled", receivedAt: RECEIVED });
    expect(intent.status).toBe("cancelled");
    expect(intent.auditEventType).toBe("ORDER_CANCELLED");
  });

  test("backfills a cancellation timestamp from when we received the delivery", () => {
    // Keeps "cancelled implies we know when" true. It is when we LEARNED, which is a
    // different fact from when the customer cancelled, but it is the best we have and an
    // order with no cancellation time is impossible to reconcile against Shopify's.
    const intent = buildOrderIntent({ shopDomain: "s", payload: orderPayload(), topic: "orders/cancelled", receivedAt: RECEIVED });
    expect(intent.cancelledAt).toEqual(RECEIVED);
  });

  test("a create payload keeps Shopify's own cancellation time when it supplies one", () => {
    const intent = buildOrderIntent({
      shopDomain: "s",
      payload: orderPayload({ cancelled_at: "2026-09-28T11:00:00Z" }),
      topic: "orders/cancelled",
      receivedAt: RECEIVED,
    });
    expect(intent.cancelledAt).toEqual(new Date("2026-09-28T11:00:00Z"));
  });

  test("an ordinary order is not cancelled and carries no cancellation time", () => {
    const intent = buildOrderIntent({ shopDomain: "s", payload: orderPayload(), topic: "orders/create", receivedAt: RECEIVED });
    expect(intent.status).toBe("pending");
    expect(intent.cancelledAt).toBeNull();
  });
});

describe("ingestion invariants", () => {
  const coherent = () => buildOrderIntent({ shopDomain: "s.myshopify.com", payload: orderPayload(), topic: "orders/create", receivedAt: RECEIVED });

  test("rejects a cancelled order with no cancellation timestamp", () => {
    // A tripwire for a future refactor, not a reachable state today. If someone adds a
    // "void" or "on hold" transition and forgets the timestamp, the order would be
    // invisible to cancellation reporting while still sitting in the queue as 'cancelled'.
    const intent: OrderIntent = { ...coherent(), status: "cancelled", cancelledAt: null };
    expect(() => assertIntentIsCoherent(intent)).toThrow(/cancellation timestamp/);
  });

  test("rejects an order with no line items, which should be impossible to even build", () => {
    expect(() => assertIntentIsCoherent({ ...coherent(), lineItems: [] })).toThrow(/at least one line item/);
  });

  test("accepts an order whose only shippable line has no SKU, because routing will raise an exception", () => {
    // Phase 2 threw here. The check made no sense: a *partly* unroutable order was always
    // allowed, so the only thing the throw added was losing revenue for orders that happened
    // to have exactly one mystery line. `order_items.sku` is nullable by design, and an
    // unroutable order is now stored and surfaced rather than rejected at the door.
    const payload = orderPayload({ line_items: [{ id: 1, title: "Mystery Custom Item", quantity: 1, price: "10.00" }] });
    const intent = buildOrderIntent({ shopDomain: "s", payload, topic: "orders/create", receivedAt: RECEIVED });

    expect(intent.lineItems).toHaveLength(1);
    expect(intent.lineItems[0]?.sku).toBeNull();
  });

  test("allows a partly unroutable order, since dropping revenue is worse than a manual exception", () => {
    const payload = orderPayload({
      line_items: [
        { id: 1, sku: "KNT-TSHIRT-BLK-M", title: "Tee", quantity: 1, price: "20.00" },
        { id: 2, title: "Mystery Custom Item", quantity: 1, price: "10.00" },
      ],
    });
    expect(buildOrderIntent({ shopDomain: "s", payload, topic: "orders/create", receivedAt: RECEIVED }).lineItems).toHaveLength(2);
  });

  test("a non-shippable line with no SKU is not an unroutable order", () => {
    // Digital goods legitimately have no SKU, so demanding one would reject every
    // download-only order in the catalogue.
    const payload = orderPayload({ line_items: [{ id: 1, title: "Digital Download", quantity: 1, price: "9.99", requires_shipping: false }] });
    expect(buildOrderIntent({ shopDomain: "s", payload, topic: "orders/create", receivedAt: RECEIVED }).lineItems).toHaveLength(1);
  });
});

describe("processShopifyOrderWebhook", () => {
  const run = (repo: ShopifyOrderWebhookRepository, topic: SupportedShopifyOrderTopic = "orders/create", payload = orderPayload()) =>
    processShopifyOrderWebhook(repo, { shopDomain: "kinetous.myshopify.com", webhookId: "evt-1", topic, payload, rawPayload: JSON.stringify(payload) });

  test("passes the topic through to the claim, so a stored event records what it really was", async () => {
    const { repository, calls } = createFakeRepository();
    await run(repository, "orders/cancelled");
    expect(calls[0]).toBe("claim:orders/cancelled:evt-1");
  });

  test("applies a freshly claimed delivery", async () => {
    const { repository, calls } = createFakeRepository();
    const result = await run(repository);

    expect(calls).toEqual(["claim:orders/create:evt-1", "applyOrder"]);
    expect(result).toMatchObject({ orderId: "order-1", duplicate: false, created: true, auditEventType: "ORDER_CREATED" });
  });

  test("acknowledges a duplicate without doing any work", async () => {
    // The repository returns 200 for a duplicate, so Shopify stops redelivering. Treating
    // this as an error instead would make Shopify retry completed work for hours.
    const { repository, calls } = createFakeRepository({
      claim: async () => ({ outcome: "already_processed", webhookEventId: "evt-1" }),
    });
    const result = await run(repository);

    expect(calls).toEqual(["claim:orders/create:evt-1"]);
    expect(result).toMatchObject({ orderId: "", duplicate: true, created: false, auditEventType: null });
  });

  test("re-attempts a delivery that previously failed", async () => {
    // The case a boolean 'duplicate' flag cannot express. This delivery id was seen before
    // and genuinely failed, so acknowledging it as a duplicate would lose the order
    // permanently and leave no error anywhere to explain why.
    const { repository, calls } = createFakeRepository({
      claim: async () => ({ outcome: "retry", webhookEventId: "evt-1" }),
    });
    const result = await run(repository);

    expect(calls).toEqual(["claim:orders/create:evt-1", "applyOrder"]);
    expect(result.duplicate).toBe(false);
  });

  test("records the failure and re-throws, so the transport can answer 5xx and trigger a redelivery", async () => {
    const { repository, calls, failures } = createFakeRepository({ failApply: true });

    await expect(run(repository)).rejects.toThrow("connection terminated unexpectedly");
    expect(calls).toEqual(["claim:orders/create:evt-1", "applyOrder", "recordFailure"]);
    expect(failures).toEqual([{ webhookEventId: "evt-1", code: "PERSISTENCE_FAILED" }]);
  });

  test("records a validation rejection too, so the event is never stranded in processing", async () => {
    // buildOrderIntent runs after the claim, inside the try. If it were outside, a malformed
    // payload would leave the event claimed forever: visible to nobody, retried by nobody.
    //
    // This previously used the missing-SKU policy rejection, which Phase 4 removed.
    // `assertIntentIsCoherent`'s empty-basket check is what catches it now, and note that it
    // fires here rather than a Zod error: `buildOrderIntent` takes an already-validated
    // `ShopifyOrderWebhook` and does not re-parse, so the API layer is what rejects a
    // malformed payload. This test therefore also pins that the defensive invariant inside
    // `buildOrderIntent` is reachable and does not strand the delivery.
    const { repository, calls, failures } = createFakeRepository();

    // Cast rather than `orderPayload`, because that helper validates on the way in and would
    // throw in the test body -- before the claim, so it would prove nothing about the
    // try/catch this test exists for. The claim must happen first, then the rejection. This
    // simulates a payload the HTTP layer let through, which is exactly the situation the
    // defensive invariant exists to catch.
    const emptyBasket = {
      id: 820982911,
      currency: "usd",
      total_price: "10.00",
      created_at: "2026-09-28T10:00:00Z",
      line_items: [],
    } as unknown as ShopifyOrderWebhook;

    await expect(run(repository, "orders/create", emptyBasket)).rejects.toThrow(/at least one line item/);
    expect(calls).toContain("recordFailure");
    expect(failures[0]?.code).toBe("VALIDATION_FAILED");
  });

  test("does not let a bookkeeping failure mask the original error", async () => {
    // If recording the failure itself throws, the interesting error -- the one that
    // explains the incident -- must still be what propagates.
    const repository: ShopifyOrderWebhookRepository = {
      async claimDelivery() {
        return { outcome: "claimed", webhookEventId: "evt-1" };
      },
      async applyOrder() {
        throw new UpstreamUnavailableError("shopify admin api timed out");
      },
      async recordFailure() {
        throw new Error("audit log table is also unreachable");
      },
    };

    // This path logs by design. Silenced here so a real failure later in the suite is not
    // lost in expected noise.
    const logged = console.error;
    console.error = () => {};
    try {
      await expect(run(repository)).rejects.toThrow("shopify admin api timed out");
    } finally {
      console.error = logged;
    }
  });
});
