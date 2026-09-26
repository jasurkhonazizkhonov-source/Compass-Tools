// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";
import { SystemReadinessBanner } from "../system-readiness-banner";

// Both conditions fail closed silently, so an Admin is told plainly (and only
// an Admin) when customers genuinely cannot finish a booking — because the card
// vault's production guard is closed or its key is missing/invalid — or when
// signer IPs are not recorded. The message mirrors exactly what "Finish
// Booking" will do, and disappears only when storage really is available.

const KEYS = ["APP_ENV", "TRUSTED_PROXY", "CARD_ENCRYPTION_KEY", "CARD_ENCRYPTION_KEYS", "CARD_ENCRYPTION_KEY_ID", "CARD_VAULT_MODE", "VERCEL", "VERCEL_ENV"];
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const GOOD_KEY = Buffer.alloc(32, 7).toString("base64");
afterEach(() => {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const reset = () => KEYS.forEach((k) => delete process.env[k]);

describe("SystemReadinessBanner", () => {
  it("tells an Admin when customers cannot complete bookings (production guard closed) and when signer IPs are not recorded", () => {
    reset();
    process.env.APP_ENV = "production";
    process.env.CARD_ENCRYPTION_KEY = GOOD_KEY;
    render(<SystemReadinessBanner role="ADMIN" />);
    expect(screen.getByText(/customers cannot complete bookings/i)).toBeInTheDocument();
    expect(screen.getByText(/production-class environment and the card vault has not been explicitly enabled/i)).toBeInTheDocument();
    expect(screen.getByText(/APP_ENV=staging does not enable it/i)).toBeInTheDocument();
    expect(screen.getByText(/signer ip addresses are not being recorded/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("names the real reason when the vault KEY is the problem (missing / invalid) — never the key itself", () => {
    reset();
    process.env.APP_ENV = "staging";
    process.env.TRUSTED_PROXY = "vercel";
    const { unmount } = render(<SystemReadinessBanner role="ADMIN" />);
    expect(screen.getByText(/card key ring is not configured/i)).toBeInTheDocument();
    unmount();
    process.env.CARD_ENCRYPTION_KEY = "not-a-valid-key-zzzz";
    render(<SystemReadinessBanner role="ADMIN" />);
    expect(screen.getByText(/not valid \(each key must be a base64-encoded 32-byte key\)/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("not-a-valid-key-zzzz");
  });

  it("renders nothing for a non-Admin, even when both problems exist", () => {
    reset();
    process.env.APP_ENV = "production";
    const { container } = render(<SystemReadinessBanner role="MANAGER" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when card storage is available and the proxy is configured", () => {
    reset();
    process.env.APP_ENV = "staging";
    process.env.TRUSTED_PROXY = "vercel";
    process.env.CARD_ENCRYPTION_KEY = GOOD_KEY;
    const { container } = render(<SystemReadinessBanner role="ADMIN" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only the problem that actually exists", () => {
    reset();
    process.env.APP_ENV = "staging";
    process.env.CARD_ENCRYPTION_KEY = GOOD_KEY;
    render(<SystemReadinessBanner role="ADMIN" />);
    expect(screen.queryByText(/customers cannot complete bookings/i)).not.toBeInTheDocument();
    expect(screen.getByText(/signer ip addresses are not being recorded/i)).toBeInTheDocument();
  });

  it("links to System Health", () => {
    reset();
    render(<SystemReadinessBanner role="ADMIN" />);
    expect(screen.getByRole("link", { name: /open system health/i })).toHaveAttribute("href", "/system-health");
  });
});
