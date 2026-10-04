import type { AddressBlocker, ShippabilityVerdict } from "./address";
import { ValidationFailedError } from "./errors";
import { type ExceptionId, type OrderId, toExceptionId, toOrderId } from "./identifiers";

/**
 * The kinds of thing that stop an order progressing.
 *
 * An exception is not an error. An error means the software did something wrong and a retry
 * might fix it; an exception means the software worked correctly and the *order* cannot
 * proceed without human input. Conflating them is how a merchant's real order ends up in a
 * dead-letter queue beside genuine incidents.
 */
export const FULFILLMENT_EXCEPTION_TYPES = [
  "unroutable_incomplete_address",
  "unroutable_no_warehouse",
  "unroutable_insufficient_stock",
  "inventory_shortfall",
  "address_rejected_by_carrier",
  "carrier_error",
  "supplier_out_of_stock",
  "payment_failed",
] as const;

export type FulfillmentExceptionType = (typeof FULFILLMENT_EXCEPTION_TYPES)[number];

/**
 * `blocking` stops the order advancing and needs a person. `warning` is recorded and the
 * order continues.
 *
 * Assigned per type in a table rather than passed by the caller, because severity is a
 * property of the situation, not of who noticed it. Two operators handling the same
 * unroutable order must reach the same conclusion, and a boolean argument invites the
 * opposite.
 */
const DEFAULT_SEVERITY: Readonly<Record<FulfillmentExceptionType, "blocking" | "warning">> = {
  unroutable_incomplete_address: "blocking",
  unroutable_no_warehouse: "blocking",
  unroutable_insufficient_stock: "blocking",
  inventory_shortfall: "blocking",
  address_rejected_by_carrier: "blocking",
  carrier_error: "warning",
  supplier_out_of_stock: "warning",
  payment_failed: "blocking",
};

/**
 * The severity and status vocabularies, as runtime lists.
 *
 * The types below are derivable from these, and the *values* are needed in three places that a
 * type cannot help with: the schema's CHECK constraints, a row mapper that re-validates what
 * the database hands back, and the API parsing these out of a query string. Hardcoding
 * `'open','resolved','ignored'` at each of those sites is how a vocabulary grows a member that
 * one of them rejects.
 *
 * They live here because this module owns the rules, not the table that stores them.
 */
export const FULFILLMENT_EXCEPTION_SEVERITIES = ["blocking", "warning"] as const;
export const FULFILLMENT_EXCEPTION_STATUSES = ["open", "resolved", "ignored"] as const;

export type ExceptionSeverity = (typeof DEFAULT_SEVERITY)[FulfillmentExceptionType];
export type ExceptionStatus = (typeof FULFILLMENT_EXCEPTION_STATUSES)[number];

/** Serialisable context for triage. Never contains PII beyond what an operator already sees. */
export type ExceptionDetails = Record<string, unknown>;

export interface FulfillmentException {
  readonly id: ExceptionId;
  readonly orderId: OrderId;
  readonly type: FulfillmentExceptionType;
  readonly severity: ExceptionSeverity;
  readonly status: ExceptionStatus;
  readonly reason: string;
  readonly details: ExceptionDetails;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolutionNote: string | null;
}

export interface NewFulfillmentException {
  orderId: OrderId;
  type: FulfillmentExceptionType;
  reason: string;
  details?: ExceptionDetails;
  createdAt: Date;
  /** Escalates a warning to blocking when the caller has evidence the order cannot proceed. */
  severity?: ExceptionSeverity;
}

