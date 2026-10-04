import { describe, expect, test } from "bun:test";
import { ValidationFailedError } from "./errors";
import { asTrustedId, toCountryCode, toOrderId, toShopDomain, toSku, toWarehouseId } from "./identifiers";

describe("identifier factories", () => {
  test("trim, and reject values that would corrupt a key column", () => {
    // `as string` throughout: a brand is not comparable to a string literal, which is the
    // type system doing its job. Reading the value back as a plain string is the honest way
    // to assert on it.
    expect(toOrderId("  ord_1 ") as string).toBe("ord_1");
    expect(() => toOrderId("")).toThrow(ValidationFailedError);
    expect(() => toOrderId("   ")).toThrow("must not be empty");
  });

  test("two different brands are not interchangeable even though both are strings at runtime", () => {
    // The runtime values are indistinguishable -- that is the point. The difference only
    // exists in the type system, which is what stops `allocate(order, warehouse)` from
    // compiling with the arguments reversed.
    const order = toOrderId("ord_1");
    const warehouse = toWarehouseId("ord_1");

    expect(order as string).toBe(warehouse as string);
    // @ts-expect-error OrderId is not assignable to WarehouseId, even with identical runtime values.
    const swapped: typeof warehouse = order;
    expect(swapped as string).toBe(order as string);
  });
});

describe("toSku normalises so equivalent spellings are one product", () => {
  test("casing and padding collapse to a single canonical form", () => {
    const canonical = toSku("KNT-TEE-BLK-M") as string;

    expect(toSku("knt-tee-blk-m") as string).toBe(canonical);
    expect(toSku("  KNT-TEE-BLK-M  ") as string).toBe(canonical);
    expect(toSku("knt tee blk m") as string).toBe(canonical);
  });

  test("without normalisation a shelf stocked as KNT-TEE reads as a stock-out", () => {
    // This is the bug the normalisation prevents: same product, two different keys, and the
    // routing engine concludes there is no stock anywhere.
    expect((toSku("KNT-TEE") as string) === (toSku("knt-tee") as string)).toBe(true);
  });

  test("rejects an empty sku and one too long to index comfortably", () => {
    expect(() => toSku("   ")).toThrow("must not be empty");
    expect(() => toSku("X".repeat(65))).toThrow("64 characters or fewer");
  });
});

describe("toShopDomain", () => {
  test("lowercases so a shop cannot appear twice under different casing", () => {
    expect(toShopDomain("  Kinetous-Test.MyShopify.com ") as string).toBe("kinetous-test.myshopify.com");
  });

  test("rejects anything that is not a plausible hostname", () => {
    for (const bad of ["myshopify", ".myshopify.com", "myshopify.com.", "a..b.com"]) {
      expect(() => toShopDomain(bad)).toThrow(ValidationFailedError);
    }
  });
});

describe("toCountryCode", () => {
  test("uppercases to ISO 3166-1 alpha-2 so routing can group on it", () => {
    expect(toCountryCode(" de ") as string).toBe("DE");
  });

  test("rejects a well-formed but unassigned code", () => {
    // "ZZ" passes any shape check, and it is the reason this function consults the real
    // list: country is what the routing engine groups warehouses by, so an unassigned code
    // yields an order that can never route and therefore a permanent silent exception.
    expect(() => toCountryCode("ZZ")).toThrow("not an assigned ISO 3166-1 code");
    expect(() => toCountryCode("XX")).toThrow(ValidationFailedError);
  });

  test("rejects wrong shapes with a different message, since that is a different fault", () => {
    expect(() => toCountryCode("DEU")).toThrow("2-letter");
    for (const bad of ["D", "1", "", "  ", "D3"]) {
      expect(() => toCountryCode(bad)).toThrow(ValidationFailedError);
    }
  });

  test("accepts a broad sample of real codes, not just the obvious ones", () => {
    for (const code of ["US", "CA", "GB", "DE", "JP", "AU", "SG", "IE", "ZA", "BR", "IN", "NZ", "MT", "EE"]) {
      expect(toCountryCode(code) as string).toBe(code);
    }
  });
});

describe("asTrustedId is the read side of the brand", () => {
  test("re-brands a value that came from the database, a webhook, or JSON", () => {
    // Every one of those hands us a bare `string`, and we have to decide whether to trust
    // it. This is that decision, made once and loudly rather than cast away at forty call
    // sites. It deliberately re-checks for emptiness instead of asserting blindly: a null
    // column that becomes `""` is exactly the sort of thing a bare cast would wave through.
    expect(asTrustedId("ord_42", "OrderId") as string).toBe("ord_42");
    expect(() => asTrustedId("", "OrderId")).toThrow("must not be empty");
    expect(() => asTrustedId("   ", "OrderId")).toThrow(ValidationFailedError);
  });

  test("is the one place a brand is widened by name, so it is auditable", () => {
    // Reading a row back is the only legitimate way in. Having exactly one such function
    // means "how did this string become an OrderId?" has a single answer.
    expect(asTrustedId(toOrderId("ord_1") as string, "OrderId") as string).toBe("ord_1");
  });
});
