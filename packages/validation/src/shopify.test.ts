import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { isSupportedShopifyOrderTopic, parseShopifyOrderWebhook, shopifyOrderWebhookSchema, verifyShopifyWebhookSignature } from "./shopify";

const validOrder = {
  id: 820982911,
  order_number: 1001,
  email: "buyer@example.com",
  currency: "USD",
  total_price: "149.99",
  created_at: "2026-09-28T10:00:00Z",
  line_items: [{ id: 1, sku: "KNT-TSHIRT-BLK-M", title: "Kinetous Tee", quantity: 2, price: "59.99" }],
  shipping_address: { name: "Ada L", address1: "1 Main St", city: "Austin", province: "TX", zip: "78701", country_code: "US" },
};

describe("signature verification", () => {
  const secret = "shopify-test-secret";

  test("accepts a Shopify HMAC calculated from the unmodified raw payload", () => {
    const body = '{"id":123}';
    const signature = createHmac("sha256", secret).update(body).digest("base64");

    expect(verifyShopifyWebhookSignature(body, signature, secret)).toBe(true);
    // Re-serialising the JSON changes the bytes and must invalidate the signature. This is
    // why the endpoint verifies against the raw body and never a re-parsed object.
    expect(verifyShopifyWebhookSignature(`${body} `, signature, secret)).toBe(false);
  });

  test("rejects a missing, empty, or wrong-length signature without throwing", () => {
    // A short forged value must not reach timingSafeEqual, which throws on a length
    // mismatch. An unauthenticated endpoint turning that into a 500 is a free DoS.
    const body = '{"id":123}';
    expect(verifyShopifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyShopifyWebhookSignature(body, "", secret)).toBe(false);
    expect(verifyShopifyWebhookSignature(body, "c2hvcnQ=", secret)).toBe(false);
  });
});

describe("payload rejection", () => {
  test("rejects an order with no line items", () => {
    const result = shopifyOrderWebhookSchema.safeParse({ ...validOrder, line_items: [] });
    expect(result.success).toBe(false);
  });

  test("rejects a non-positive quantity", () => {
    const result = shopifyOrderWebhookSchema.safeParse({ ...validOrder, line_items: [{ id: 1, title: "T", quantity: 0, price: "1.00" }] });
    expect(result.success).toBe(false);
  });

  test("rejects a currency that is not a 3-character code", () => {
    // Catching "DOLLARS" here means it never reaches a payment provider as a currency.
    expect(shopifyOrderWebhookSchema.safeParse({ ...validOrder, currency: "DOLLARS" }).success).toBe(false);
    expect(shopifyOrderWebhookSchema.safeParse({ ...validOrder, currency: "US" }).success).toBe(false);
  });

  test("rejects a created_at that is not an ISO datetime with an offset", () => {
    expect(shopifyOrderWebhookSchema.safeParse({ ...validOrder, created_at: "yesterday" }).success).toBe(false);
    // No offset means unparseable time semantics; we refuse rather than assume UTC.
    expect(shopifyOrderWebhookSchema.safeParse({ ...validOrder, created_at: "2026-09-28T10:00:00" }).success).toBe(false);
  });

  test("rejects an unknown financial_status rather than storing a typo", () => {
    expect(shopifyOrderWebhookSchema.safeParse({ ...validOrder, financial_status: "partiailly_paid" }).success).toBe(false);
    expect(shopifyOrderWebhookSchema.safeParse({ ...validOrder, financial_status: "paid" }).success).toBe(true);
  });

  test("rejects an unknown cancel_reason", () => {
    expect(shopifyOrderWebhookSchema.safeParse({ ...validOrder, cancelled_at: "2026-09-28T11:00:00Z", cancel_reason: "because" }).success).toBe(false);
  });

  test("reports malformed JSON as a validation failure rather than a SyntaxError", () => {
    // One error shape for the caller, whichever way the body was wrong.
    expect(() => parseShopifyOrderWebhook("{not json")).toThrow();
  });
});

describe("lenient defaults, deliberately", () => {
  test("accepts an order with no shipping address", () => {
    // A digital-only order has no address, and rejecting it would lose a fulfillable order.
    const parsed = parseShopifyOrderWebhook(JSON.stringify({ ...validOrder, shipping_address: undefined }));
    expect(parsed.shipping_address).toBeNull();
  });

  test("accepts an order with no email", () => {
    expect(parseShopifyOrderWebhook(JSON.stringify({ ...validOrder, email: null })).email).toBeNull();
  });

  test("defaults test to false, so an absent flag behaves as a real order", () => {
    expect(parseShopifyOrderWebhook(JSON.stringify(validOrder)).test).toBe(false);
    expect(parseShopifyOrderWebhook(JSON.stringify({ ...validOrder, test: true })).test).toBe(true);
  });

  test("defaults requires_shipping to true, because guessing false would skip a real item", () => {
    const parsed = parseShopifyOrderWebhook(JSON.stringify(validOrder));
    expect(parsed.line_items[0]?.requires_shipping).toBe(true);
  });

  test("normalises numeric and string ids to strings", () => {
    // Shopify is inconsistent between surfaces: the webhook sends a number, the Admin API
    // can send a string. Normalising once here keeps every consumer from handling both.
    const parsed = parseShopifyOrderWebhook(JSON.stringify({ ...validOrder, id: "820982911" }));
    expect(parsed.id).toBe("820982911");
  });
});

describe("topic support", () => {
  test("accepts exactly the topics this platform implements", () => {
    expect(isSupportedShopifyOrderTopic("orders/create")).toBe(true);
    expect(isSupportedShopifyOrderTopic("orders/updated")).toBe(true);
    expect(isSupportedShopifyOrderTopic("orders/cancelled")).toBe(true);
  });

  test("refuses an unimplemented topic instead of guessing at its meaning", () => {
    // Silently treating orders/paid as orders/create would write a false audit trail, and
    // a 200 would stop Shopify ever telling us about it again.
    expect(isSupportedShopifyOrderTopic("orders/paid")).toBe(false);
    expect(isSupportedShopifyOrderTopic("refunds/create")).toBe(false);
  });
});
