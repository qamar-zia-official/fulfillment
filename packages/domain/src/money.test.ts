import { describe, expect, test } from "bun:test";
import { ValidationFailedError } from "./errors";
import { Money, currencyExponent, sumMoney, toCurrency } from "./money";

describe("arithmetic stays exact where floating point would not", () => {
  test("the classic float failure is impossible because amounts are integers", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754. In a ledger that is a real
    // discrepancy, not a rounding curiosity.
    const total = Money.fromDecimal("USD", "0.1").plus(Money.fromDecimal("USD", "0.2"));
    expect(total.toDecimalString()).toBe("0.30");
  });

  test("a thousand small additions do not drift", () => {
    let total = Money.zero("USD");
    for (let i = 0; i < 1000; i += 1) total = total.plus(Money.fromDecimal("USD", "0.07"));
    expect(total.toDecimalString()).toBe("70.00");
  });

  test("subtraction and multiplication are exact", () => {
    expect(Money.fromDecimal("USD", "10.00").minus(Money.fromDecimal("USD", "0.01")).toDecimalString()).toBe("9.99");
    expect(Money.fromDecimal("USD", "19.99").multiply(3).toDecimalString()).toBe("59.97");
  });

  test("rejects values past 2^53-1 rather than silently rounding them", () => {
    expect(() => Money.ofMinorUnits("USD", Number.MAX_SAFE_INTEGER + 2)).toThrow(ValidationFailedError);
    expect(() => Money.ofMinorUnits("USD", 10.5)).toThrow("safe integer");
  });
});

describe("currency exponents", () => {
  test("zero-decimal currencies have no minor unit to divide by", () => {
    expect(currencyExponent("JPY")).toBe(0);
    // 100 means 100 yen, not 1.00 yen. Code assuming two decimals is wrong by 100x here.
    expect(Money.fromDecimal("JPY", "100").toDecimalString()).toBe("100");
    expect(Money.ofMinorUnits("JPY", 100).toDecimalString()).toBe("100");
  });

  test("three-decimal currencies are handled", () => {
    expect(currencyExponent("KWD")).toBe(3);
    expect(Money.fromDecimal("KWD", "1.234").toDecimalString()).toBe("1.234");
  });

  test("an unknown code falls back to the ISO default of 2", () => {
    expect(currencyExponent("XYZ")).toBe(2);
  });

  test("currency codes are normalised to uppercase", () => {
    expect(toCurrency(" usd ")).toBe("USD");
    expect(() => toCurrency("DOLLARS")).toThrow(ValidationFailedError);
  });
});

describe("fromDecimal", () => {
  test("accepts trailing zeros beyond the exponent, which merchants really send", () => {
    expect(Money.fromDecimal("USD", "10.5000").toDecimalString()).toBe("10.50");
    expect(Money.fromDecimal("USD", "10.5").toDecimalString()).toBe("10.50");
    expect(Money.fromDecimal("USD", "10").toDecimalString()).toBe("10.00");
  });

  test("refuses to round away significant digits", () => {
    // Rounding a price is a commercial decision. The function that computes money should
    // not make it silently.
    expect(() => Money.fromDecimal("USD", "10.567")).toThrow("more precision");
    expect(() => Money.fromDecimal("JPY", "10.5")).toThrow("more precision");
  });

  test("rejects anything that is not a decimal string", () => {
    for (const bad of ["", "abc", "1.2.3", "1e5", "NaN", "USD 10", "."]) {
      expect(() => Money.fromDecimal("USD", bad)).toThrow(ValidationFailedError);
    }
  });

  test("handles negatives and negative zero", () => {
    expect(Money.fromDecimal("USD", "-5.00").toDecimalString()).toBe("-5.00");
    expect(Money.fromDecimal("USD", "-0.00").isZero()).toBe(true);
  });
});

describe("currency mismatches are refused instead of approximated", () => {
  test("adding across currencies throws rather than picking a rate nobody supplied", () => {
    expect(() => Money.ofMinorUnits("USD", 100).plus(Money.ofMinorUnits("EUR", 100))).toThrow(
      "different currencies",
    );
    expect(() => Money.ofMinorUnits("USD", 100).compare(Money.ofMinorUnits("EUR", 100))).toThrow(
      "different currencies",
    );
  });

  test("sumMoney of an empty list is zero in the requested currency", () => {
    // The empty case is why this takes an explicit currency: defaulting would make a
    // promotion's currency depend on whether the cart happened to be empty.
    const total = sumMoney([], "JPY");
    expect(total.currency).toBe("JPY");
    expect(total.isZero()).toBe(true);
  });

  test("sumMoney rejects a mixed-currency list instead of coercing", () => {
    const amounts = [Money.ofMinorUnits("USD", 100), Money.ofMinorUnits("EUR", 100)];
    expect(() => sumMoney(amounts, "USD")).toThrow(ValidationFailedError);
  });
});

describe("equality and comparison", () => {
  test("equals is value-based, so it survives losing the class identity", () => {
    expect(Money.fromDecimal("USD", "1.00").equals(Money.ofMinorUnits("USD", 100))).toBe(true);
    expect(Money.ofMinorUnits("USD", 100).equals(Money.ofMinorUnits("EUR", 100))).toBe(false);
  });

  test("compare orders within a currency", () => {
    const small = Money.ofMinorUnits("USD", 100);
    const large = Money.ofMinorUnits("USD", 200);
    expect(small.compare(large)).toBe(-1);
    expect(large.compare(small)).toBe(1);
    expect(small.compare(Money.ofMinorUnits("USD", 100))).toBe(0);
  });

  test("multiply is restricted to whole quantities", () => {
    // A fractional count means the caller is computing a rate, not a count of objects.
    expect(() => Money.ofMinorUnits("USD", 100).multiply(1.5)).toThrow("safe integer");
  });
});
