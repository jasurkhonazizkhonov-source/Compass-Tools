import { describe, it, expect } from "vitest";
import { isDisposableEmail, normalizeEmail } from "../email-quality";

describe("isDisposableEmail", () => {
  it("flags dedicated throwaway-inbox services, case- and whitespace-insensitively", () => {
    expect(isDisposableEmail("someone@mailinator.com")).toBe(true);
    expect(isDisposableEmail("  Someone@MAILINATOR.COM ")).toBe(true);
    expect(isDisposableEmail("x@yopmail.com")).toBe(true);
  });

  it("flags subdomains of a throwaway service", () => {
    expect(isDisposableEmail("x@inbox.mailinator.com")).toBe(true);
  });

  it("never flags mainstream providers, business, regional or uncommon-TLD domains", () => {
    for (const e of [
      "a@gmail.com",
      "a@outlook.com",
      "a@yahoo.com",
      "a@icloud.com",
      "a@proton.me",
      "a@hotmail.co.uk",
      "a@businessflights.travel",
      "a@acme-corp.co.za",
      "a@my-mailinator.com",
      "a@notmailinator.com",
      "a@mailinator.com.au.example.org",
      "a@travel.agency",
    ]) {
      expect(isDisposableEmail(e), e).toBe(false);
    }
  });

  it("returns false for input without an @", () => {
    expect(isDisposableEmail("mailinator.com")).toBe(false);
  });

  it("normalizeEmail trims and lowercases", () => {
    expect(normalizeEmail("  A@B.Com ")).toBe("a@b.com");
  });
});
