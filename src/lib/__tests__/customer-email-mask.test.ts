import { describe, it, expect } from "vitest";
import { DAILY_EMAIL_REVEAL_LIMIT, maskCustomerEmail, maskEmailsInText } from "../customer-email-mask";

describe("maskCustomerEmail", () => {
  it("keeps the first and last character of the local part and the whole domain", () => {
    expect(maskCustomerEmail("john.smith@gmail.com")).toBe("j********h@gmail.com");
    expect(maskCustomerEmail("sarah@example.com")).toBe("s***h@example.com");
    expect(maskCustomerEmail("abc@x.io")).toBe("a*c@x.io");
  });

  it("never reveals a whole short local part", () => {
    expect(maskCustomerEmail("ab@example.com")).toBe("a*@example.com");
    expect(maskCustomerEmail("a@example.com")).toBe("*@example.com");
  });

  it("caps the asterisks so the masked form does not leak the local part's length", () => {
    const masked = maskCustomerEmail(`${"a".repeat(60)}@example.com`);
    expect(masked).toBe(`a${"*".repeat(12)}a@example.com`);
  });

  it("splits at the LAST @, so a quoted local part cannot smuggle the domain", () => {
    expect(maskCustomerEmail('"a@b"@example.com')).toBe('"***"@example.com');
  });

  it("returns a fully masked fallback for anything that is not a plausible address - never the input", () => {
    for (const bad of ["not-an-email", "@nodomain.com", "nolocal@", "@"]) {
      expect(maskCustomerEmail(bad)).toBe("********");
    }
  });

  it("handles empty, null, undefined and non-string input without throwing", () => {
    expect(maskCustomerEmail("")).toBe("");
    expect(maskCustomerEmail("   ")).toBe("");
    expect(maskCustomerEmail(null)).toBe("");
    expect(maskCustomerEmail(undefined)).toBe("");
    expect(maskCustomerEmail(42 as never)).toBe("");
  });

  it("trims surrounding whitespace and handles unicode local parts by code point", () => {
    expect(maskCustomerEmail("  anna@example.com ")).toBe("a**a@example.com");
    expect(maskCustomerEmail("ёжик@пример.рф")).toBe("ё**к@пример.рф");
    expect(maskCustomerEmail("😀bc😀@example.com")).toBe("😀**😀@example.com");
  });

  it("never contains the hidden middle of the address", () => {
    const masked = maskCustomerEmail("confidential.person@example.com");
    expect(masked).not.toContain("onfidential");
    expect(masked.endsWith("@example.com")).toBe(true);
  });
});

describe("maskEmailsInText", () => {
  it("masks every address embedded in free text and leaves the rest alone", () => {
    expect(maskEmailsInText("Primary email updated to john.smith@gmail.com")).toBe("Primary email updated to j********h@gmail.com");
    expect(maskEmailsInText("Sent to a.b@x.com, c.d@y.org")).toBe("Sent to a*b@x.com, c*d@y.org");
    expect(maskEmailsInText("no address here")).toBe("no address here");
  });
  it("is safe for null and undefined", () => {
    expect(maskEmailsInText(null)).toBe("");
    expect(maskEmailsInText(undefined)).toBe("");
  });
});

describe("allowance constant", () => {
  it("is five per business day", () => {
    expect(DAILY_EMAIL_REVEAL_LIMIT).toBe(5);
  });
});
