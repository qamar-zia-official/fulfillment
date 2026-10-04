/**
 * The domain model: business rules that are true regardless of transport, storage, or vendor.
 *
 * This package has zero dependencies on purpose -- no web framework, no ORM, no validation
 * library. That is not purity for its own sake. It is the reason the routing engine, a
 * Trigger.dev job, and an HTTP handler can all ask the same questions of the same objects and
 * get the same answers, and the reason these tests run in tens of milliseconds instead of
 * needing a database.
 *
 * Two conventions run through every module here:
 *
 *  - **Invariants live in one place.** An order that is cancelled has a timestamp because
 *    `Order.cancel` says so, not because three call sites remembered. Where an invariant
 *    genuinely cannot be enforced in one place (see {@link StockLevel}), it is derived rather
 *    than stored, so the impossible state cannot be represented.
 *
 *  - **Judgements return, errors throw.** Malformed input is a `ValidationFailedError`.
 *    Business outcomes that need a human -- an unroutable address, insufficient stock -- come
 *    back as data, because the correct response is to park the order and raise an exception,
 *    not to fail the job and lose it.
 */
export * from "./errors";
export * from "./identifiers";
export * from "./money";
export * from "./order-status";
export * from "./address";
export * from "./stock";
export * from "./exceptions";
export * from "./order";
export * from "./routing";
