import { ValidationFailedError } from "./errors";

/**
 * Branded identifiers.
 *
 * Every one of these is a `string` at runtime, so there is no serialisation cost and no
 * mapping layer. The brand exists only in the type system, and it buys one specific thing:
 * the compiler refuses to pass a `WarehouseId` where an `OrderId` is expected.
 *
 * Without this, `allocateOrder(orderId: string, warehouseId: string)` compiles happily when
 * the arguments are swapped. The failure then surfaces as a foreign-key violation, or worse,
 * as a successful write against the wrong row. Branded types move that from a runtime
 * incident to a compile error, which is the cheapest place a bug can die.
 *
 * The `declare const` is erased at runtime: it exists solely to make the property unique in
 * the type system. Two different brands cannot be assignable to each other, and a plain
 * `string` cannot be assigned to any of them, so values must be built through the factories
 * below -- which is the point, because that is where validation lives.
 */
declare const brand: unique symbol;

type Brand<TValue, TName extends string> = TValue & { readonly [brand]: TName };

export type OrderId = Brand<string, "OrderId">;
export type OrderLineId = Brand<string, "OrderLineId">;
export type WarehouseId = Brand<string, "WarehouseId">;
export type FulfillmentId = Brand<string, "FulfillmentId">;
export type ReservationId = Brand<string, "ReservationId">;
export type ShipmentId = Brand<string, "ShipmentId">;
export type ExceptionId = Brand<string, "ExceptionId">;
export type ShopDomain = Brand<string, "ShopDomain">;

/**
 * A stock-keeping unit.
 *
 * This is the highest-value brand in the file. SKUs arrive from merchants with inconsistent
 * casing and padding, and if `"KNT-TEE"` and `" knt-tee "` are treated as different SKUs
 * the system will report a stock-out on a product sitting on a shelf. `toSku` normalises
 * once, at the boundary, and every comparison downstream can then assume a canonical form.
 */
export type Sku = Brand<string, "Sku">;

/** An ISO 3166-1 alpha-2 country code, uppercased. Routing groups on this. */
export type CountryCode = Brand<string, "CountryCode">;

const ISO_3166_ALPHA2 = /^[A-Z]{2}$/;

/**
 * The assigned ISO 3166-1 alpha-2 codes.
 *
 * A shape check alone (`/^[A-Z]{2}$/`) accepts `"ZZ"`, which is well-formed and unassigned.
 * That matters more here than in most systems: country is the primary key the routing engine
 * groups warehouses by, so an unassigned code produces an order that can never be routed and
 * therefore a permanent, silent exception. Since the database stores this as free text with no
 * constraint, this function is the only gate -- so the gate checks the real list.
 *
 * Kept as one delimited string and split at load: 249 array entries would be 249 lines of
 * noise, and this is a lookup table, not logic. Source: the current ISO 3166-1 alpha-2
 * assignment list; the occasional reassignment (which codes are *removed* from it) is
 * vanishingly rare and would show up immediately as a rejected country.
 */
const ASSIGNED_COUNTRY_CODES: ReadonlySet<string> = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
    "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
    "DE DJ DK DM DO DZ " +
    "EC EE EG EH ER ES ET " +
    "FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
    "HK HM HN HR HT HU " +
    "ID IE IL IM IN IO IQ IR IS IT " +
    "JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ " +
    "LA LB LC LI LK LR LS LT LU LV LY " +
    "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
    "NA NC NE NF NG NI NL NO NP NR NU NZ " +
    "OM " +
    "PA PE PF PG PH PK PL PM PN PR PS PT PW PY " +
    "QA " +
    "RE RO RS RU RW " +
    "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
    "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
    "UA UG UM US UY UZ " +
    "VA VC VE VG VI VN VU " +
    "WF WS " +
    "YE YT " +
    "ZA ZM ZW"
  ).split(" "),
);

/**
 * Shared shape for the identifier factories: a non-empty, already-trimmed string.
 *
 * Rejecting an empty string is worth doing even though it looks pedantic. These ids end up
 * in foreign keys and unique indexes, and an empty string there is a row that silently
 * matches every other empty string -- the kind of corruption that is discovered long after
 * the commit that caused it.
 */
function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new ValidationFailedError(`${label} must be a string.`, { details: { received: typeof value } });
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationFailedError(`${label} must not be empty.`);
  }
  return trimmed;
}

function makeIdFactory<TName extends string>(label: TName) {
  return (value: string): Brand<string, TName> => requireNonEmpty(value, label) as Brand<string, TName>;
}

export const toOrderId = makeIdFactory("OrderId");
export const toOrderLineId = makeIdFactory("OrderLineId");
export const toWarehouseId = makeIdFactory("WarehouseId");
export const toFulfillmentId = makeIdFactory("FulfillmentId");
export const toReservationId = makeIdFactory("ReservationId");
export const toShipmentId = makeIdFactory("ShipmentId");
export const toExceptionId = makeIdFactory("ExceptionId");

/**
 * Normalises a shop domain to its canonical lowercase form.
 *
 * `MyStore.myshopify.com` and `mystore.myshopify.com` are the same shop, and the shop domain
 * is half of the unique key on orders. Without normalisation the same merchant produces two
 * order streams and duplicate orders appear the first time a webhook is replayed with
 * different casing.
 */
export const toShopDomain = (value: string): ShopDomain => {
  const normalised = requireNonEmpty(value, "ShopDomain").toLowerCase();
  if (!normalised.includes(".") || normalised.startsWith(".") || normalised.endsWith(".") || normalised.includes("..")) {
    throw new ValidationFailedError("ShopDomain must be a hostname such as store.myshopify.com.", { details: { value } });
  }
  return normalised as ShopDomain;
};

/**
 * Maximum length matches a Postgres `text` column's practical use and, more usefully, keeps
 * a pathological input from becoming a multi-megabyte index key.
 */
const MAX_SKU_LENGTH = 64;

export const toSku = (value: string): Sku => {
  const normalised = requireNonEmpty(value, "Sku").toUpperCase().replace(/\s+/g, "-");
  if (normalised.length > MAX_SKU_LENGTH) {
    throw new ValidationFailedError(`Sku must be ${MAX_SKU_LENGTH} characters or fewer.`, { details: { length: normalised.length } });
  }
  return normalised as Sku;
};

export const toCountryCode = (value: string): CountryCode => {
  const normalised = requireNonEmpty(value, "CountryCode").toUpperCase();
  if (!ISO_3166_ALPHA2.test(normalised)) {
    throw new ValidationFailedError("CountryCode must be a 2-letter ISO 3166-1 code.", { details: { value } });
  }
  if (!ASSIGNED_COUNTRY_CODES.has(normalised)) {
    // Distinct message from the shape failure: the value is well-formed but refers to no
    // country, which is a data problem upstream rather than a typo in a field name.
    throw new ValidationFailedError("CountryCode is well-formed but not an assigned ISO 3166-1 code.", {
      details: { value: normalised },
    });
  }
  return normalised as CountryCode;
};

/**
 * Narrows an unbranded string back to a brand at a trust boundary.
 *
 * Needed when reading a value out of the database, a webhook, or JSON: those give us `string`
 * and we have to decide whether to trust it. Every call site here is a point where a wrong
 * value becomes possible, so the check is made once and loudly rather than assumed.
 */
export const asTrustedId = <TName extends string>(value: string, label: TName): Brand<string, TName> =>
  requireNonEmpty(value, label) as Brand<string, TName>;
