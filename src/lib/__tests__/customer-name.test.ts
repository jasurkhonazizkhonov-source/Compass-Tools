import { describe, it, expect } from "vitest";
import { formatCustomerFullName, customerGreeting, firstNameGreeting } from "../customer-name";

// Pass 12 §41 — every customer-facing template must safely handle
// first+last, first-only, last-only, and missing names — never
// "undefined"/"null"/a broken template variable/an empty greeting.

describe("formatCustomerFullName", () => {
  it("combines first + last", () => {
    expect(formatCustomerFullName("Larry", "Mehaffey")).toBe("Larry Mehaffey");
  });

  it("first name only", () => {
    expect(formatCustomerFullName("Larry", undefined)).toBe("Larry");
    expect(formatCustomerFullName("Larry", null)).toBe("Larry");
    expect(formatCustomerFullName("Larry", "")).toBe("Larry");
  });

  it("last name only", () => {
    expect(formatCustomerFullName(undefined, "Mehaffey")).toBe("Mehaffey");
    expect(formatCustomerFullName(null, "Mehaffey")).toBe("Mehaffey");
    expect(formatCustomerFullName("", "Mehaffey")).toBe("Mehaffey");
  });

  it("both missing returns an empty string, never 'undefined undefined'", () => {
    expect(formatCustomerFullName(undefined, undefined)).toBe("");
    expect(formatCustomerFullName(null, null)).toBe("");
    expect(formatCustomerFullName("", "")).toBe("");
  });

  it("trims whitespace-only names as if missing", () => {
    expect(formatCustomerFullName("   ", "  ")).toBe("");
    expect(formatCustomerFullName("  Larry  ", "  Mehaffey  ")).toBe("Larry Mehaffey");
  });
});

describe("customerGreeting", () => {
  it("renders 'Hello, First Last' when both are known", () => {
    expect(customerGreeting("Larry", "Mehaffey")).toBe("Hello, Larry Mehaffey");
  });

  it("degrades to first name only", () => {
    expect(customerGreeting("Larry", undefined)).toBe("Hello, Larry");
  });

  it("degrades to last name only", () => {
    expect(customerGreeting(undefined, "Mehaffey")).toBe("Hello, Mehaffey");
  });

  it("falls back to a neutral 'Hello' — never 'Hello, undefined' or a dangling comma", () => {
    expect(customerGreeting(undefined, undefined)).toBe("Hello");
    expect(customerGreeting(null, null)).toBe("Hello");
    expect(customerGreeting("", "")).toBe("Hello");
  });
});

describe("firstNameGreeting", () => {
  it("renders 'Hi {first}'", () => {
    expect(firstNameGreeting("Jane")).toBe("Hi Jane");
  });

  it("falls back to a neutral 'Hi there' when missing — never 'Hi undefined'", () => {
    expect(firstNameGreeting(undefined)).toBe("Hi there");
    expect(firstNameGreeting(null)).toBe("Hi there");
    expect(firstNameGreeting("")).toBe("Hi there");
    expect(firstNameGreeting("   ")).toBe("Hi there");
  });
});
