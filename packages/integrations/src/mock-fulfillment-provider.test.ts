import { expect, test } from "bun:test";
import { MockFulfillmentProvider } from "./mock-fulfillment-provider";

const submission = { idempotencyKey: "fulfillment_123", externalOrderReference: "order_123", destination: { countryCode: "US", postalCode: "10001" }, lines: [{ sku: "SKU-1", quantity: 1 }] };

test("returns the original provider request for duplicate fulfillment submissions", async () => {
  const provider = new MockFulfillmentProvider();
  const first = await provider.submitFulfillment(submission);
  const second = await provider.submitFulfillment(submission);

  expect(first.status).toBe("accepted");
  expect(second).toEqual({ providerRequestId: first.providerRequestId, status: "duplicate" });
});

test("marks a simulated provider outage as retryable", async () => {
  const provider = new MockFulfillmentProvider("temporary_failure");
  await expect(provider.submitFulfillment(submission)).rejects.toMatchObject({ kind: "temporary", retryable: true });
});
