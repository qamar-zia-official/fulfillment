import {
  ValidationFailedError,
  toExceptionId,
  toOrderId,
  type ExceptionDetails,
  type ExceptionSeverity,
  type ExceptionStatus,
  type FulfillmentException,
  type FulfillmentExceptionType,
} from "@repo/domain";
import {
  FULFILLMENT_EXCEPTION_SEVERITIES,
  FULFILLMENT_EXCEPTION_STATUSES,
  FULFILLMENT_EXCEPTION_TYPES,
  type exceptions,
} from "./schema";

/**
 * Row-to-domain mapping, in one place.
 *
 * The `text` columns carry `$type<...>`, which means the compiler believes every value is
 * already a valid exception type and never checks it. The CHECK constraints are what actually
 * guarantee that, and they are only as good as the writer.
 *
 * So this function re-validates rather than trusting the assertion, and that is the point of
 * it. Every other mapping in this package hands a column to a constructor; this one runs
 * against a row that nothing in this process necessarily wrote, and a `type` outside the
 * vocabulary would silently fall through every `switch` in the codebase. A
 * `ValidationFailedError` naming the row is loud, attributable, and points at the writer that
 * got it wrong.
 *
 * The vocabularies come from the schema module, which is where the CHECK constraints are built
 * from, so re-validation here cannot disagree with the constraint it defends.
 *
 * It lives here rather than inside a repository because two repositories need it, and a copy in
 * each is how the second one drifts.
 */
export type ExceptionRow = typeof exceptions.$inferSelect;

const requireOneOf = <T extends string>(value: string, allowed: readonly string[], column: string, id: string): T => {
  if (!allowed.includes(value)) {
    throw new ValidationFailedError(`Exception ${id} has a ${column} outside the known vocabulary.`, {
      details: { id, column, value },
    });
  }
  return value as T;
};

export const toFulfillmentException = (row: ExceptionRow): FulfillmentException => {
  if (Number.isNaN(row.createdAt.getTime())) {
    throw new ValidationFailedError(`Exception ${row.id} has an unreadable created_at.`, { details: { id: row.id } });
  }

  return {
    id: toExceptionId(row.id),
    orderId: toOrderId(row.orderId),
    type: requireOneOf<FulfillmentExceptionType>(row.type, FULFILLMENT_EXCEPTION_TYPES, "type", row.id),
    severity: requireOneOf<ExceptionSeverity>(row.severity, FULFILLMENT_EXCEPTION_SEVERITIES, "severity", row.id),
    status: requireOneOf<ExceptionStatus>(row.status, FULFILLMENT_EXCEPTION_STATUSES, "status", row.id),
    reason: row.reason,
    // `row.details` is `jsonb` typed as `unknown`, so the cast is doing real work: the domain
    // wants an object, and jsonb can legitimately hold a scalar or an array. A row holding one
    // of those means a writer stored the wrong shape, and the honest response is a type error
    // in a `details` consumer rather than an object pretending to be structured data.
    details: (row.details ?? {}) as ExceptionDetails,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    resolutionNote: row.resolutionNote,
  };
};
