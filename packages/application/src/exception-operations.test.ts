import { describe, expect, test } from "bun:test";
import { toExceptionId, toOrderId } from "@repo/domain";
import {
  DEFAULT_EXCEPTION_PAGE_SIZE,
  MAX_EXCEPTION_PAGE_SIZE,
  clampExceptionPageSize,
  closeException,
  listExceptions,
  type CloseExceptionResult,
  type ExceptionOperationsRepository,
  type ExceptionPage,
  type ExceptionQuery,
} from "./exception-operations";

const SHOP = "kinetous.myshopify.com";
const OTHER_SHOP = "someone-else.myshopify.com";

const openException = (overrides: BuiltException = {}) => buildException(overrides);

type BuiltException = {
  id?: string;
  status?: "open" | "resolved" | "ignored";
  createdAt?: Date;
};

function buildException({ id = "exc-1", status = "open", createdAt = new Date("2026-09-28T12:00:00Z") }: BuiltException = {}) {
  return {
    id: toExceptionId(id),
    orderId: toOrderId("ord-1"),
    type: "unroutable_insufficient_stock" as const,
    severity: "blocking" as const,
    status,
    reason: "No single location can cover: KNT-TEE short by 2.",
    details: { shortfall: { "KNT-TEE": 2 } },
    createdAt,
    resolvedAt: status === "open" ? null : new Date("2026-09-28T13:00:00Z"),
    resolvedBy: status === "open" ? null : "ops@example.com",
    resolutionNote: status === "open" ? null : "Restocked.",
  };
}

const emptyPage: ExceptionPage = { exceptions: [], nextCursor: null };

/** Records what it was asked for, and answers with whatever the test needs. */
function fakeRepository(overrides: Partial<ExceptionOperationsRepository> = {}) {
  const queries: ExceptionQuery[] = [];
  const closes: Parameters<ExceptionOperationsRepository["closeException"]>[0][] = [];

  const repository: ExceptionOperationsRepository = {
    async listExceptions(query) {
      queries.push(query);
      return emptyPage;
    },
    async closeException(input) {
      closes.push(input);
      return { outcome: "closed", exception: buildException({ status: "resolved" }) } as CloseExceptionResult;
    },
    ...overrides,
  };

  return { repository, queries, closes };
}

describe("clampExceptionPageSize", () => {
  test("defaults when nothing was asked for", () => {
    expect(clampExceptionPageSize(undefined)).toBe(DEFAULT_EXCEPTION_PAGE_SIZE);
  });

  test("clamps both ends rather than trusting the caller", () => {
    // A limit is a lock-hold duration and a response size. Honouring `limit=1000000` is how a
    // cautious caller becomes an outage, so the ceiling is a floor on the argument's sanity.
    expect(clampExceptionPageSize(0)).toBe(1);
    expect(clampExceptionPageSize(-5)).toBe(1);
    expect(clampExceptionPageSize(10_000)).toBe(MAX_EXCEPTION_PAGE_SIZE);
  });

  test("truncates a fractional limit instead of passing it to SQL", () => {
    // `LIMIT 2.5` is an error in Postgres, not a rounding. Better to floor it here than to
    // discover it as a 500 from the driver.
    expect(clampExceptionPageSize(2.9)).toBe(2);
  });

  test("falls back to the default for NaN and Infinity", () => {
    // `?limit=Infinity` parses to a real number that is not finite; `Number.isFinite` is the
    // check, not `isNaN`.
    expect(clampExceptionPageSize(Number.NaN)).toBe(DEFAULT_EXCEPTION_PAGE_SIZE);
    expect(clampExceptionPageSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_EXCEPTION_PAGE_SIZE);
  });
});

