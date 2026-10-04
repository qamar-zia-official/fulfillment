/**
 * Framework-independent error taxonomy.
 *
 * Two rules shape this file.
 *
 * 1. No HTTP concepts here. A status code is a transport decision made by the web tier.
 *    Putting `status: 404` in the domain couples the domain to HTTP and makes the same
 *    failure impossible to describe from a Trigger.dev job or a CLI. Each error instead
 *    carries a stable `code` and a `retryable` flag, and the transport maps those to
 *    status codes (see apps/api).
 *
 * 2. `retryable` is a property of the failure, not a guess made by the caller. This is the
 *    single most useful field in the file: it is what tells Shopify to redeliver a
 *    webhook, what configures a Trigger.dev retry policy, and what stops a worker from
 *    spinning on a permanently bad payload. A caller that has to decide "should I retry
 *    this?" is being handed a problem it cannot answer.
 *
 * A failure whose retryability depends on *which* code path produced it is a sign the
 * boundary is wrong.
 */

export type FulfillmentErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE_TRANSITION"
  | "UPSTREAM_REJECTED"
  | "UPSTREAM_UNAVAILABLE"
  | "PERSISTENCE_FAILED";

/** Serialisable detail safe to log. Never put secrets or raw upstream bodies in here. */
export type ErrorDetails = Record<string, unknown>;

export abstract class FulfillmentError extends Error {
  abstract readonly code: FulfillmentErrorCode;
  abstract readonly retryable: boolean;

  readonly details?: ErrorDetails;

  /** Preserved so a thrown error still formats usefully in logs and in `Error.cause`. */
  constructor(message: string, options: { details?: ErrorDetails; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.details = options.details;
  }

  /**
   * A log/response-safe projection. `message` is included because our messages are written
   * to be safe by convention; `cause` and `stack` are deliberately excluded because they
   * routinely carry connection strings and driver internals.
   */
  toSummary(): { name: string; code: FulfillmentErrorCode; message: string; retryable: boolean; details?: ErrorDetails } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** Input did not satisfy a boundary contract. Retrying the identical bytes cannot help. */
export class ValidationFailedError extends FulfillmentError {
  readonly code = "VALIDATION_FAILED" as const;
  readonly retryable = false;
}

/** A referenced entity does not exist. Retrying cannot create it. */
export class NotFoundError extends FulfillmentError {
  readonly code = "NOT_FOUND" as const;
  readonly retryable = false;
}

/**
 * The request is well-formed but conflicts with current state, for example a duplicate
 * unique key or an edit against a stale version. Not retryable: the caller must change
 * the request or reconcile.
 */
export class ConflictError extends FulfillmentError {
  readonly code = "CONFLICT" as const;
  readonly retryable = false;
}

/** An operation was requested that the entity's lifecycle does not allow. */
export class InvalidStateTransitionError extends FulfillmentError {
  readonly code = "INVALID_STATE_TRANSITION" as const;
  readonly retryable = false;
}

/**
 * An upstream system answered, and the answer was a refusal (4xx-class, or a business
 * rejection such as an out-of-stock code). Deliberately **not** retryable: the same
 * request will be refused again.
 */
export class UpstreamRejectedError extends FulfillmentError {
  readonly code = "UPSTREAM_REJECTED" as const;
  readonly retryable = false;
}

/**
 * An upstream system was unreachable, timed out, or returned a 5xx / garbage. Retryable
 * in principle. Note the honest caveat: a genuine outage can outlast any retry budget, so
 * this means "worth another attempt", not "will succeed".
 */
export class UpstreamUnavailableError extends FulfillmentError {
  readonly code = "UPSTREAM_UNAVAILABLE" as const;
  readonly retryable = true;
}

/**
 * The database was unreachable or rejected our statement. Retryable, but call this out
 * specifically: if the error was a constraint violation rather than a connection failure
 * then the same write will fail identically, so the *cause* is what decides.
 */
export class PersistenceError extends FulfillmentError {
  readonly code = "PERSISTENCE_FAILED" as const;
  readonly retryable = true;
}

/**
 * `instanceof` is unreliable across package boundaries in a monorepo: a package can end up
 * with two copies of `@repo/domain` in the graph (a version skew, a duplicated transitive
 * dep, or a bundler resolving the compiled build for one import and source for another).
 * When that happens `instanceof` silently returns false and a real domain error degrades
 * into a bare 500. Duck-typing on the `code` field survives that, so boundary code should
 * prefer this guard.
 */
export function isFulfillmentError(value: unknown): value is FulfillmentError {
  return (
    value instanceof FulfillmentError ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as { code?: unknown }).code === "string" &&
      typeof (value as { retryable?: unknown }).retryable === "boolean")
  );
}
