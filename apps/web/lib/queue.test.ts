import { describe, expect, test } from "bun:test";
import { buildExceptionQuery, formatAge, formatTimestamp, normaliseShopDomain, summariseDetails } from "./queue";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const ago = (milliseconds: number) => new Date(NOW - milliseconds).toISOString();

describe("normaliseShopDomain", () => {
  test("accepts a plain shop domain unchanged", () => {
    expect(normaliseShopDomain("kinetous.myshopify.com")).toEqual({ ok: true, value: "kinetous.myshopify.com" });
  });

  /**
   * Pasted input, not typed input.
   *
   * These are the shapes an operator actually hands this field, and every one of them used to
   * reach the API as a different string than the one stored. The failure is silent: the query
   * succeeds and returns an empty queue, which on a triage screen is indistinguishable from
   * "there is nothing to do".
   */
  test.each([
    ["a pasted URL with a scheme", "https://kinetous.myshopify.com", "kinetous.myshopify.com"],
    ["an http scheme", "http://kinetous.myshopify.com", "kinetous.myshopify.com"],
    ["a scheme-relative URL", "//kinetous.myshopify.com", "kinetous.myshopify.com"],
    ["a trailing slash", "kinetous.myshopify.com/", "kinetous.myshopify.com"],
    ["an admin path", "https://kinetous.myshopify.com/admin/orders", "kinetous.myshopify.com"],
    ["a query string", "kinetous.myshopify.com?foo=bar", "kinetous.myshopify.com"],
    ["surrounding whitespace", "  kinetous.myshopify.com  ", "kinetous.myshopify.com"],
    ["mixed case", "Kinetous.MyShopify.COM", "kinetous.myshopify.com"],
  ])("normalises %s", (_label, input, expected) => {
    expect(normaliseShopDomain(input)).toEqual({ ok: true, value: expected });
  });

  test.each([
    ["empty", "", "Enter a shop domain"],
    ["whitespace only", "   ", "Enter a shop domain"],
    ["a scheme with no host", "https://", "not a shop domain"],
    ["a single label with no dot", "localhost", "does not look like a shop domain"],
    ["an embedded space", "kinetous .myshopify.com", "cannot contain spaces"],
  ])("rejects %s with a message naming the fix", (_label, input, expectedFragment) => {
    const result = normaliseShopDomain(input);

    expect(result.ok).toBe(false);
    // The message has to say what to do instead. "Invalid input" makes the operator guess, and
    // a wrong guess returns an empty queue rather than an error, so the wrong guess is silent.
    if (!result.ok) expect(result.reason).toContain(expectedFragment);
  });

  test("rejects an over-long domain", () => {
    // 255 is the DNS limit; the check is a typo-catcher, so it fires just past the real ceiling
    // rather than at some arbitrary number below it.
    expect(normaliseShopDomain(`${"a".repeat(300)}.com`).ok).toBe(false);
    expect(normaliseShopDomain(`${"a".repeat(251)}.com`).ok).toBe(true);
  });
});

describe("buildExceptionQuery", () => {
  const base = { shopDomain: "kinetous.myshopify.com", statuses: [], severities: [], types: [], limit: 25 } as const;

  test("always sends the shop domain, because the API requires it and scopes every query with it", () => {
    expect(buildExceptionQuery(base).get("shopDomain")).toBe("kinetous.myshopify.com");
  });

  test("repeats multi-valued filters rather than joining them", () => {
    // The API reads these with `getAll`, so a comma-joined value would be narrowed as one
    // invalid token and the whole request would 400.
    const query = buildExceptionQuery({ ...base, statuses: ["open", "ignored"], types: ["carrier_error"] });

    expect(query.getAll("status")).toEqual(["open", "ignored"]);
    expect(query.getAll("type")).toEqual(["carrier_error"]);
  });

  test("omits filters that are unset instead of sending them empty", () => {
    // `?severity=` is a 400 from the API's `narrow`, whereas omitting it means "no filter".
    const query = buildExceptionQuery(base);

    expect(query.has("severity")).toBe(false);
    expect(query.has("type")).toBe(false);
    expect(query.has("cursor")).toBe(false);
    expect(query.has("status")).toBe(false);
  });

  test("sends the limit the operator chose, not a hard-coded page size", () => {
    expect(buildExceptionQuery({ ...base, limit: 50 }).get("limit")).toBe("50");
  });

  test("passes the cursor through opaquely", () => {
    const query = buildExceptionQuery({ ...base, cursor: "eyJjIjoiMjAyNi0wOS0yOVQxMTowMDowMFoiLCJpIjoiZXhjLTEifQ" });

    expect(query.get("cursor")).toBe("eyJjIjoiMjAyNi0wOS0yOVQxMTowMDowMFoiLCJpIjoiZXhjLTEifQ");
  });

  test("treats a null cursor as absent", () => {
    expect(buildExceptionQuery({ ...base, cursor: null }).has("cursor")).toBe(false);
  });
});

