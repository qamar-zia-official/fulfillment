import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { prettyJSON } from "hono/pretty-json";
import { processShopifyOrderWebhook } from "@repo/application";
import { getAuth, isOperator } from "@repo/auth";
import { createExceptionOperationsRepository, createShopifyOrderWebhookRepository, getDb } from "@repo/db";
import { ValidationFailedError } from "@repo/domain";
import {
  isSupportedShopifyOrderTopic,
  parseShopifyOrderWebhook,
  SUPPORTED_SHOPIFY_ORDER_TOPICS,
  verifyShopifyWebhookSignature,
  type ShopifyOrderWebhook,
} from "@repo/validation/shopify";
import { corsMiddleware } from "./cors";
import { onApiError } from "./error-handler";
import { createOperationsRoutes, type OperationsActor } from "./operations";

const app = new Hono<{ Variables: { requestId: string } }>();
app.use("*", prettyJSON());

app.use("*", async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);
  await next();
});

app.onError(onApiError);

/**
 * CORS, mounted after the request-id middleware so a preflight response carries an id too.
 *
 * The operations API is consumed by a browser on another origin, and the browser will not hand
 * JavaScript a response without an explicit `Access-Control-Allow-Origin`. See `cors.ts` for why
 * the list is derived from the same variables as Better Auth's `trustedOrigins` and why an unset
 * variable authorises nobody rather than falling back to a wildcard.
 */
app.use("*", corsMiddleware());

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "kinetous-fulfillment-api",
    timestamp: new Date().toISOString(),
    requestId: c.get("requestId"),
  });
});

app.all("/api/auth/*", (c) => getAuth().handler(c.req.raw));

/**
 * The operations API: the exception queue and closing an entry on it.
 *
 * Wired here rather than in a module that calls `getAuth()` itself, so the session lookup is
 * the only thing injected and the guards can be tested without a session. The `betterAuth`
 * `getSession` wrapper is thin on purpose: a session exists, or it does not, and the policy
 * question -- is this account an operator -- is answered by `isOperator` in the routes.
 */
app.route(
  "/api/operations",
  createOperationsRoutes({
    resolveRepository: () => createExceptionOperationsRepository(getDb()),
    resolveOperator: async (headers): Promise<OperationsActor | null> => {
      const result = await getAuth().api.getSession({ headers });
      return result?.user?.email ? { email: result.user.email } : null;
    },
    isOperator,
  }),
);

/**
 * Shopify order ingestion.
 *
 * The order of the guards below is the security-relevant part:
 *
 *   1. Configuration and header presence.
 *   2. HMAC over the RAW bytes. Until this passes, the request is unauthenticated and must
 *      not cause a single row to be written -- not even a rejected-delivery record, because
 *      that would let an anonymous caller fill the table.
 *   3. Topic support, then payload validation.
 *   4. Only then, persistence.
 *
 * Note the raw body is read once and reused for both the signature check and the parse.
 * Re-reading `c.req.json()` after the HMAC check would be a subtle correctness bug: the
 * signature must cover the exact bytes Shopify sent, and a second parse risks validating
 * against different content.
 */
app.post("/webhooks/shopify/orders", async (c) => {
  const requestId = c.get("requestId");
  const signature = c.req.header("x-shopify-hmac-sha256");
  const webhookId = c.req.header("x-shopify-webhook-id");
  const shopDomain = c.req.header("x-shopify-shop-domain");
  const topic = c.req.header("x-shopify-topic");
  const triggeredAt = c.req.header("x-shopify-triggered-at");
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!secret || !webhookId || !shopDomain || !topic) {
    throw new HTTPException(400, { message: "Missing required Shopify webhook headers or configuration." });
  }

  const rawPayload = await c.req.text();

  if (!verifyShopifyWebhookSignature(rawPayload, signature, secret)) {
    throw new HTTPException(401, { message: "Invalid Shopify webhook signature." });
  }

  // The topic tells us what the payload MEANS. An unrecognised topic is refused rather than
  // guessed at: silently treating "orders/paid" as "orders/create" would write the wrong
  // audit trail, and a 200 would stop Shopify ever telling us about it again.
  //
  // The message names what we DO support instead of echoing the received value. Reflecting
  // an unvalidated header back to the caller is a habit worth breaking regardless of the
  // content type: it invites log injection and reflected-XSS if this response is ever
  // rendered, and an attacker learns our parsing is loose. A fixed string also cannot be
  // used to reflect megabytes of header back at us.
  if (!isSupportedShopifyOrderTopic(topic)) {
    throw new HTTPException(422, {
      message: `Unsupported Shopify topic. Supported: ${SUPPORTED_SHOPIFY_ORDER_TOPICS.join(", ")}.`,
    });
  }

  let payload: ShopifyOrderWebhook;
  try {
    payload = parseShopifyOrderWebhook(rawPayload);
  } catch (error) {
    // Field-level detail is logged but not returned: a 422 body echoing the rejected shape
    // helps an attacker map our schema, and the sender is Shopify, who can read our logs.
    console.warn("Rejected Shopify order webhook payload", { requestId, topic, error });
    throw new ValidationFailedError("Shopify order webhook payload failed validation.");
  }

  const result = await processShopifyOrderWebhook(createShopifyOrderWebhookRepository(getDb()), {
    shopDomain,
    webhookId,
    topic,
    payload,
    rawPayload,
    // Threaded through rather than dropped: the column exists to answer "how late was this?",
    // which is a different question from "when did we receive it?" and the only way to answer
    // the first is to have kept the second.
    triggeredAt,
  });

  return c.json(
    {
      accepted: true,
      duplicate: result.duplicate,
      created: result.created,
      orderId: result.orderId || undefined,
      webhookEventId: result.webhookEventId,
      auditEventType: result.auditEventType ?? undefined,
      requestId,
    },
    200,
  );
});

export default app;
