import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { getPaymentProviderStatus, getPaymentProvider, getPaymentClientConfig, isPaymentReady, setPaymentProviderForTests } from "../provider";
import { FakePaymentProvider } from "@/test/fake-payment-provider";

// Readiness must reflect reality: a provider is ready only when one is SELECTED,
// its adapter exists, and every credential is present and well-formed. An
// environment variable that merely exists is not "configured".

const SK_TEST = "sk_test_" + "a".repeat(24);
const PK_TEST = "pk_test_" + "b".repeat(24);
const SK_LIVE = "sk_live_" + "c".repeat(24);
const PK_LIVE = "pk_live_" + "d".repeat(24);
const WH = "whsec_" + "e".repeat(24);

afterEach(() => setPaymentProviderForTests(null));

describe("getPaymentProviderStatus", () => {
  it("nothing configured => not ready, and names what is missing", () => {
    expect(getPaymentProviderStatus({})).toMatchObject({ state: "not_configured", provider: null, missing: ["PAYMENT_PROVIDER"] });
    expect(isPaymentReady({})).toBe(false);
  });

  it("PAYMENT_PROVIDER=none is the same as unset", () => {
    expect(getPaymentProviderStatus({ PAYMENT_PROVIDER: "none" }).state).toBe("not_configured");
  });

  it("selecting a provider that has no adapter is NOT ready", () => {
    const s = getPaymentProviderStatus({ PAYMENT_PROVIDER: "adyen", ADYEN_API_KEY: "whatever" });
    expect(s.state).toBe("not_configured");
    expect(s.missing.join(" ")).toContain("adapter");
  });

  it("stripe selected but keys missing => not ready, listing exactly which are missing", () => {
    const s = getPaymentProviderStatus({ PAYMENT_PROVIDER: "stripe" });
    expect(s).toMatchObject({ state: "not_configured", provider: "stripe" });
    expect(s.missing).toEqual(["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"]);
  });

  it("well-formed test keys => ready in test mode", () => {
    expect(getPaymentProviderStatus({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: SK_TEST, STRIPE_PUBLISHABLE_KEY: PK_TEST })).toMatchObject({ state: "ready", mode: "test", webhookConfigured: false });
  });

  it("well-formed live keys + webhook secret => ready in live mode with webhooks configured", () => {
    expect(getPaymentProviderStatus({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: SK_LIVE, STRIPE_PUBLISHABLE_KEY: PK_LIVE, STRIPE_WEBHOOK_SECRET: WH })).toMatchObject({ state: "ready", mode: "live", webhookConfigured: true });
  });

  it("a test secret with a live publishable key (or the reverse) is INVALID, never ready — test and live cannot be confused", () => {
    expect(getPaymentProviderStatus({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: SK_TEST, STRIPE_PUBLISHABLE_KEY: PK_LIVE }).state).toBe("invalid");
    expect(getPaymentProviderStatus({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: SK_LIVE, STRIPE_PUBLISHABLE_KEY: PK_TEST }).state).toBe("invalid");
  });

  it("malformed keys are invalid (a publishable key pasted where the secret goes, junk, wrong prefix)", () => {
    expect(getPaymentProviderStatus({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: PK_TEST, STRIPE_PUBLISHABLE_KEY: PK_TEST })).toMatchObject({ state: "invalid", invalid: ["STRIPE_SECRET_KEY"] });
    expect(getPaymentProviderStatus({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "not-a-key", STRIPE_PUBLISHABLE_KEY: PK_TEST }).state).toBe("invalid");
    expect(getPaymentProviderStatus({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: SK_TEST, STRIPE_PUBLISHABLE_KEY: PK_TEST, STRIPE_WEBHOOK_SECRET: "nope" }).invalid).toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("whitespace around values and provider name is tolerated", () => {
    expect(getPaymentProviderStatus({ PAYMENT_PROVIDER: "  Stripe ", STRIPE_SECRET_KEY: ` ${SK_TEST}\n`, STRIPE_PUBLISHABLE_KEY: PK_TEST }).state).toBe("ready");
  });

  it("never returns any credential value in the status", () => {
    const json = JSON.stringify(getPaymentProviderStatus({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: SK_LIVE, STRIPE_PUBLISHABLE_KEY: PK_TEST, STRIPE_WEBHOOK_SECRET: WH }));
    for (const secret of [SK_LIVE, PK_TEST, WH]) expect(json).not.toContain(secret);
  });
});

describe("getPaymentProvider / getPaymentClientConfig", () => {
  it("no adapter until ready", () => {
    expect(getPaymentProvider({})).toBeNull();
    expect(getPaymentProvider({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: SK_TEST })).toBeNull();
  });

  it("a ready environment yields an adapter, and the client config exposes ONLY the publishable key", () => {
    const env = { PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: SK_LIVE, STRIPE_PUBLISHABLE_KEY: PK_LIVE, STRIPE_WEBHOOK_SECRET: WH };
    expect(getPaymentProvider(env)?.id).toBe("stripe");
    const cfg = getPaymentClientConfig(env);
    expect(cfg).toEqual({ ready: true, provider: "stripe", mode: "live", publishableKey: PK_LIVE });
    const json = JSON.stringify(cfg);
    expect(json).not.toContain(SK_LIVE);
    expect(json).not.toContain(WH);
  });

  it("not ready => the client config is just { ready: false } — nothing to leak", () => {
    expect(getPaymentClientConfig({})).toEqual({ ready: false });
  });

  it("the test override makes a fake provider ready, and refuses to work in production", () => {
    setPaymentProviderForTests(new FakePaymentProvider());
    expect(isPaymentReady({})).toBe(true);
    const saved = process.env.NODE_ENV;
    // @ts-expect-error NODE_ENV is readonly in typings; this is a test of the guard
    process.env.NODE_ENV = "production";
    try {
      expect(() => setPaymentProviderForTests(null)).toThrow(/not available in production/);
    } finally {
      // @ts-expect-error restore
      process.env.NODE_ENV = saved;
    }
  });
});

describe("the adapter contract itself", () => {
  it("no method signature accepts a raw card number, security code or PIN — tokens and metadata only", () => {
    const source = readFileSync(path.join(__dirname, "..", "types.ts"), "utf-8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n");
    expect(code).not.toMatch(/cardNumber|card_number|\bpan\b|cvv|cvc|\bcid\b|securityCode|\bpin\b|track2|trackData/i);
  });
});
