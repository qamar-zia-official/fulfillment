import { ValidationFailedError } from "./errors";

/**
 * ISO 4217 alphabetic code, uppercased.
 *
 * Typed as a plain `string` alias rather than a union of every currency: the list is 180+
 * codes and changes, and a union would guarantee a stale compile error somewhere while
 * protecting nothing. Validation happens once, in {@link toCurrency}.
 */
export type Currency = string;

/**
 * Currencies whose minor unit is not 1/100.
 *
 * This table is the reason `Money` stores an integer. "100" means 100 yen and 100 cents in
 * two different currencies, and code that assumes a universal two decimals produces totals
 * that are wrong by 100x for half the world. Getting this right is a few lines; getting it
 * wrong is a reconciliation incident.
 */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  // Zero-decimal: the major unit is the smallest unit.
  BHD: 3, CLP: 0, DJF: 0, GNF: 0, IQD: 3, ISK: 0, JOD: 3, JPY: 0,
  KMF: 0, KRW: 0, KWD: 3, LYD: 3, OMR: 3, PYG: 0, RWF: 0, TND: 3,
  UGX: 0, VND: 0, XAF: 0, XOF: 0, XPF: 0,
};

/**
 * ISO 4217 assigns exponent 2 to everything not listed above, so an unrecognised code
 * defaults to cents rather than being rejected. A new currency is therefore handled with the
 * overwhelmingly common convention instead of blocking an order.
 */
export const currencyExponent = (currency: Currency): number => CURRENCY_EXPONENTS[currency] ?? 2;

const CURRENCY_CODE = /^[A-Z]{3}$/;

export const toCurrency = (value: string): Currency => {
  const normalised = value.trim().toUpperCase();
  if (!CURRENCY_CODE.test(normalised)) {
    throw new ValidationFailedError("Currency must be a 3-letter ISO 4217 code.", { details: { value } });
  }
  return normalised;
};

/**
 * An amount of money in a single currency.
 *
 * Invariants, all enforced at construction:
 *  - `minorUnits` is a safe integer, so no value beyond 2^53-1 can silently lose precision
 *  - every operation that combines two amounts requires the same currency
 *
 * The class is immutable. `plus` returns a new `Money`; there is no `addTo`, because a
 * mutable amount that is also a hash key or a React prop is a class of bug with no upside.
 */
export class Money {
  private constructor(readonly minorUnits: number, readonly currency: Currency) {}

  static ofMinorUnits(currency: Currency, minorUnits: number): Money {
    assertSafeInteger(minorUnits, "minorUnits");
    return new Money(minorUnits, toCurrency(currency));
  }

  static zero(currency: Currency): Money {
    return Money.ofMinorUnits(currency, 0);
  }

  /**
   * Builds money from a decimal string such as `"149.99"`.
   *
   * Parsed by string manipulation, never by `parseFloat`. `parseFloat("0.1") + parseFloat("0.2")`
   * is `0.30000000000000004`; for a currency value that error does not round away, it lands in
   * a ledger. Splitting the string keeps every step in exact integer arithmetic.
   *
   * Trailing zeros beyond the currency's exponent are accepted and dropped, because
   * merchants legitimately send `"10.5000"` in USD. Significant extra digits are rejected:
   * silently rounding a price is a decision the caller must make, not this function.
   */
  static fromDecimal(currency: Currency, decimal: string): Money {
    const code = toCurrency(currency);
    const exponent = currencyExponent(code);
    const trimmed = decimal.trim();

    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      throw new ValidationFailedError("Amount must be a decimal string such as \"149.99\".", { details: { value: decimal } });
    }

    const negative = trimmed.startsWith("-");
    const unsigned = negative ? trimmed.slice(1) : trimmed;
    const [whole = "0", fraction = ""] = unsigned.split(".");

    if (fraction.length > exponent) {
      const excess = fraction.slice(exponent);
      if (/[^0]/.test(excess)) {
        throw new ValidationFailedError(
          `Amount has more precision than ${code} allows.`,
          { details: { value: decimal, exponent, excess } },
        );
      }
    }

    const paddedFraction = fraction.slice(0, exponent).padEnd(exponent, "0");
    const magnitude = Number.parseInt(exponent === 0 ? whole : `${whole}${paddedFraction}`, 10);

    if (!Number.isSafeInteger(magnitude)) {
      throw new ValidationFailedError("Amount is too large to represent exactly.", { details: { value: decimal } });
    }

    return new Money(negative ? -magnitude : magnitude, code);
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other, "plus");
    const sum = this.minorUnits + other.minorUnits;
    assertSafeInteger(sum, "sum");
    return new Money(sum, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other, "minus");
    const difference = this.minorUnits - other.minorUnits;
    assertSafeInteger(difference, "difference");
    return new Money(difference, this.currency);
  }

  /**
   * Scales by a whole quantity -- unit price times three units.
   *
   * Restricted to integers on purpose. Quantity is a count of physical objects; a
   * fractional count means the caller is actually computing a rate (tax, shipping, a prorated
   * refund) and reaching for this method to do it means rounding is about to go unstated.
   */
  multiply(quantity: number): Money {
    assertSafeInteger(quantity, "quantity");
    const product = this.minorUnits * quantity;
    assertSafeInteger(product, "product");
    return new Money(product, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  /** `-1`, `0`, or `1`. Throws across currencies rather than inventing an ordering. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other, "compare");
    if (this.minorUnits === other.minorUnits) return 0;
    return this.minorUnits < other.minorUnits ? -1 : 1;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  isZero(): boolean {
    return this.minorUnits === 0;
  }

  isPositive(): boolean {
    return this.minorUnits > 0;
  }

  /**
   * Renders for humans and for the database: `"149.99"`, or `"1200"` for a zero-decimal
   * currency. Never scientific notation and never locale-dependent, so a stored value is
   * byte-identical regardless of where the process ran.
   */
  toDecimalString(): string {
    const exponent = currencyExponent(this.currency);
    const sign = this.minorUnits < 0 ? "-" : "";
    const digits = Math.abs(this.minorUnits).toString().padStart(exponent + 1, "0");

    if (exponent === 0) return `${sign}${digits}`;
    return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  }

  private assertSameCurrency(other: Money, operation: string): void {
    if (other.currency !== this.currency) {
      throw new ValidationFailedError(`Cannot ${operation} amounts in different currencies.`, {
        details: { left: this.currency, right: other.currency },
      });
    }
  }
}

/**
 * Sums amounts, which is how an order total is actually built.
 *
 * The empty case is the reason this exists as its own function: an order with no lines still
 * has a total, and it has to be zero *in the order's currency*. Returning a `null` or
 * defaulting to USD would make a promotion's currency depend on whether the cart was empty.
 */
export const sumMoney = (amounts: readonly Money[], currency: Currency): Money => {
  const target = toCurrency(currency);
  return amounts.reduce((total, amount) => total.plus(amount), Money.zero(target));
};

const assertSafeInteger = (value: number, label: string): void => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ValidationFailedError(`${label} must be a safe integer.`, { details: { received: value } });
  }
};
