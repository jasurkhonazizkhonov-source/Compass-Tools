import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { getPaymentProviderStatus, getPaymentProvider } from "../provider";

// The payment provider boundary must report the truth: with no adapter
// installed, NOTHING is "ready" — whatever an environment variable claims.

describe("getPaymentProviderStatus — honest readiness", () => {
  it("nothing configured => not ready, and says what is missing", () => {
    expect(getPaymentProviderStatus({})).toEqual({ state: "not_configured", provider: null, adapterAvailable: false, mode: null, missing: ["PAYMENT_PROVIDER"] });
  });

  it("PAYMENT_PROVIDER=none is the same as unset", () => {
    expect(getPaymentProviderStatus({ PAYMENT_PROVIDER: "none" }).state).toBe("not_configured");
  });

  it("naming a provider whose adapter does not exist in the codebase is NOT ready (an env var cannot conjure an integration)", () => {
    for (const name of ["stripe", "adyen", "braintree", "some-vault"]) {
      const status = getPaymentProviderStatus({ PAYMENT_PROVIDER: name, [`${name.toUpperCase()}_SECRET_KEY`]: "sk_test_x", PAYMENT_PROVIDER_MODE: "live" });
      expect(status.state).toBe("not_configured");
      expect(status.adapterAvailable).toBe(false);
      expect(status.missing.join(" ")).toContain("adapter");
    }
  });

  it("reports names of what is missing, never any configured value", () => {
    const status = getPaymentProviderStatus({ PAYMENT_PROVIDER: "acme", ACME_SECRET_KEY: "super-secret-value" });
    expect(JSON.stringify(status)).not.toContain("super-secret-value");
  });

  it("getPaymentProvider() is null when nothing is ready — callers cannot obtain a half-configured adapter", () => {
    expect(getPaymentProvider({})).toBeNull();
    expect(getPaymentProvider({ PAYMENT_PROVIDER: "stripe" })).toBeNull();
  });

  it("is case/whitespace tolerant", () => {
    expect(getPaymentProviderStatus({ PAYMENT_PROVIDER: "  NONE  " }).state).toBe("not_configured");
  });
});

describe("the adapter contract itself", () => {
  it("no method signature accepts a raw card number, security code or PIN — tokens and metadata only", () => {
    const source = readFileSync(path.join(__dirname, "..", "provider.ts"), "utf-8");
    // Only the interface + types region (comments excluded).
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n");
    expect(code).not.toMatch(/cardNumber|card_number|\bpan\b|cvv|cvc|\bcid\b|securityCode|\bpin\b|track2|trackData/i);
  });
});
