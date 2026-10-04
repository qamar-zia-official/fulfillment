import { InvalidStateTransitionError } from "./errors";

/**
 * The order lifecycle.
 *
 * `pending` and `cancelled` are the only two values Phase 2 ever writes, because ingestion
 * only creates and cancels. The rest of the lifecycle is defined here, ahead of the code that
 * drives it, so the vocabulary is settled before a warehouse worker, a 3PL adapter, and a
 * dashboard all invent their own.
 *
 * Order of the array is the order of the normal happy path, which is what makes a
 * `SELECT ... ORDER BY` of distinct statuses readable.
 */
export const ORDER_STATUSES = [
  "pending",
  "allocated",
  "picking",
  "picked",
  "packed",
  "shipped",
  "delivered",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Legal transitions, as a relation rather than a set of conditionals.
 *
 * Being a data structure is the point. A chain of `if (status === ...)` branches scatters the
 * rules across the file and drifts the moment someone adds a state; a table can be read in
 * one pass, diffed in review, and asserted against the database constraint in a test.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ["allocated", "cancelled"],
  // The one backwards edge in the machine: deallocating so a different warehouse can be
  // tried. Modelling it explicitly is honest -- re-routing is a real operation, and pretending
  // it does not exist is how you end up with stock reserved at a warehouse that will never
  // pick it.
  allocated: ["picking", "pending", "cancelled"],
  picking: ["picked", "cancelled"],
  picked: ["packed", "cancelled"],
  packed: ["shipped", "cancelled"],
  // Shipped is past the point of no return. Cancelling a parcel already handed to a carrier
  // requires a return, which is a different process with a different status.
  shipped: ["delivered"],
  delivered: [],
  // Terminal. Nothing follows. A cancellation that gets "undone" is a new order.
  cancelled: [],
};

/**
 * Statuses from which no transition is possible.
 *
 * `cancelled` is here for a reason that is easy to get wrong: it is not merely "not in
 * progress", it is *absorbed*. Phase 2 encodes the same rule in the database with
 * `orders_cancelled_requires_timestamp_check`, and a stale `orders/updated` webhook must
 * never move an order back out of it.
 */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  "delivered",
  "cancelled",
];

export const isTerminalStatus = (status: OrderStatus): boolean => TERMINAL_ORDER_STATUSES.includes(status);

/**
 * Whether the order can still be cancelled.
 *
 * Not the same question as "is this terminal": an order in `picking` is not terminal but
 * also cannot be cancelled without recalling it, which is a warehouse decision rather than a
 * software one. Keeping both questions separate stops `!isTerminal` from being used as a
 * proxy for "cancel is allowed".
 */
export const CANCELLABLE_STATUSES: readonly OrderStatus[] = [
  "pending",
  "allocated",
  "picking",
  "picked",
  "packed",
];

export const isCancellable = (status: OrderStatus): boolean => CANCELLABLE_STATUSES.includes(status);

export const nextStatuses = (status: OrderStatus): readonly OrderStatus[] => ALLOWED_TRANSITIONS[status];

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to);

/**
 * Throws unless the transition is legal.
 *
 * Every call site goes through this rather than checking `canTransition` first, because the
 * two-call version has a race in it: between the check and the write, another worker can move
 * the order. Checking and acting in one step means the decision is made from one version of
 * the status, and the database is still the thing that decides who wins.
 *
 * The error is `INVALID_STATE_TRANSITION` and not `VALIDATION_FAILED` on purpose. The
 * difference is diagnostic: this is a conflict between two correct actors (a warehouse
 * scanner and a cancellation webhook), not a malformed request, and treating it as
 * validation sends the investigation looking in the wrong place.
 */
export const assertTransition = (from: OrderStatus, to: OrderStatus): void => {
  if (canTransition(from, to)) return;

  const allowed = nextStatuses(from);
  const message = allowed.length === 0
    ? `Order is ${from} and accepts no further transitions.`
    : `Cannot move an order from ${from} to ${to}. Allowed: ${allowed.join(", ")}.`;

  throw new InvalidStateTransitionError(message, { details: { from, to, allowed } });
};

/** Narrows a value read from the database or a webhook. */
export const isOrderStatus = (value: unknown): value is OrderStatus =>
  typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);

/**
 * Throws unless the value is a known status.
 *
 * `orders.status` is deliberately not a database enum: adding a state to an enum column
 * requires a migration and a deploy in lockstep, and a CHECK constraint has the same problem.
 * So the column is free text and *this* is the gate. The tradeoff is that the constraint can
 * drift from this list, which is why {@link ORDER_STATUSES} is the thing a test asserts
 * against the database when a CHECK constraint is eventually added.
 */
export const assertOrderStatus = (value: unknown): OrderStatus => {
  if (!isOrderStatus(value)) {
    throw new InvalidStateTransitionError(`Unknown order status: ${String(value)}.`, {
      details: { received: value, known: ORDER_STATUSES },
    });
  }
  return value;
};
