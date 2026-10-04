export type FulfillmentLine = { sku: string; quantity: number };

export type FulfillmentSubmission = {
  idempotencyKey: string;
  externalOrderReference: string;
  destination: { countryCode: string; postalCode: string };
  lines: FulfillmentLine[];
};

export type FulfillmentSubmissionResult = {
  providerRequestId: string;
  status: "accepted" | "duplicate";
};

export class FulfillmentProviderError extends Error {
  constructor(message: string, readonly kind: "validation" | "temporary" | "timeout" | "unknown", readonly retryable: boolean) {
    super(message);
    this.name = "FulfillmentProviderError";
  }
}

export interface FulfillmentProvider {
  submitFulfillment(submission: FulfillmentSubmission): Promise<FulfillmentSubmissionResult>;
}
