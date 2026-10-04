import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import {
  FULFILLMENT_EXCEPTION_SEVERITIES,
  FULFILLMENT_EXCEPTION_STATUSES,
  FULFILLMENT_EXCEPTION_TYPES,
  type ExceptionStatus,
  type FulfillmentExceptionType,
} from "@repo/domain";
import { orders } from "./orders";

/**
 * Renders a compile-time list of identifiers as a quoted SQL literal list.
 *
 * Only ever called with the `as const` arrays declared in this file. There is no code path
 * from a request, a Shopify payload, or any other runtime input to this function, which is
 * the only reason inlining is acceptable here. If a caller ever passes user data, the CHECK
 * constraint becomes an injection sink -- a constraint expression cannot take bind
 * parameters at all, so there is no safer alternative.
 */
const quotedList = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(", ");

/**
 * A physical location that holds stock and picks orders.
 *
 * `countryCode` is where the site *is*, which is not the same question as which countries it
 * *ships to* -- that lives in `warehouse_routes`, because a site in Kentucky serving Canada
 * is an ordinary configuration and a single country column cannot express it.
 */
export const warehouses = pgTable("warehouses", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  countryCode: text("country_code").notNull(),
  /**
   * An inactive site is kept, never deleted. Its inventory and its whole reservation history
   * still hang off it, and an audit trail that loses rows when a warehouse closes is not an
   * audit trail. `is_active` also keeps it out of routing, so deactivating a site is the
   * single action that stops new orders without touching anything historical.
   */
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("warehouses_country_code_format_check", sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
]);

/**
 * Which countries a warehouse is responsible for, and in what order.
 *
 * A join table rather than a `text[]` column or a single per-warehouse priority, because
 * priority is genuinely *per country*: a regional hub is nearest to its own country and
 * furthest from the next one over. A single number per site forces one of the two routings
 * to be wrong, and the wrong one is invisible until a parcel crosses an ocean unnecessarily.
 *
 * "Priority" is a list position chosen by operations, not a computed distance. Encoding real
 * geography as a number would be a guess dressed up as physics.
 */
export const warehouseRoutes = pgTable(
  "warehouse_routes",
  {
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    countryCode: text("country_code").notNull(),
    priority: integer("priority").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.warehouseId, table.countryCode] }),
    /**
     * The routing engine's hot path: "the sites responsible for this country, best first".
     * Leading with country_code makes this the covering index for the whole query -- the
     * filter *is* the prefix, so Postgres reads the entries in priority order and stops.
     */
    index("warehouse_routes_country_priority_idx").on(table.countryCode, table.priority, table.warehouseId),
    check("warehouse_routes_priority_positive_check", sql`${table.priority} >= 0`),
    check("warehouse_routes_country_code_format_check", sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
  ],
);

/**
 * Stock of one SKU at one warehouse.
 *
 * `onHand` and `reserved` are stored; `available` is **not a column**. Three stored counters
 * can disagree, and they will when two concurrent reservations touch the same row and one is
 * interrupted. The damage is an oversell discovered by the customer. The invariant is enforced
 * by the CHECK below and `available` is computed as `onHand - reserved` on read, so the
 * inconsistent state cannot be stored in the first place.
 */
export const inventory = pgTable(
  "inventory",
  {
    id: text("id").primaryKey(),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    sku: text("sku").notNull(),
    onHand: integer("on_hand").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_warehouse_sku_unique").on(table.warehouseId, table.sku),
    // "Which sites hold this SKU?" is the question every routing decision asks.
    index("inventory_sku_idx").on(table.sku),
    /**
     * The same invariant `StockLevel` enforces in the domain, restated where it cannot be
     * bypassed. Any writer that is not the routing use case -- a manual stock correction, a
     * future import script -- is caught here rather than at the point of overselling.
     */
    check("inventory_reserved_within_on_hand_check", sql`${table.reserved} <= ${table.onHand}`),
    check("inventory_quantities_non_negative_check", sql`${table.onHand} >= 0 and ${table.reserved} >= 0`),
  ],
);

export const RESERVATION_STATUSES = ["active", "released", "committed"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * A promise that specific stock is set aside for a specific order.
 *
 * A row, not a number on the order, because stock has to be *returned* when an order is
 * cancelled or deallocated, and a counter cannot remember how much to give back. It is also
 * the record that answers "why is this order holding stock?" months later.
 *
 * `committed` is distinct from `released`: releasing returns stock to availability, committing
 * consumes it because the parcel physically left. Collapsing them into one "done" would make
 * a real stock count impossible to reconcile.
 */
export const inventoryReservations = pgTable(
  "inventory_reservations",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    sku: text("sku").notNull(),
    quantity: integer("quantity").notNull(),
    status: text("status").$type<ReservationStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    /**
     * At most one *active* reservation per (order, sku).
     *
     * Partial, and this is the idempotency guard for re-routing. Re-running the routing use
     * case for an order that is already allocated would otherwise reserve the same units
     * again and quietly drain the warehouse. The uniqueness applies only to `active` rows, so
     * the released history of a previous attempt is preserved -- which is what makes "why was
     * this routed twice?" answerable.
     */
    uniqueIndex("inventory_reservations_order_sku_active_unique")
      .on(table.orderId, table.sku)
      .where(sql`${table.status} = 'active'`),
    // "Give me everything this order is holding", and "what is this site holding for open orders".
    index("inventory_reservations_order_status_idx").on(table.orderId, table.status),
    index("inventory_reservations_warehouse_status_idx").on(table.warehouseId, table.status),
    check("inventory_reservations_quantity_positive_check", sql`${table.quantity} > 0`),
    check(
      "inventory_reservations_status_check",
      sql`${table.status} in ('active','released','committed')`,
    ),
  ],
);

