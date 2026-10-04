import { relations } from "drizzle-orm";
import { accounts, sessions, users } from "./auth";
import { auditEvents, orderItems, orders, webhookEvents } from "./orders";
import { exceptions, inventory, inventoryReservations, warehouseRoutes, warehouses } from "./warehouses";

/**
 * Drizzle relational definitions.
 *
 * These are NOT the same thing as the foreign keys declared on the tables, and confusing
 * the two is the single most common Drizzle mistake:
 *
 *   - `.references()` on a column emits a real FOREIGN KEY constraint. Postgres enforces
 *     it. It knows nothing about TypeScript.
 *   - `relations()` is a TypeScript-level declaration that powers the relational query
 *     builder (`db.query.user.findFirst({ with: { sessions: true } })`).
 *
 * The relational query builder needs BOTH. Given a table with a foreign key but no
 * matching `relations()` entry, it resolves the relation to `undefined` and throws
 * `TypeError: undefined is not an object (evaluating 'relation.referencedTable')` at query
 * time -- not at startup, which makes it look like a data problem when it is a schema
 * definition problem.
 *
 * That is exactly what broke sign-in: Better Auth's Drizzle adapter uses relational
 * queries when `advanced.database.joins` is enabled, so account creation (a plain insert)
 * worked while session lookup (a relational query) returned HTTP 500.
 *
 * The one-to-many side must be declared on the parent, and the many-to-one side on the
 * child, so that `with` clauses can be resolved from either direction.
 */
export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

/**
 * Order -> line items. Needed for the operations dashboard's order detail view, which
 * loads an order together with its items in a single round trip.
 */
export const ordersRelations = relations(orders, ({ many }) => ({
  items: many(orderItems),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
}));

/**
 * Routing and inventory relations.
 *
 * Declared in both directions on purpose. The routing transaction needs order -> reservations
 * to check whether a warehouse is already holding stock for this order (the idempotency
 * guard), and the operations dashboard needs warehouse -> orders to answer "what is this site
 * working on?". Either query without its `relations()` entry throws at query time, not at
 * startup, which is indistinguishable from a data problem.
 */
export const ordersRoutingRelations = relations(orders, ({ many }) => ({
  reservations: many(inventoryReservations),
  exceptions: many(exceptions),
  auditEvents: many(auditEvents),
}));

export const warehousesRelations = relations(warehouses, ({ many }) => ({
  routes: many(warehouseRoutes),
  inventory: many(inventory),
  reservations: many(inventoryReservations),
}));

export const warehouseRoutesRelations = relations(warehouseRoutes, ({ one }) => ({
  warehouse: one(warehouses, {
    fields: [warehouseRoutes.warehouseId],
    references: [warehouses.id],
  }),
}));

export const inventoryRelations = relations(inventory, ({ one }) => ({
  warehouse: one(warehouses, {
    fields: [inventory.warehouseId],
    references: [warehouses.id],
  }),
}));

export const inventoryReservationsRelations = relations(inventoryReservations, ({ one }) => ({
  order: one(orders, {
    fields: [inventoryReservations.orderId],
    references: [orders.id],
  }),
  warehouse: one(warehouses, {
    fields: [inventoryReservations.warehouseId],
    references: [warehouses.id],
  }),
}));

export const exceptionsRelations = relations(exceptions, ({ one }) => ({
  order: one(orders, {
    fields: [exceptions.orderId],
    references: [orders.id],
  }),
}));

// `verifications` has no foreign keys: Better Auth keys it purely by `identifier`, so it
// has no parent to declare a relation to.
