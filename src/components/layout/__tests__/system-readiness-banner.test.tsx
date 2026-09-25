// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";
import { SystemReadinessBanner } from "../system-readiness-banner";

// Both conditions fail closed silently, so an Admin is told plainly (and only
// an Admin) when customers genuinely cannot book, or signer IPs are not
// recorded. The "customers cannot complete bookings" message must appear
// exactly while the payment provider is not usable, and disappear only when its
// configuration is valid — it is never hidden to make a dashboard look green.

const KEYS = ["PAYMENT_PROVIDER", "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "TRUSTED_PROXY", "VERCEL", "APP_ENV"];
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const readyProvider = () => {
  process.env.PAYMENT_PROVIDER = "stripe";
  process.env.STRIPE_SECRET_KEY = "sk_test_" + "a".repeat(24);
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_" + "b".repeat(24);
};

describe("SystemReadinessBanner", () => {
  it("tells an Admin when customers cannot complete bookings (no provider) and when signer IPs are not recorded", () => {
    for (const k of KEYS) delete process.env[k];
    render(<SystemReadinessBanner role="ADMIN" />);
    expect(screen.getByText(/customers cannot complete bookings/i)).toBeInTheDocument();
    expect(screen.getByText(/signer ip addresses are not being recorded/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("names WHICH provider settings are missing (names only — never a value)", () => {
    for (const k of KEYS) delete process.env[k];
    process.env.PAYMENT_PROVIDER = "stripe";
    process.env.STRIPE_SECRET_KEY = "sk_test_" + "z".repeat(24);
    render(<SystemReadinessBanner role="ADMIN" />);
    expect(screen.getByText(/STRIPE_PUBLISHABLE_KEY \(missing\)/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("z".repeat(24));
  });

  it("flags an INVALID credential (test/live mismatch) as still blocking bookings", () => {
    for (const k of KEYS) delete process.env[k];
    process.env.PAYMENT_PROVIDER = "stripe";
    process.env.STRIPE_SECRET_KEY = "sk_test_" + "a".repeat(24);
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_" + "b".repeat(24);
    render(<SystemReadinessBanner role="ADMIN" />);
    expect(screen.getByText(/customers cannot complete bookings/i)).toBeInTheDocument();
    expect(screen.getByText(/\(invalid\)/)).toBeInTheDocument();
  });

  it("renders nothing for a non-Admin, even when both problems exist", () => {
    for (const k of KEYS) delete process.env[k];
    const { container } = render(<SystemReadinessBanner role="MANAGER" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("the bookings message is GONE once the provider is genuinely configured (and stays gone even if APP_ENV is set to anything)", () => {
    for (const k of KEYS) delete process.env[k];
    readyProvider();
    process.env.TRUSTED_PROXY = "vercel";
    process.env.APP_ENV = "production";
    const { container } = render(<SystemReadinessBanner role="ADMIN" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only the problem that actually exists", () => {
    for (const k of KEYS) delete process.env[k];
    readyProvider();
    render(<SystemReadinessBanner role="ADMIN" />);
    expect(screen.queryByText(/customers cannot complete bookings/i)).not.toBeInTheDocument();
    expect(screen.getByText(/signer ip addresses are not being recorded/i)).toBeInTheDocument();
  });

  it("links to System Health", () => {
    for (const k of KEYS) delete process.env[k];
    render(<SystemReadinessBanner role="ADMIN" />);
    expect(screen.getByRole("link", { name: /open system health/i })).toHaveAttribute("href", "/system-health");
  });
});
