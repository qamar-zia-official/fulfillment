import { FulfillmentProviderError, type FulfillmentProvider, type FulfillmentSubmission, type FulfillmentSubmissionResult } from "./fulfillment-provider";

export type MockFulfillmentOutcome = "success" | "validation_failure" | "temporary_failure" | "timeout" | "unknown_error";

export class MockFulfillmentProvider implements FulfillmentProvider {
  private readonly requests = new Map<string, string>();

  constructor(private readonly outcome: MockFulfillmentOutcome = "success") {}

  async submitFulfillment(submission: FulfillmentSubmission): Promise<FulfillmentSubmissionResult> {
    const existing = this.requests.get(submission.idempotencyKey);
    if (existing) return { providerRequestId: existing, status: "duplicate" };
    if (submission.lines.length === 0) throw new FulfillmentProviderError("A fulfillment must contain at least one line.", "validation", false);

    if (this.outcome === "validation_failure") throw new FulfillmentProviderError("The destination address could not be validated.", "validation", false);
    if (this.outcome === "temporary_failure") throw new FulfillmentProviderError("The provider is temporarily unavailable.", "temporary", true);
    if (this.outcome === "timeout") throw new FulfillmentProviderError("The provider request timed out.", "timeout", true);
    if (this.outcome === "unknown_error") throw new FulfillmentProviderError("The provider returned an unexpected error.", "unknown", true);

    const providerRequestId = `mock_3pl_${crypto.randomUUID()}`;
    this.requests.set(submission.idempotencyKey, providerRequestId);
    return { providerRequestId, status: "accepted" };
  }
}