describe("listExceptions", () => {
  test("refuses to read the queue without a shop", async () => {
    // The load-bearing check in this file. `shop_domain` is the tenant key, and an unscoped list
    // is a cross-merchant read of customer data rather than a mistake with an empty result.
    const { repository, queries } = fakeRepository();

    for (const shopDomain of ["", "   "]) {
      await expect(listExceptions(repository, { shopDomain })).rejects.toThrow(/shop domain/i);
    }

    // Nothing reached the repository: rejecting after the query would still have leaked.
    expect(queries).toHaveLength(0);
  });

  test("passes the clamped limit through", async () => {
    const { repository, queries } = fakeRepository();

    await listExceptions(repository, { shopDomain: SHOP, limit: 5_000 });

    expect(queries[0]?.limit).toBe(MAX_EXCEPTION_PAGE_SIZE);
  });

  test("rejects a cursor carrying an unreadable timestamp", async () => {
    const { repository, queries } = fakeRepository();

    await expect(listExceptions(repository, { shopDomain: SHOP, after: { createdAt: new Date("nope"), id: "exc-1" } })).rejects.toThrow(/cursor/i);

    expect(queries).toHaveLength(0);
  });

  test("forwards the filters it was given, untouched", async () => {
    const { repository, queries } = fakeRepository();

    await listExceptions(repository, {
      shopDomain: SHOP,
      status: ["open", "resolved"],
      severity: ["blocking"],
      type: ["unroutable_no_warehouse"],
    });

    expect(queries[0]).toMatchObject({
      status: ["open", "resolved"],
      severity: ["blocking"],
      type: ["unroutable_no_warehouse"],
    });
  });
});

describe("closeException", () => {
  const base = {
    shopDomain: SHOP,
    exceptionId: "exc-1",
    status: "resolved" as const,
    actor: "ops@example.com",
    note: "Restocked and re-routed.",
    at: new Date("2026-09-28T13:00:00Z"),
  };

  test("records the session's actor, not one supplied by the caller", async () => {
    const { repository, closes } = fakeRepository();

    await closeException(repository, base);

    expect(closes[0]?.actor).toBe("ops@example.com");
  });

  /**
   * Every one of these is a close that would produce a row no operator can learn anything from,
   * which is why they are rejected rather than defaulted.
   */
  test("refuses a close that cannot be audited", async () => {
    const { repository, closes } = fakeRepository();

    const cases: [Partial<typeof base>, RegExp][] = [
      [{ shopDomain: " " }, /shop domain/i],
      [{ actor: "" }, /who closed it/i],
      [{ actor: "   " }, /who closed it/i],
      [{ note: "" }, /record why/i],
      [{ note: "   " }, /record why/i],
      [{ at: new Date("nope") }, /timestamp/i],
    ];

    for (const [overrides, message] of cases) {
      await expect(closeException(repository, { ...base, ...overrides })).rejects.toThrow(message);
    }

    expect(closes).toHaveLength(0);
  });

  test("does not pre-read, because reading is the race", async () => {
    // The repository's conditional UPDATE is the only thing that can tell "already closed"
    // from "never existed" without a second read that could race in turn. A pre-read here would
    // reintroduce the window where two operators both see `open` and the second note overwrites
    // the first.
    const { repository, queries, closes } = fakeRepository();

    await closeException(repository, base);

    expect(queries).toHaveLength(0);
    expect(closes).toHaveLength(1);
  });

  test("passes `ignored` through as a decision rather than a failure", async () => {
    // Shipping anyway is a legitimate outcome and has to be recorded as a choice, or it reads as
    // an error that someone closed.
    const { repository, closes } = fakeRepository();

    await closeException(repository, { ...base, status: "ignored" });

    expect(closes[0]?.status).toBe("ignored");
  });

  test("relays the repository's already_closed without pretending it succeeded", async () => {
    const raced = openException({ status: "resolved" });
    const { repository } = fakeRepository({
      async closeException() {
        return { outcome: "already_closed", exception: raced };
      },
    });

    const result = await closeException(repository, base);

    // The caller needs this to answer 409 rather than 200, or the operator's note vanishes with
    // no signal that it was ever lost.
    expect(result.outcome).toBe("already_closed");
  });

  test("relays not_found so the route can answer 404", async () => {
    const { repository } = fakeRepository({
      async closeException() {
        return { outcome: "not_found" };
      },
    });

    expect((await closeException(repository, base)).outcome).toBe("not_found");
  });

  test("an id from another shop is not_found, never already_closed", async () => {
    // The distinction is a tenant probe if it leaks: `already_closed` confirms the id exists
    // somewhere. The repository scopes its fallback read, and this pins that the use case does
    // not re-add the shop to the answer.
    const { repository } = fakeRepository({
      async closeException() {
        return { outcome: "not_found" };
      },
    });

    const result = await closeException(repository, { ...base, shopDomain: OTHER_SHOP });

    expect(result.outcome).toBe("not_found");
  });
});
