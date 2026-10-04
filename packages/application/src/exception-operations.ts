import {
  ValidationFailedError,
  toOrderId,
  type ExceptionDetails,
  type ExceptionSeverity,
  type ExceptionStatus,
  type FulfillmentException,
  type FulfillmentExceptionType,
} from "@repo/domain";

/**
 * The operations read-side: the queue an operator works through, and closing an entry on it.
 *
 * The write side already exists -- Phase 4's routing transaction raises exceptions, and it does
 * so correctly, in the same transaction as the decision it describes. What was missing was the
 * other end. An exception table with a lifecycle and no way to read it is a table that fills up
 * and means nothing, and the failure mode is the quiet one: nobody is paged, orders quietly stop
 * shipping, and the first sign of it is a merchant complaining.
 *
 * Everything here is shop-scoped, and that is a security property rather than a filtering
 * convenience. `shop_domain` is the tenant key, and the exception ids are
 * `exc_<timestamp>_<type>` -- a timestamp and one of eight constants. They are guessable. An
 * endpoint that took an id and looked it up without also taking the shop would be a
 * cross-merchant read of customer names, addresses, and order contents, reachable by
 * incrementing a number. So the shop is a required field on every method here, including the
 * ones that look up by primary key.
 */

/**
 * One page of the queue.
 *
 * Keyset, not offset. The queue is append-heavy and worked by a person paging through it, and
 * offset pagination is wrong for exactly that: a new exception arriving between page one and
 * page two shifts every row down by one, so the operator re-sees a row they just handled and
 * skips one they have not. The symptom is "I dealt with that one" and "that one's still
 * sitting there" for the same exception, which erodes trust in the whole screen.
 *
 * The cursor is `(createdAt, id)` rather than `createdAt` alone because two exceptions can share
 * a timestamp -- they are written in the same transaction, and `now()` is per-transaction -- and
 * a timestamp-only cursor drops or repeats the boundary row.
 */
export type ExceptionCursor = {
  readonly createdAt: Date;
  readonly id: string;
};

export type ExceptionQuery = {
  readonly shopDomain: string;
  /** Defaults to open only, because the closed ones are history and history is not a queue. */
  readonly status?: readonly ExceptionStatus[];
  readonly severity?: readonly ExceptionSeverity[];
  readonly type?: readonly FulfillmentExceptionType[];
  readonly after?: ExceptionCursor | null;
  /** Clamped to 1..100. Default 25, which is roughly one screen of triage. */
  readonly limit?: number;
};

export type ExceptionPage = {
  readonly exceptions: readonly FulfillmentException[];
  /** Null on the last page, and deliberately not a count. */
  readonly nextCursor: ExceptionCursor | null;
};

export interface ExceptionOperationsRepository {
  listExceptions(query: ExceptionQuery): Promise<ExceptionPage>;

  /**
   * Closes an exception, or reports that it was not open.
   *
   * The distinction between "closed it" and "could not close it" is the whole method, and it
   * has to be decided in SQL rather than by reading the row first. Two operators working the
   * same queue will reach for the same entry, and a read-then-write leaves a window where both
   * read `open`, both write, and the second note silently overwrites the first -- losing exactly
   * the audit trail the close was designed to preserve. So the update is conditional on
   * `status = 'open'` and a zero-row result means someone else got there first.
   */
  closeException(input: {
    shopDomain: string;
    exceptionId: string;
    status: Exclude<ExceptionStatus, "open">;
    actor: string;
    note: string;
    at: Date;
  }): Promise<{ outcome: "closed"; exception: FulfillmentException } | { outcome: "not_found" } | { outcome: "already_closed"; exception: FulfillmentException }>;
}

export const DEFAULT_EXCEPTION_PAGE_SIZE = 25;
export const MAX_EXCEPTION_PAGE_SIZE = 100;

/**
 * Applies the page-size policy.
 *
 * Shared by the use case and the repository rather than duplicated, because the two are
 * answering the same question from opposite directions -- "what did the caller ask for" and
 * "what can this query safely do" -- and the answer has to be the same number. The repository
 * clamps independently on purpose: it is callable without going through here, and a limit is a
 * lock-hold duration rather than a preference.
 */
