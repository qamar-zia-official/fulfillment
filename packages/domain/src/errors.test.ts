import { describe, expect, test } from "bun:test";
import { ValidationFailedError, UpstreamRejectedError, UpstreamUnavailableError, isFulfillmentError } from "./errors";

describe("retryability is a property of the failure, not a guess by the caller", () => {
  test("a rejected upstream request is not retryable, because the same bytes get the same refusal", () => {
    expect(new UpstreamRejectedError("warehouse refused: SKU not stocked").retryable).toBe(false);
  });

  test("an unreachable upstream is retryable, because a later attempt may find it up", () => {
    expect(new UpstreamUnavailableError("connect ETIMEDOUT").retryable).toBe(true);
  });

  test("a validation failure is not retryable, because the identical payload is still invalid", () => {
    expect(new ValidationFailedError("currency must be 3 characters").retryable).toBe(false);
  });
});

describe("toSummary", () => {
  test("carries the fields a log line needs and omits the cause chain", () => {
    const cause = new Error("postgres://user:hunter2@host/db");
    const summary = new ValidationFailedError("bad request", { details: { field: "currency" }, cause }).toSummary();

    expect(summary).toEqual({
      name: "ValidationFailedError",
      code: "VALIDATION_FAILED",
      message: "bad request",
      retryable: false,
      details: { field: "currency" },
    });

    // The whole reason a summary projection exists: a connection string in a cause chain
    // must never reach a log aggregator just because we logged the error object.
    expect(JSON.stringify(summary)).not.toContain("hunter2");
  });

  test("omits details entirely when none were supplied, rather than emitting undefined", () => {
    expect("details" in new ValidationFailedError("boom").toSummary()).toBe(false);
  });
});

describe("subclass identity", () => {
  test("name is the concrete subclass, so logs group by real failure type", () => {
    expect(new UpstreamUnavailableError("x").name).toBe("UpstreamUnavailableError");
  });

  test("cause is preserved for debugging without being rendered", () => {
    const cause = new Error("root");
    expect(new UpstreamUnavailableError("wrapper", { cause }).cause).toBe(cause);
  });
});

describe("isFulfillmentError", () => {
  test("recognises a real domain error", () => {
    expect(isFulfillmentError(new ValidationFailedError("x"))).toBe(true);
  });

  test("recognises a duck-typed error, which survives a duplicated copy of @repo/domain", () => {
    // instanceof returns false when the module graph ends up with two instances of the
    // package, which is exactly the situation this guard exists to survive. A structurally
    // identical error from that other copy is still a domain error and must not degrade
    // into an opaque 500.
    const fromAnotherCopy = { name: "ConflictError", code: "CONFLICT", message: "duplicate", retryable: false };
    expect(fromAnotherCopy instanceof ValidationFailedError).toBe(false);
    expect(isFulfillmentError(fromAnotherCopy)).toBe(true);
  });

  test("rejects null, primitives, and plain objects", () => {
    for (const value of [null, undefined, 0, "", "boom", {}, { code: "CONFLICT" }, { retryable: true }]) {
      expect(isFulfillmentError(value)).toBe(false);
    }
  });
});
