import { describe, expect, test } from "bun:test";
import { ValidationFailedError } from "./errors";
import { toCountryCode } from "./identifiers";
import { classifyShippability, describeBlocker, toPostalAddress, type AddressBlocker, type PostalAddress } from "./address";

const US: PostalAddress = {
  name: "Ada Lovelace",
  line1: "1 Analytical Way",
  city: "Portland",
  region: "or",
  postalCode: "97209",
  countryCode: toCountryCode("US"),
};

describe("toPostalAddress normalises without inventing data", () => {
  test("collapses padding and casing so one address is one address", () => {
    const messy = toPostalAddress({ ...US, region: " or ", line1: "  1 Analytical   Way  " });
    expect(messy.line1).toBe("1 Analytical Way");
    // US state codes are canonicalised; elsewhere region is free text and left alone.
    expect(messy.region).toBe("OR");
  });

  test("preserves region casing outside the US and CA, where it is a district name", () => {
    const japanese = toPostalAddress({ line1: "1-1-1", city: "Shibuya", region: "Shibuya ku", postalCode: "150-0002", countryCode: toCountryCode("JP") });
    expect(japanese.region).toBe("Shibuya ku");
  });

  test("treats whitespace-only fields as absent rather than as a value", () => {
    // Otherwise a stray " " in a Shopify payload satisfies a required field and produces a
    // label addressed to nobody.
    const blank = toPostalAddress({ ...US, city: "   ", line2: "  " });
    expect(blank.city).toBeNull();
    expect(blank.line2).toBeNull();
    expect(classifyShippability(blank).shippable).toBe(false);
  });
});

describe("classifyShippability judges data instead of crashing on it", () => {
  test("a complete US address is shippable", () => {
    expect(classifyShippability(US)).toEqual({ shippable: true });
  });

  test("reports every missing field at once, not just the first", () => {
    // An operator fixing an address one error per work order is an operator quitting.
    const verdict = classifyShippability({ countryCode: toCountryCode("US") });
    expect(verdict.shippable).toBe(false);
    expect(verdict).toEqual({
      shippable: false,
      blockers: ["missing_recipient_name", "missing_street_line", "missing_city", "missing_region", "missing_postal_code"],
    });
  });

  test("US and CA require a state because their carriers reject a label without one", () => {
    const noRegion = classifyShippability({ ...US, region: null });
    expect(noRegion).toEqual({ shippable: false, blockers: ["missing_region"] });
  });

  test("a country that does not need a state is not asked for one", () => {
    // Inventing a region to satisfy a rule would corrupt the address.
    expect(classifyShippability({ ...US, countryCode: toCountryCode("DE"), region: null })).toEqual({ shippable: true });
  });

  test("IE is exempt from the postal code rule because an Eircode is not a postal code", () => {
    const ireland: PostalAddress = { name: "Grace H", line1: "1 Main St", city: "Cork", countryCode: toCountryCode("IE") };
    expect(classifyShippability(ireland)).toEqual({ shippable: true });
  });

  test("countries that do not need a recipient name are not asked for one", () => {
    expect(classifyShippability({ ...US, name: null, countryCode: toCountryCode("SG") })).toEqual({ shippable: true });
  });

  test("a bad country code is a malformed address, which is a throw, not a blocker", () => {
    // The distinction matters: a country of "ZZ" is a broken upstream payload we cannot
    // reason about, whereas a missing city is a real order awaiting a human.
    expect(() => toPostalAddress({ line1: "1", city: "X", countryCode: "ZZ" as never })).toThrow(ValidationFailedError);
  });
});

describe("describeBlocker", () => {
  const ALL_BLOCKERS: AddressBlocker[] = [
    "missing_recipient_name",
    "missing_street_line",
    "missing_city",
    "missing_postal_code",
    "missing_region",
  ];

  test("every blocker has a message an operator can act on", () => {
    for (const blocker of ALL_BLOCKERS) {
      const message = describeBlocker(blocker);
      expect(message.length).toBeGreaterThan(20);
      expect(message).not.toContain("undefined");
      // A message that does not say what is missing leaves the operator guessing.
      expect(message.toLowerCase()).toMatch(/no |required/);
    }
  });

  test("no two blockers share a message, which would make the queue ambiguous", () => {
    const messages = ALL_BLOCKERS.map(describeBlocker);
    expect(new Set(messages).size).toBe(ALL_BLOCKERS.length);
  });
});