export const clampExceptionPageSize = (requested: number | undefined): number => {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_EXCEPTION_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_EXCEPTION_PAGE_SIZE);
};

const isBlank = (value: string) => value.trim().length === 0;

/**
 * Reads the exception queue for one shop.
 *
 * Trivial by design. There is no policy here worth hiding behind a use case, and pretending
 * otherwise would add a layer whose only job is forwarding arguments -- so this exists to
 * enforce the two invariants a repository should not have to guess: the shop is named, and the
 * page size is bounded.
 */
export const listExceptions = async (
  repository: ExceptionOperationsRepository,
  query: ExceptionQuery,
): Promise<ExceptionPage> => {
  if (isBlank(query.shopDomain)) {
    // Not a validation nicety. An unscoped list is a cross-merchant read, and the only thing
    // standing between a missing filter and a data breach is this throw.
    throw new ValidationFailedError("A shop domain is required to read the exception queue.");
  }
  if (query.after && Number.isNaN(query.after.createdAt.getTime())) {
    throw new ValidationFailedError("The page cursor carries an unreadable timestamp.");
  }

  return repository.listExceptions({ ...query, limit: clampExceptionPageSize(query.limit) });
};

export type CloseExceptionInput = {
  readonly shopDomain: string;
  readonly exceptionId: string;
  readonly status: Exclude<ExceptionStatus, "open">;
  /**
   * Who is closing it.
   *
   * Deliberately separate from `note` and required, because the domain already requires both
   * and because the actor must come from the authenticated session rather than the request
   * body. An actor taken from the body is an attribution an operator can forge, which makes
   * `resolved_by` decorative -- and the entire point of recording it is the question "who
   * decided to ship this order without stock?".
   */
  readonly actor: string;
  readonly note: string;
  readonly at: Date;
};

export type CloseExceptionResult =
  | { outcome: "closed"; exception: FulfillmentException }
  | { outcome: "not_found" }
  | { outcome: "already_closed"; exception: FulfillmentException };

/**
 * Closes an exception with a full audit trail.
 *
 * No pre-read, and that is the load-bearing decision. The obvious shape is "look it up, check it
 * is open, then write" -- and it is a race, because two operators working the same queue will
 * reach for the same entry. Both read `open`, both write, and the second note silently
 * overwrites the first: the audit trail the close exists to preserve, destroyed by the close.
 *
 * So the read and the write are one operation. The repository's UPDATE is conditional on
 * `status = 'open'` and a zero-row result is the answer, which is also the only way to tell
 * "no such exception" from "someone got there first" without a second round trip that could
 * race in turn.
 *
 * The rules the domain's `closeException` states -- open only, a named actor, a stated reason --
 * are still enforced here and in the database: the non-blank checks below cover the parts a
 * CHECK cannot (an empty string is not null), and `exceptions_resolution_audit_check` covers the
 * rest. The domain function itself is not called on this path, and that is deliberate: it
 * operates on an in-memory aggregate, so using it would mean reading the row first, which is
 * the race. It remains the written statement of what a close means.
 */
export const closeException = async (
  repository: ExceptionOperationsRepository,
  input: CloseExceptionInput,
): Promise<CloseExceptionResult> => {
  if (isBlank(input.shopDomain)) {
    throw new ValidationFailedError("A shop domain is required to close an exception.");
  }
  if (isBlank(input.actor)) {
    throw new ValidationFailedError("Closing an exception must record who closed it.");
  }
  if (isBlank(input.note)) {
    throw new ValidationFailedError("Closing an exception must record why.");
  }
  if (Number.isNaN(input.at.getTime())) {
    throw new ValidationFailedError("Closing an exception requires a valid timestamp.");
  }

  return repository.closeException({
    shopDomain: input.shopDomain,
    exceptionId: input.exceptionId,
    status: input.status,
    actor: input.actor,
    note: input.note,
    at: input.at,
  });
};

/** Re-exported so callers can build `details` without importing the domain directly. */
export type { ExceptionDetails, ExceptionSeverity, ExceptionStatus, FulfillmentException, FulfillmentExceptionType };
export { toOrderId };