// Re-exported for the callers that already import them from here, so this refactor does not
// reach into other packages. They were a second, independent copy of the domain's lists, guarded
// only by a test that compares the generated DDL against the domain; sourcing them from
// `@repo/domain` removes the chance of the two drifting instead of detecting it after the fact.
// The schema's job is to turn these into constraints, and it can only keep doing that while
// reading the vocabulary from the module that defines it.
export { FULFILLMENT_EXCEPTION_SEVERITIES, FULFILLMENT_EXCEPTION_STATUSES, FULFILLMENT_EXCEPTION_TYPES, type FulfillmentExceptionType };

export type FulfillmentExceptionStatus = ExceptionStatus;
export type FulfillmentExceptionSeverity = (typeof FULFILLMENT_EXCEPTION_SEVERITIES)[number];

/**
 * Something that stopped an order progressing and needs a human.
 *
 * Separate from `webhook_events`, which records what happened to a *delivery*. An exception
 * is durable business state with a lifecycle and an owner; a failed webhook is usually
 * transient and often fixed by a redelivery. Merging them means either losing the exception
 * on retry or turning a transient blip into a queue entry nobody closes.
 */
export const exceptions = pgTable(
  "exceptions",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    type: text("type").$type<FulfillmentExceptionType>().notNull(),
    severity: text("severity").$type<FulfillmentExceptionSeverity>().notNull(),
    status: text("status").$type<FulfillmentExceptionStatus>().notNull().default("open"),
    /** Written for an operator. Never rendered raw to an end customer. */
    reason: text("reason").notNull(),
    /** Structured triage context: shortfall maps, blocker lists, offending field names. */
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
  },
  (table) => [
    // The operations queue: open exceptions, newest first.
    index("exceptions_status_created_idx").on(table.status, table.createdAt),
    index("exceptions_order_idx").on(table.orderId),
    /**
     * At most one *open* exception of a given type per order.
     *
     * This exists because of an interaction between two things that are each individually
     * correct. An unroutable order keeps `status = 'pending'` -- that is what lets it self-heal
     * when stock is restocked, since the routing worker only looks at pending orders. But the
     * worker runs every five minutes, so it re-evaluates the same unroutable order every five
     * minutes forever, and each evaluation used to insert a fresh exception. One out-of-stock
     * order produced 288 identical queue entries a day, which buries every other problem the
     * operator has.
     *
     * Partial on `status = 'open'` on purpose. Re-raising after an operator closes an exception
     * is legitimate and useful -- the problem came back -- and a blanket unique index on
     * `(order_id, type)` would make the second occurrence a constraint violation instead. This
     * way the history is "this happened, we dealt with it, it happened again", which is the
     * truth, instead of an error.
     *
     * Enforced here rather than by a "check for an existing one first" in application code,
     * because a pre-insert check is a race that happens to be won by the row lock the routing
     * transaction already holds -- correct today, and silently wrong the day a second writer
     * appears. A partial unique index cannot be bypassed by a caller that forgets.
     */
    uniqueIndex("exceptions_open_order_type_unique")
      .on(table.orderId, table.type)
      .where(sql`${table.status} = 'open'`),
    // `sql.raw`, not `sql.join`. `sql.join` emits *bind parameters*, so the generated DDL
    // comes out as `type in ('$1','$2',...)` -- a constraint comparing against the literal
    // string "$1", which rejects every row. Raw is correct and safe here because the values
    // come from a compile-time `const` array in this file, never from input; the alternative
    // is a constraint that looks right in the schema and breaks every insert in production.
    check(
      "exceptions_type_check",
      sql`${table.type} in (${sql.raw(quotedList(FULFILLMENT_EXCEPTION_TYPES))})`,
    ),
    check("exceptions_status_check", sql`${table.status} in ('open','resolved','ignored')`),
    check("exceptions_severity_check", sql`${table.severity} in (${sql.raw(quotedList(FULFILLMENT_EXCEPTION_SEVERITIES))})`),
    /**
     * A closed exception must say who closed it and why. Without this, a closed exception is
     * indistinguishable from one that was never raised -- which is exactly the question you
     * need answered when an order ships after a stock-out. Enforced here because the domain
     * requires both fields, and a hand-written UPDATE from a psql session would otherwise
     * bypass it.
     */
    check(
      "exceptions_resolution_audit_check",
      sql`${table.status} = 'open' or (${table.resolvedAt} is not null and ${table.resolvedBy} is not null and ${table.resolutionNote} is not null)`,
    ),
  ],
);
