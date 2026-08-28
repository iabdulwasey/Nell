import { describe, expect, it } from "vitest";
import { isE164, maskPhoneNumber, normalizePhoneNumber, supportedRegions } from "./phone.js";

describe("normalizePhoneNumber", () => {
  it("accepts and cleans E.164 input", () => {
    expect(normalizePhoneNumber("+14155550123")).toBe("+14155550123");
    expect(normalizePhoneNumber("+1 (415) 555-0123")).toBe("+14155550123");
    expect(normalizePhoneNumber("  +44 7911 123456 ")).toBe("+447911123456");
  });

  it("handles the 00 international prefix", () => {
    expect(normalizePhoneNumber("00447911123456")).toBe("+447911123456");
  });

  // The bug this module exists to prevent: assuming +1 would turn a UK number
  // into a different, possibly real, US number.
  it("refuses an ambiguous national number with no region", () => {
    expect(normalizePhoneNumber("07911123456")).toBeUndefined();
    expect(normalizePhoneNumber("4155550123")).toBeUndefined();
  });

  it("normalizes national numbers when the region is known", () => {
    expect(normalizePhoneNumber("07911123456", "GB")).toBe("+447911123456");
    expect(normalizePhoneNumber("(415) 555-0123", "US")).toBe("+14155550123");
    expect(normalizePhoneNumber("09876543210", "IN")).toBe("+919876543210");
    expect(normalizePhoneNumber("0412345678", "AU")).toBe("+61412345678");
  });

  it("only strips a trunk prefix where the region actually uses one", () => {
    // GB uses a trunk 0, so it is dropped.
    expect(normalizePhoneNumber("07911123456", "GB")).toBe("+447911123456");
    // US does not, so the digits are preserved rather than silently rewritten.
    // (This is format-level normalization; see the module header — validating
    // against national numbering plans needs libphonenumber-style data.)
    expect(normalizePhoneNumber("0415555012", "US")).toBe("+10415555012");
  });

  it("is case-insensitive about the region", () => {
    expect(normalizePhoneNumber("07911123456", "gb")).toBe("+447911123456");
  });

  it("rejects unknown regions rather than guessing", () => {
    expect(normalizePhoneNumber("12345678", "ZZ")).toBeUndefined();
  });

  it("rejects malformed and out-of-range input", () => {
    expect(normalizePhoneNumber("")).toBeUndefined();
    expect(normalizePhoneNumber("   ")).toBeUndefined();
    expect(normalizePhoneNumber("not a number")).toBeUndefined();
    expect(normalizePhoneNumber("+0123456789")).toBeUndefined(); // country code cannot start with 0
    expect(normalizePhoneNumber("+123")).toBeUndefined(); // too short
    expect(normalizePhoneNumber(`+${"9".repeat(16)}`)).toBeUndefined(); // too long
  });

  it("is idempotent", () => {
    const once = normalizePhoneNumber("07911123456", "GB");
    expect(normalizePhoneNumber(once ?? "")).toBe(once);
  });
});

describe("isE164", () => {
  it("validates the canonical form", () => {
    expect(isE164("+14155550123")).toBe(true);
    expect(isE164("14155550123")).toBe(false);
    expect(isE164("+1-415-555-0123")).toBe(false);
  });
});

describe("maskPhoneNumber", () => {
  it("shows only the last four digits", () => {
    expect(maskPhoneNumber("+14155550123")).toBe("••• ••• 0123");
    expect(maskPhoneNumber("+14155550123")).not.toContain("415555");
  });

  it("degrades safely on short input", () => {
    expect(maskPhoneNumber("+12")).toBe("••••");
  });
});

describe("supportedRegions", () => {
  it("covers more than North America", () => {
    const regions = supportedRegions();
    for (const region of ["US", "GB", "IN", "AU", "DE", "BR", "NG"]) {
      expect(regions).toContain(region);
    }
  });
});
