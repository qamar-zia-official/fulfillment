export interface FulfillmentJobDispatcher {
  dispatch(input: { fulfillmentId: string; idempotencyKey: string }): Promise<void>;
}
