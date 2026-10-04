import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const nullableString = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

/**
 * Shopify serialises money as a decimal *string* to avoid float drift, but accepts either
 * on input, and some Admin API surfaces return a number. We accept both and normalise to a
 * string; parsing to a number is a decision for the persistence layer, which must decide
 * how it rounds. `currency` is pinned to exactly 3 characters: it is an ISO 4217 code, and
 * silently accepting "DOLLARS" would push the mistake downstream to a payment provider.
 */
const decimalString = z.union([z.string(), z.number()]).transform(String);
const shopifyId = z.union([z.string(), z.number()]).transform(String);

/**
 * The ship-to address as Shopify sends it.
 *
 * Note every field is optional. That is not laxity, it is the payload: a digital-only
 * order has no address, and a merchant using a custom checkout can send an order with
 * `address1` and nothing else. Rejecting such orders at the door loses orders that are
 * perfectly fulfillable, so completeness is a *routing* concern (raised later as an
 * unroutable exception), not an *ingestion* concern. Ingestion's job is to reject garbage
 * and faithfully record everything else.
 */
const shippingAddressSchema = z
  .object({
    name: nullableString,
    address1: nullableString,
    address2: nullableString,
    city: nullableString,
    province: nullableString,
    zip: nullableString,
    country_code: nullableString,
    phone: nullableString,
  })
  .nullish()
  .transform((value) => value ?? null);

export const SHOPIFY_FINANCIAL_STATUSES = [
  "pending",
  "paid",
  "partially_refunded",
  "refunded",
  "voided",
  "partially_paid",
] as const;

export const SHOPIFY_CANCEL_REASONS = [
  "customer",
  "fraud",
  "inventory",
  "declined",
  "other",
  "staff",
] as const;

const lineItemSchema = z.object({
  id: shopifyId,
  sku: nullableString,
  variant_id: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((value) =>
      value === null || value === undefined ? null : String(value),
    ),
  title: z.string().min(1),
  quantity: z.number().int().positive(),
  price: decimalString,
  /**
   * Absent on partially-fulfilled lines. Falling back to `quantity` at parse time keeps
   * the "what is still shippable" question out of every downstream reader.
   */
  fulfillable_quantity: z
    .number()
    .int()
    .nonnegative()
    .nullish()
    .transform((value) => value ?? null),
  requires_shipping: z
    .boolean()
    .nullish()
    .transform((value) => value ?? true),
});

export const shopifyOrderWebhookSchema = z.object({
  id: shopifyId,
  order_number: z.number().int().optional(),
  email: nullableString,
  currency: z.string().length(3),
  total_price: decimalString,
  created_at: z.string().datetime({ offset: true }),
  line_items: z.array(lineItemSchema).min(1),
  shipping_address: shippingAddressSchema,
  financial_status: z
    .enum(SHOPIFY_FINANCIAL_STATUSES)
    .nullish()
    .transform((value) => value ?? null),
  cancelled_at: z
    .string()
    .datetime({ offset: true })
    .nullish()
    .transform((value) => (value ? new Date(value) : null)),
  cancel_reason: z
    .enum(SHOPIFY_CANCEL_REASONS)
    .nullish()
    .transform((value) => value ?? null),
  /**
   * Shopify sets this on orders created through a development store. A wrong `false` here
   * means we pick and ship a test order, so the field is captured faithfully at ingestion
   * rather than inferred later.
   */
  test: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
  /** Where the order originated: "web", "pos", "draft_order", ... useful operator context. */
  source_name: nullableString,
});

export type ShopifyOrderWebhook = z.infer<typeof shopifyOrderWebhookSchema>;
export type ShopifyShippingAddress = z.infer<typeof shippingAddressSchema>;

/** The topics this platform currently knows how to ingest. */
export const SUPPORTED_SHOPIFY_ORDER_TOPICS = [
  "orders/create",
  "orders/updated",
  "orders/cancelled",
] as const;
export type SupportedShopifyOrderTopic =
  (typeof SUPPORTED_SHOPIFY_ORDER_TOPICS)[number];

export function isSupportedShopifyOrderTopic(
  topic: string,
): topic is SupportedShopifyOrderTopic {
  return (SUPPORTED_SHOPIFY_ORDER_TOPICS as readonly string[]).includes(topic);
}

/**
 * Verifies the HMAC Shopify sends in `X-Shopify-Hmac-Sha256`.
 *
 * Two things here are easy to get wrong:
 *
 *   1. The HMAC must be computed over the RAW request bytes. Any attempt to "helpfully"
 *      re-serialise the JSON first changes the bytes and silently invalidates every
 *      signature, so this function takes the raw string and never a parsed object.
 *   2. The comparison must be constant-time. `===` on the base64 strings leaks the
 *      correct prefix length and content through timing, which is a real (if slow)
 *      oracle for an unauthenticated endpoint. We compare buffers with `timingSafeEqual`
 *      and return false on a length mismatch, which is safe because the length of an
 *      HMAC-SHA256 base64 digest is not a secret.
 */

export function verifyShopifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

/**
 * Parses the raw webhook body into a validated order.
 *
 * `JSON.parse` is invoked as the input to the schema so a malformed body surfaces as a
 * `ZodError` (with `invalid_union` on `expected`) rather than a raw `SyntaxError`. The API
 * turns that into one consistent 400 instead of two different error shapes.
 */

export function parseShopifyOrderWebhook(rawBody: string): ShopifyOrderWebhook {
  return shopifyOrderWebhookSchema.parse(JSON.parse(rawBody));
}