describe("formatAge", () => {
  test.each([
    ["under a minute", 30_000, "just now"],
    ["exactly a minute", 60_000, "1m ago"],
    ["minutes", 59 * MINUTE_, "59m ago"],
    ["an hour", 60 * MINUTE_, "1h ago"],
    ["hours", 23 * HOUR_, "23h ago"],
    ["a day", 24 * HOUR_, "1d ago"],
    ["days", 40 * 24 * HOUR_, "40d ago"],
  ])("renders %s", (_label, elapsed, expected) => {
    expect(formatAge(ago(elapsed as number), NOW)).toBe(expected);
  });

  test("rounds down, so an age never claims more time has passed than has", () => {
    // 119.9 minutes must read "1h ago", not "2h ago": an operator deciding whether an exception
    // is stale should never be told it is older than it is.
    expect(formatAge(ago(119.9 * MINUTE_), NOW)).toBe("1h ago");
  });

  /**
   * Clock skew, not a data bug.
   *
   * A row written by a database clock a few seconds ahead of the browser renders as a negative
   * age otherwise, which reads as corruption and sends someone looking for a bug in the ingest
   * path. The absolute time stays available in the tooltip.
   */
  test("reports a future timestamp as just now rather than a negative age", () => {
    expect(formatAge(ago(-4 * MINUTE_), NOW)).toBe("just now");
  });

  test("reports an unparseable timestamp as unknown", () => {
    expect(formatAge("not a date", NOW)).toBe("unknown");
  });
});

const MINUTE_ = 60_000;
const HOUR_ = 60 * MINUTE_;

describe("formatTimestamp", () => {
  test("renders UTC, independent of the runtime's locale and zone", () => {
    // The reason this is hand-formatted: `toLocaleString` would render the same instant
    // differently on the server and in the browser, which is React's hydration mismatch. Two
    // operators comparing one incident should also see the same clock.
    expect(formatTimestamp("2026-09-28T12:34:56.789Z")).toBe("2026-09-28 12:34 UTC");
  });

  test("reports an unparseable timestamp as unknown", () => {
    expect(formatTimestamp("nope")).toBe("unknown");
  });
});

describe("summariseDetails", () => {
  test("flattens a nested object into one readable line", () => {
    expect(summariseDetails({ shortfall: { "KNT-TEE": 2 } })).toBe("shortfall: {KNT-TEE 2}");
  });

  test("renders scalar values", () => {
    expect(summariseDetails({ carrier: "Shippo", attempts: 3 })).toBe("carrier: Shippo · attempts: 3");
  });

  test("returns an empty string for no details", () => {
    expect(summariseDetails({})).toBe("");
    expect(summariseDetails(null)).toBe("");
    expect(summariseDetails(undefined)).toBe("");
  });

  test("degrades an unrecognised shape to text rather than to an empty cell", () => {
    // An empty cell reads as "nothing further to report". When the truth is "this UI has not
    // been taught this shape yet", that is a misleading blank.
    expect(summariseDetails("plain string")).toBe("plain string");
    expect(summariseDetails(["a", "b"])).toBe("a, b");
  });

  test("truncates a long line instead of letting it wrap the row", () => {
    const summary = summariseDetails({ note: "x".repeat(300) });

    expect(summary.length).toBeLessThanOrEqual(140);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("stops after three keys so one rich object cannot fill the row", () => {
    expect(summariseDetails({ a: 1, b: 2, c: 3, d: 4 })).toBe("a: 1 · b: 2 · c: 3 · …");
  });
});
