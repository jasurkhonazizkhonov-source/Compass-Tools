import { describe, it, expect } from "vitest";
import { normalizePhoneNumber, isValidPhoneInput, formatPhoneInternational, countryDisplayLabel, PHONE_COUNTRIES, normalizePhoneNumberWithRecovery, recoverExcelMangledNanp, phoneCountryMismatch } from "../phone";

describe("normalizePhoneNumber", () => {
  it("normalizes a US national number to E.164", () => {
    expect(normalizePhoneNumber("415 555 2671", "US")).toBe("+14155552671");
  });

  it("normalizes a UK national number to E.164", () => {
    expect(normalizePhoneNumber("20 7183 8750", "GB")).toBe("+442071838750");
  });

  it("normalizes a Germany national number to E.164", () => {
    expect(normalizePhoneNumber("030 12345678", "DE")).toBe("+493012345678");
  });

  it("normalizes an Australia national number to E.164", () => {
    expect(normalizePhoneNumber("02 9374 4000", "AU")).toBe("+61293744000");
  });

  it("normalizes an already-international number without needing a default country", () => {
    expect(normalizePhoneNumber("+1 415 555 2671")).toBe("+14155552671");
  });

  it("returns null for an invalid/too-short number", () => {
    expect(normalizePhoneNumber("123", "US")).toBeNull();
  });

  it("returns null for a national number with no country and no leading +", () => {
    expect(normalizePhoneNumber("555 2671")).toBeNull();
  });

  it("returns null for an empty or whitespace-only string", () => {
    expect(normalizePhoneNumber("")).toBeNull();
    expect(normalizePhoneNumber("   ")).toBeNull();
  });

  it("equivalent formattings of the same US number normalize to the identical E.164 string", () => {
    const a = normalizePhoneNumber("(415) 555-2671", "US");
    const b = normalizePhoneNumber("415-555-2671", "US");
    const c = normalizePhoneNumber("+1 415 555 2671");
    const d = normalizePhoneNumber("14155552671", "US");
    expect(a).toBe("+14155552671");
    expect(b).toBe("+14155552671");
    expect(c).toBe("+14155552671");
    expect(d).toBe("+14155552671");
  });
});

describe("isValidPhoneInput", () => {
  it("is true for a valid national number given its country", () => {
    expect(isValidPhoneInput("415 555 2671", "US")).toBe(true);
  });

  it("is false for an invalid number", () => {
    expect(isValidPhoneInput("123", "US")).toBe(false);
  });

  it("is false when no country is given and the number isn't in international form", () => {
    expect(isValidPhoneInput("555 2671")).toBe(false);
  });
});

describe("formatPhoneInternational", () => {
  it("formats a stored E.164 number for display", () => {
    expect(formatPhoneInternational("+14155552671")).toBe("+1 415 555 2671");
  });

  it("falls back to the raw string if it can't be parsed", () => {
    expect(formatPhoneInternational("not-a-number")).toBe("not-a-number");
  });
});

describe("recoverExcelMangledNanp / normalizePhoneNumberWithRecovery (Part 10)", () => {
  it("recovers a full NANP number missing its leading '+' (the exact reported shape: '1 415 325 8565')", () => {
    expect(recoverExcelMangledNanp("1 415 325 8565")).toBe("+14153258565");
    expect(normalizePhoneNumberWithRecovery("1 415 325 8565")).toBe("+14153258565");
  });

  it("an already-'+'-prefixed number needs no recovery and normalizes directly", () => {
    expect(normalizePhoneNumberWithRecovery("+1 415 325 8565")).toBe("+14153258565");
  });

  it("does not touch a number that already starts with '+' (never double-recovers)", () => {
    expect(recoverExcelMangledNanp("+14153258565")).toBeNull();
  });

  it("never blindly prepends '+' to an ambiguous short national number — a bare 7-digit string is left unrecovered rather than guessed", () => {
    expect(recoverExcelMangledNanp("3258565")).toBeNull();
    expect(normalizePhoneNumberWithRecovery("3258565")).toBeNull();
  });

  it("never blindly prepends '+' to a 9- or 10-digit number starting with 1 — only the exact unambiguous 11-digit NANP shape is recovered", () => {
    expect(recoverExcelMangledNanp("1234567890")).toBeNull(); // 10 digits
    expect(recoverExcelMangledNanp("123456789")).toBeNull(); // 9 digits
  });
});

describe("phoneCountryMismatch (Pass 6)", () => {
  it("flags a UK number entered while the US country selector is still active", () => {
    expect(phoneCountryMismatch("+44 20 7183 8750", "US")).toBe(true);
  });

  it("does not flag a number whose embedded calling code matches the selected country", () => {
    expect(phoneCountryMismatch("+1 415 555 2671", "US")).toBe(false);
  });

  it("does not flag a national-format number with no embedded '+' — nothing to compare against", () => {
    expect(phoneCountryMismatch("415 555 2671", "US")).toBe(false);
  });

  it("does not false-positive across countries sharing the same NANP +1 calling code (US vs Canada)", () => {
    expect(phoneCountryMismatch("+1 416 555 0199", "US")).toBe(false); // Canadian area code, still +1
    expect(phoneCountryMismatch("+1 415 555 2671", "CA")).toBe(false);
  });

  it("returns false (does not block) for something that doesn't even parse as a phone number", () => {
    expect(phoneCountryMismatch("+not-a-number", "US")).toBe(false);
  });
});

describe("countryDisplayLabel / PHONE_COUNTRIES", () => {
  it("includes the full country list, not a hand-picked subset", () => {
    expect(PHONE_COUNTRIES.length).toBeGreaterThan(200);
    expect(PHONE_COUNTRIES).toContain("US");
    expect(PHONE_COUNTRIES).toContain("DE");
  });

  it("builds a human-readable 'Name (+code)' label from live data, not a hardcoded map", () => {
    expect(countryDisplayLabel("US")).toBe("United States (+1)");
    expect(countryDisplayLabel("GB")).toBe("United Kingdom (+44)");
  });
});
