import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { toExceptionId, toShopDomain } from "@repo/domain";
import {
  clampExceptionPageSize,
  type CloseExceptionResult,
  type ExceptionOperationsRepository,
  type ExceptionPage,
  type ExceptionQuery,
} from "@repo/application";
import type { Database } from "../client";
import { toFulfillmentException } from "../rows";
import { exceptions, orders } from "../schema";

/**
 * The operations read-side, against Postgres.
 *
 * Every statement here joins to `orders` to scope by `shop_domain`, including the one that
 * takes a primary key. That is not defensive style, it is the only correct shape: exception ids
 * embed a timestamp and a type constant, so they are guessable, and an unscoped lookup by id is
 * a cross-merchant read of customer data.
 */
export function createExceptionOperationsRepository(db: Database): ExceptionOperationsRepository {
  /**
   * The shop-scoped predicate every method starts from.
   *
   * `toShopDomain` is not decoration here. It is the same normalisation the webhook path applies
   * when writing `shop_domain`, so a lookup built from an un-normalised domain would silently
   * match nothing -- an empty queue for a merchant who has plenty of exceptions, which reads as
   * "nothing is wrong" rather than as a bug.
   */
  const scoped = (shopDomain: string) => eq(orders.shopDomain, toShopDomain(shopDomain));

  return {
    async listExceptions(query: ExceptionQuery): Promise<ExceptionPage> {
      const limit = clampExceptionPageSize(query.limit);
      const shop = toShopDomain(query.shopDomain);

      // One row over the limit, which is how "is there a next page" is answered without a
      // second COUNT. An exact total is worse than useless here: it changes under the operator
      // as they work, so it can never be right for the whole session.
      const filters = [eq(orders.shopDomain, shop)];

      if (query.status?.length) filters.push(inArray(exceptions.status, [...query.status]));
      if (query.severity?.length) filters.push(inArray(exceptions.severity, [...query.severity]));
      if (query.type?.length) filters.push(inArray(exceptions.type, [...query.type]));

      // Keyset, matching the DESC ordering below. A row comparison rather than two
      // `AND`s, because `(created_at, id) < (a, b)` is lexicographic and therefore correct on
      // the tie -- two exceptions written in one transaction share a `now()`, and splitting this
      // into `created_at < a OR (created_at = a AND id < b)` is the same query written wrong once.
      if (query.after) {
        const cursor = query.after;
        filters.push(or(lt(exceptions.createdAt, cursor.createdAt), and(eq(exceptions.createdAt, cursor.createdAt), lt(exceptions.id, cursor.id)))!);
      }

      const rows = await db
        .select({ row: exceptions })
        .from(exceptions)
        .innerJoin(orders, eq(orders.id, exceptions.orderId))
        .where(and(...filters))
        // `id` breaks the tie. Without it two rows sharing a `created_at` have no defined order,
        // so the same row can appear on two pages and the cursor is not reproducible.
        .orderBy(desc(exceptions.createdAt), desc(exceptions.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1)?.row;

      return {
        exceptions: page.map(({ row }) => toFulfillmentException(row)),
        nextCursor:
          hasMore && last
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      };
    },

    async closeException(input): Promise<CloseExceptionResult> {
      const shop = toShopDomain(input.shopDomain);
      const exceptionId = toExceptionId(input.exceptionId);

      // Conditional on `status = 'open'`, and scoped to the shop. One statement, so there is no
      // window between deciding the row is open and writing that it is not -- which is the whole
      // race a read-then-write has, and it is the race that loses an operator's note.
      const closed = await db
        .update(exceptions)
        .set({
          status: input.status,
          resolvedAt: input.at,
          resolvedBy: input.actor,
          resolutionNote: input.note,
        })
        .where(
          and(
            eq(exceptions.id, exceptionId),
            eq(exceptions.status, "open"),
            // Subquery rather than a join: the shop lives on `orders`, and joining into an
            // UPDATE would make the uniqueness of the target row depend on the plan.
            inArray(
              exceptions.orderId,
              db.select({ id: orders.id }).from(orders).where(eq(orders.shopDomain, shop)),
            ),
          ),
        )
        .returning();

      const [row] = closed;
      if (row) return { outcome: "closed", exception: toFulfillmentException(row) };

      // Zero rows means either no such exception or someone else closed it first. Distinguish
      // them with one shop-scoped read. Scoped on purpose: an exception that exists under a
      // different shop must come back as `not_found`, not as `already_closed`, or the endpoint
      // becomes a probe for which exception ids exist in other tenants.
      const [existing] = await db
        .select({ row: exceptions })
        .from(exceptions)
        .innerJoin(orders, eq(orders.id, exceptions.orderId))
        .where(and(eq(exceptions.id, exceptionId), eq(orders.shopDomain, shop)))
        .limit(1);

      if (!existing) return { outcome: "not_found" };

      return { outcome: "already_closed", exception: toFulfillmentException(existing.row) };
    },
  };
}
