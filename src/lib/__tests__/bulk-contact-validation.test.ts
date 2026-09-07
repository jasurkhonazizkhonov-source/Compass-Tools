import { describe, it, expect } from "vitest";
import { validateBulkContactRow } from "../bulk-contact-validation";

const VALID_ROW = {
  firstName: "John",
  lastName: "Smith",
  emails: ["john@example.com"],
  phones: ["+14155551234"],
};

describe("validateBulkContactRow — required fields", () => {
  it("accepts a fully valid row with no issues", () => {
    const result = validateBulkContactRow(VALID_ROW);
    expect(result.issues).toEqual([]);
    expect(result.normalizedEmails).toEqual(["john@example.com"]);
    expect(result.normalizedPhones).toEqual(["+14155551234"]);
  });

  it("flags a missing first name", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, firstName: "" });
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "firstName" }));
  });

  it("flags a whitespace-only first name the same as empty", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, firstName: "   " });
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "firstName" }));
  });

  it("flags a missing last name", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, lastName: "" });
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "lastName" }));
  });

  it("does not require any email or phone at all — both are optional per row", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, emails: [], phones: [] });
    expect(result.issues).toEqual([]);
  });
});

describe("validateBulkContactRow — email validation", () => {
  it("rejects an address with no @", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, emails: ["not-an-email"] });
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "email", index: 0 }));
    expect(result.normalizedEmails).toEqual([]);
  });

  it("rejects a malformed domain", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, emails: ["john@"] });
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "email" }));
  });

  it("normalizes a valid address to lowercase, trimmed", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, emails: ["  John.Smith@Example.COM  "] });
    expect(result.issues).toEqual([]);
    expect(result.normalizedEmails).toEqual(["john.smith@example.com"]);
  });

  it("accepts a modern, unusual-but-legitimate address rather than rejecting it on an overly strict pattern", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, emails: ["first.last+tag@sub.example.travel"] });
    expect(result.issues).toEqual([]);
  });

  it("silently skips a blank email cell instead of treating it as an error", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, emails: ["john@example.com", "   "] });
    expect(result.issues).toEqual([]);
    expect(result.normalizedEmails).toEqual(["john@example.com"]);
  });

  it("reports the correct index for the second of two email cells", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, emails: ["john@example.com", "bad"] });
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "email", index: 1 }));
  });
});

describe("validateBulkContactRow — international phone validation (Part 6)", () => {
  it.each([
    ["+14155551234", "US"],
    ["+442071234567", "UK"],
    ["+493012345678", "Germany"],
    ["+61212345678", "Australia"],
    ["+37410123456", "Armenia"],
  ])("accepts a valid %s number (%s)", (raw) => {
    const result = validateBulkContactRow({ ...VALID_ROW, phones: [raw] });
    expect(result.issues).toEqual([]);
    expect(result.normalizedPhones[0]).toBe(raw);
  });

  it("rejects an obviously invalid +-prefixed number", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, phones: ["+1123"] });
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "phone" }));
    expect(result.normalizedPhones).toEqual([]);
  });

  it("flags a bare national number with no country code as needing review, rather than guessing a country", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, phones: ["5551234567"] });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ field: "phone" });
    expect(result.issues[0].message).toMatch(/country/i);
    expect(result.normalizedPhones).toEqual([]);
  });

  it("silently skips a blank phone cell instead of treating it as an error", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, phones: ["+14155551234", ""] });
    expect(result.issues).toEqual([]);
    expect(result.normalizedPhones).toEqual(["+14155551234"]);
  });
});

describe("validateBulkContactRow — recovering Excel's mangled +1 (Part 7)", () => {
  it("recovers a NANP number Excel stripped the + from, with spaces", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, phones: ["1 415 555 1234"] });
    expect(result.issues).toEqual([]);
    expect(result.normalizedPhones).toEqual(["+14155551234"]);
  });

  it("recovers a NANP number Excel collapsed to plain digits", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, phones: ["14155551234"] });
    expect(result.issues).toEqual([]);
    expect(result.normalizedPhones).toEqual(["+14155551234"]);
  });

  it("does NOT blindly assume every number starting with 1 is American — a 9-digit number is still flagged", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, phones: ["123456789"] });
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "phone" }));
    expect(result.normalizedPhones).toEqual([]);
  });

  it("does NOT recover a 10-digit number starting with 1 — wrong length for NANP + country code", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, phones: ["1234567890"] });
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "phone" }));
    expect(result.normalizedPhones).toEqual([]);
  });

  it("leaves an already +-prefixed number alone — recovery only applies to a bare number", () => {
    const result = validateBulkContactRow({ ...VALID_ROW, phones: ["+1123"] });
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "phone" }));
    expect(result.normalizedPhones).toEqual([]);
  });
});
