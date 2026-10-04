import { ValidationFailedError } from "./errors";
import { type CountryCode, toCountryCode } from "./identifiers";

/**
 * A postal destination.
 *
 * Deliberately all optional: this mirrors what a webhook actually delivers, and the decision
 * about which gaps matter belongs to {@link classifyShippability}, not to the type. A type
 * that enforced "non-empty city" would force a lossy `" "` placeholder through the system to
 * satisfy a compiler, and the placeholder would then look like real data forever.
 */
export interface PostalAddress {
  readonly name?: string | null;
  readonly line1?: string | null;
  readonly line2?: string | null;
  readonly city?: string | null;
  readonly region?: string | null;
  readonly postalCode?: string | null;
  readonly countryCode: CountryCode;
}

/** A specific reason an address cannot be shipped to. */
export type AddressBlocker =
  | "missing_recipient_name"
  | "missing_street_line"
  | "missing_city"
  | "missing_postal_code"
  | "missing_region";

/**
 * Countries where a postal code is not required on a shipping label.
 *
 * `IE` is here because Eircode is a routing key rather than a postal code and genuinely
 * arrives empty on some addresses. This list is the kind of thing that grows with every
 * country that surprises you, which is why it is a named set in one place.
 */
const POSTAL_CODE_OPTIONAL: ReadonlySet<string> = new Set(["IE"]);

/**
 * Countries where the state or province is mandatory.
 *
 * US and CA carriers reject a label without it, so it is a hard requirement there. Elsewhere
 * it is genuinely optional and inventing a value would corrupt the address.
 */
const REGION_REQUIRED: ReadonlySet<string> = new Set(["US", "CA"]);

/** A label cannot be generated without a name to address it to. */
const NAME_REQUIRED: ReadonlySet<string> = new Set(["US", "CA", "GB", "AU", "DE", "FR", "JP"]);

const clean = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * Normalises an address for storage and comparison.
 *
 * Two records of the same address with different casing or padding would otherwise look like
 * two destinations to a rate-shopping or carrier lookup, and the second would quote a
 * different price. Region is uppercased only where it is a state code, because in much of the
 * world the region is a free-text city or district where case is meaningful to the recipient.
 */
export const toPostalAddress = (input: PostalAddress): PostalAddress => {
  if (input === null || typeof input !== "object") {
    throw new ValidationFailedError("Address must be an object.");
  }

  const countryCode = toCountryCode(String(input.countryCode));
  const region = clean(input.region);

  return {
    name: clean(input.name),
    line1: clean(input.line1),
    line2: clean(input.line2),
    city: clean(input.city),
    region: region === null ? null : REGION_REQUIRED.has(countryCode) ? region.toUpperCase() : region,
    postalCode: clean(input.postalCode),
    countryCode,
  };
};

/**
 * The result of judging an address.
 *
 * A union rather than `isRoutable: boolean` plus a separate error, because the caller needs
 * the blockers either way -- the difference is only whether it stops. A boolean would force
 * one of the two paths to re-derive the reasons, and re-deriving them is how the operator's
 * screen ends up saying "address invalid" with nothing to act on.
 */
export type ShippabilityVerdict =
  | { readonly shippable: true }
  | { readonly shippable: false; readonly blockers: readonly AddressBlocker[] };

/**
 * Decides whether an address is complete enough to route and label.
 *
 * This is a business judgement, so it returns a verdict and never throws. A missing city is
 * not a bug in the software; it is an order a human needs to fix, and the routing phase turns
 * a `shippable: false` verdict into a persisted exception with these exact blockers attached
 * so the operator sees *what* to correct. Throwing here would crash the worker and lose the
 * order, when the correct outcome is to park the order and tell someone.
 */
export const classifyShippability = (address: PostalAddress): ShippabilityVerdict => {
  const blockers: AddressBlocker[] = [];
  const country = address.countryCode;

  if (NAME_REQUIRED.has(country) && clean(address.name) === null) blockers.push("missing_recipient_name");
  if (clean(address.line1) === null) blockers.push("missing_street_line");
  if (clean(address.city) === null) blockers.push("missing_city");

  if (REGION_REQUIRED.has(country) && clean(address.region) === null) blockers.push("missing_region");

  if (!POSTAL_CODE_OPTIONAL.has(country) && clean(address.postalCode) === null) {
    blockers.push("missing_postal_code");
  }

  return blockers.length === 0 ? { shippable: true } : { shippable: false, blockers };
};

/**
 * Human-facing text for an exception record. Never shown raw to an end customer.
 *
 * Every message names the field and the consequence, because the reader is an operator
 * working a queue: "missing_city" tells them the column, "No city." tells them nothing about
 * why the order stopped.
 */
export const describeBlocker = (blocker: AddressBlocker): string => {
  switch (blocker) {
    case "missing_recipient_name":
      return "No recipient name on the shipping address, so a carrier label cannot be addressed.";
    case "missing_street_line":
      return "No street address on the shipping address, so a carrier cannot deliver the parcel.";
    case "missing_city":
      return "No city on the shipping address, so it cannot be matched to a delivery zone.";
    case "missing_postal_code":
      return "No postal code, which the destination country requires for delivery.";
    case "missing_region":
      return "No state or province, which the destination carrier requires on the label.";
  }
};