export const createFulfillmentException = (input: NewFulfillmentException): FulfillmentException => {
  if (!FULFILLMENT_EXCEPTION_TYPES.includes(input.type)) {
    throw new ValidationFailedError(`Unknown exception type: ${String(input.type)}.`, {
      details: { known: FULFILLMENT_EXCEPTION_TYPES },
    });
  }
  if (input.reason.trim().length === 0) {
    // An exception with no reason is an exception an operator cannot act on, so it is worse
    // than not raising one: it looks like work has been triaged.
    throw new ValidationFailedError("An exception must carry a reason.");
  }
  if (Number.isNaN(input.createdAt.getTime())) {
    throw new ValidationFailedError("createdAt must be a valid date.");
  }

  return {
    id: toExceptionId(`exc_${input.createdAt.getTime()}_${input.type}`),
    orderId: toOrderId(input.orderId),
    type: input.type,
    severity: input.severity ?? DEFAULT_SEVERITY[input.type],
    status: "open",
    reason: input.reason.trim(),
    details: input.details ?? {},
    createdAt: input.createdAt,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
  };
};

/**
 * Whether this exception currently holds the order up.
 *
 * `status` matters as much as `severity`: a resolved blocking exception must stop blocking,
 * or the order is wedged behind something nobody is going to work on. Both halves of the
 * check live here so no call site has to remember the other one.
 */
export const blocksFulfillment = (exception: FulfillmentException): boolean =>
  exception.severity === "blocking" && exception.status === "open";

/**
 * Closes an exception with an audit trail.
 *
 * `actor` and `note` are both mandatory. An exception that can vanish without recording who
 * closed it and why is indistinguishable from one that was never raised, which is exactly the
 * question you need answered when an order ships after a stock-out.
 *
 * `ignored` exists alongside `resolved` so a deliberate decision to ship anyway is recorded
 * as a decision rather than looking like an error that was closed.
 */
export const closeException = (
  exception: FulfillmentException,
  close: { status: Exclude<ExceptionStatus, "open">; actor: string; note: string; at: Date },
): FulfillmentException => {
  if (close.actor.trim().length === 0) {
    throw new ValidationFailedError("Closing an exception must record who closed it.");
  }
  if (close.note.trim().length === 0) {
    throw new ValidationFailedError("Closing an exception must record why.");
  }
  if (exception.status !== "open") {
    throw new ValidationFailedError(`Exception is already ${exception.status}.`, {
      details: { id: exception.id, status: exception.status },
    });
  }

  return {
    ...exception,
    status: close.status,
    resolvedAt: close.at,
    resolvedBy: close.actor.trim(),
    resolutionNote: close.note.trim(),
  };
};

/**
 * Turns an address verdict into an exception, or returns null when the address is fine.
 *
 * This is the function Phase 2's comments promised would exist later. Returning `null`
 * rather than a verdict-shaped no-op keeps the caller linear: it raises what is wrong and
 * carries on, with no branch to remember to unwrap.
 */
export const exceptionForShippability = (
  orderId: OrderId,
  verdict: ShippabilityVerdict,
  at: Date,
): FulfillmentException | null => {
  if (verdict.shippable) return null;

  return createFulfillmentException({
    orderId,
    type: "unroutable_incomplete_address",
    reason: `Shipping address is incomplete: ${verdict.blockers.join(", ")}.`,
    details: { blockers: [...verdict.blockers] },
    createdAt: at,
  });
};

/**
 * Turns a stock shortfall into an exception.
 *
 * A shortfall of zero is not a shortfall. Returning null for an empty map means the caller
 * does not have to distinguish "no exception" from "an exception with nothing in it", which
 * would be a real record in the exceptions table and a permanently un-actionable queue entry.
 */
export const exceptionForShortfall = (
  orderId: OrderId,
  shortfall: ReadonlyMap<string, number>,
  at: Date,
): FulfillmentException | null => {
  if (shortfall.size === 0) return null;

  const detail = Object.fromEntries(shortfall);
  return createFulfillmentException({
    orderId,
    type: "unroutable_insufficient_stock",
    reason: `No single location can cover: ${[...shortfall].map(([sku, missing]) => `${sku} short by ${missing}`).join("; ")}.`,
    details: { shortfall: detail },
    createdAt: at,
  });
};

export const addressBlockersOf = (exception: FulfillmentException): AddressBlocker[] => {
  const blockers = exception.details["blockers"];
  return Array.isArray(blockers) ? (blockers as AddressBlocker[]) : [];
};
