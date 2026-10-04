import { isFulfillmentError, type FulfillmentErrorCode } from "@repo/domain";

/**
 * Transport concern: how a domain failure becomes an HTTP response.
 *
 * This lives in the web tier, not in `@repo/domain`, for the reason documented there. The
 * domain decides *what went wrong and whether it is worth retrying*; the transport decides
 * what that means on the wire.
 *
 * The mapping is driven by `retryable` rather than by per-error special cases, which is
 * exactly why that flag lives on the error. Shopify redelivers any non-2xx response, so
 * the status we return is not cosmetic -- it is the retry instruction.
 *
 *   - `retryable: true`  -> 5xx. Transient, so we want the caller or Shopify to come back.
 *   - `retryable: false` -> 4xx. Deterministic. Retrying identical bytes produces the
 *     identical rejection, so a 200 would falsely claim we accepted the work, and a 5xx
 *     would trigger pointless retries until the sender gives up. For a webhook, a
 *     permanently bad payload is instead quarantined as `failed` with a reason, which is
 *     visible to an operator, rather than quietly discarded.
 *
 * `PERSISTENCE_FAILED` is the honest exception to a clean rule. It is marked retryable,
 * because a dropped connection genuinely is, so it maps to 500 and the sender retries. But
 * a constraint violation surfaces as the same error class and is not retryable at all. We
 * accept that imprecision because the alternative -- splitting persistence failures into two
 * types at the driver boundary -- would mean translating every postgres error code, which
 * is a large, brittle surface for a distinction that the retry layer tolerates either way.
 */
const STATUS_BY_CODE: Record<FulfillmentErrorCode, number> = {
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  CONFLICT: 422,
  INVALID_STATE_TRANSITION: 409,
  UPSTREAM_REJECTED: 422,
  UPSTREAM_UNAVAILABLE: 503,
  PERSISTENCE_FAILED: 500,
};

/**
 * Messages sent to the caller. Deliberately generic and fixed per code.
 *
 * We do NOT forward `error.message` even though our domain messages are written to be safe,
 * because "written to be safe" is a convention that decays: the first `ValidationFailedError`
 * carrying a field value straight out of a Zod issue would leak request content into a
 * response body. A fixed string per code cannot drift that way, and the detail an operator
 * needs belongs in the logs, keyed by requestId.
 */
const SAFE_MESSAGE_BY_CODE: Record<FulfillmentErrorCode, string> = {
  VALIDATION_FAILED: "The request payload did not satisfy the required shape.",
  NOT_FOUND: "The requested resource does not exist.",
  CONFLICT: "The request conflicts with the current state of the resource.",
  INVALID_STATE_TRANSITION:
    "The requested operation is not allowed in the current state.",
  UPSTREAM_REJECTED: "An upstream service rejected the request.",
  UPSTREAM_UNAVAILABLE: "An upstream service is unavailable. Please retry.",
  PERSISTENCE_FAILED: "The request could not be persisted.",
};

export type ApiErrorBody = {
  error: {
    code: FulfillmentErrorCode;
    message: string;
    requestId: string;
  };
};

export function toApiError(
  error: unknown,
  requestId: string,
): { status: number; body: ApiErrorBody } {
  if (!isFulfillmentError(error)) {
    return {
      status: 500,
      body: {
        error: {
          code: "PERSISTENCE_FAILED",
          message: "An unexpected error occurred.",
          requestId,
        },
      },
    };
  }

  const code = error.code;
  return {
    status: STATUS_BY_CODE[code] ?? 500,
    body: {
      error: {
        code,
        message: SAFE_MESSAGE_BY_CODE[code] ?? "An unexpected error occurred.",
        requestId,
      },
    },
  };
}
