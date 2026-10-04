import { describe, expect, test } from "bun:test";
import { ConflictError, NotFoundError, PersistenceError, UpstreamRejectedError, UpstreamUnavailableError, ValidationFailedError, InvalidStateTransitionError } from "@repo/domain";
import { toApiError } from "./api-errors";

describe("status mapping", () => {
  test("a non-retryable failure maps to 4xx, so the sender is not told to come back", () => {
    // Shopify redelivers on any non-2xx. A 500 for a permanently invalid payload means
    // pointless retries until it gives up, and no operator ever learns why.
    expect(toApiError(new ValidationFailedError("bad currency"), "r1").status).toBe(422);
    expect(toApiError(new UpstreamRejectedError("out of stock"), "r1").status).toBe(422);
    expect(toApiError(new NotFoundError("no such order"), "r1").status).toBe(404);
  });

  test("a retryable failure maps to 5xx, which is the instruction to try again", () => {
    expect(toApiError(new UpstreamUnavailableError("timeout"), "r1").status).toBe(503);
    expect(toApiError(new PersistenceError("connection terminated"), "r1").status).toBe(500);
  });

  test("an illegal state transition is a 409, because the caller can act on it", () => {
    expect(toApiError(new InvalidStateTransitionError("cannot ship a cancelled order"), "r1").status).toBe(409);
  });

  test("a conflict detected while persisting is a 422, not a 409", () => {
    // The distinction is worth stating: a 409 says "re-read state and reconcile", which
    // presumes the caller can. A conflict we hit while writing an individually well-formed
    // request is unprocessable content, and telling the sender to retry by re-reading
    // would send it in a circle.
    expect(toApiError(new ConflictError("duplicate key"), "r1").status).toBe(422);
  });
});

describe("response body", () => {
  test("carries a stable code and the requestId an operator can search for", () => {
    const { body } = toApiError(new ValidationFailedError("anything"), "req-42");
    expect(body.error).toEqual({
      code: "VALIDATION_FAILED",
      message: "The request payload did not satisfy the required shape.",
      requestId: "req-42",
    });
  });

  test("never forwards the domain message, so payload detail cannot leak into a response", () => {
    // "Our messages are written to be safe" is a convention that decays: the first
    // ValidationFailedError carrying a field value straight from a Zod issue would leak
    // request content. A fixed string per code cannot drift that way.
    const leaky = new ValidationFailedError('currency "SECRET-CARD-NUMBER" is not a 3-character code', {
      details: { customerEmail: "victim@example.com" },
    });
    const serialised = JSON.stringify(toApiError(leaky, "r1").body);

    expect(serialised).not.toContain("SECRET-CARD-NUMBER");
    expect(serialised).not.toContain("victim@example.com");
  });

  test("an unrecognised error becomes a generic 500 rather than leaking its own message", () => {
    const { status, body } = toApiError(new TypeError("cannot read properties of undefined (reading 'refrencedTable')"), "r1");
    expect(status).toBe(500);
    expect(body.error.message).toBe("An unexpected error occurred.");
    expect(JSON.stringify(body)).not.toContain("refrencedTable");
  });

  test("handles non-Error throws without throwing itself", () => {
    // A `throw "string"` in a dependency must not turn our error handler into the crash.
    for (const value of [null, undefined, "boom", 42, { random: true }]) {
      expect(toApiError(value, "r1").status).toBe(500);
    }
  });
});
