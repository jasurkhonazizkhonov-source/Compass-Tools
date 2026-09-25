// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";
import { SystemReadinessBanner } from "../system-readiness-banner";

// The two settings customer bookings depend on both fail closed silently, so
// an Admin is told plainly (and only an Admin) when either is missing.

const original = { APP_ENV: process.env.APP_ENV, TRUSTED_PROXY: process.env.TRUSTED_PROXY };
afterEach(() => {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("SystemReadinessBanner", () => {
  it("tells an Admin when customers cannot complete bookings (production, no card vault) and when signer IPs are not recorded", () => {
    process.env.APP_ENV = "production";
    delete process.env.TRUSTED_PROXY;
    render(<SystemReadinessBanner role="ADMIN" />);

    expect(screen.getByText(/customers cannot complete bookings/i)).toBeInTheDocument();
    expect(screen.getByText(/signer ip addresses are not being recorded/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders nothing for a non-Admin, even when both problems exist", () => {
    process.env.APP_ENV = "production";
    delete process.env.TRUSTED_PROXY;
    const { container } = render(<SystemReadinessBanner role="MANAGER" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when both settings are in place", () => {
    process.env.APP_ENV = "staging";
    process.env.TRUSTED_PROXY = "vercel";
    const { container } = render(<SystemReadinessBanner role="ADMIN" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only the problem that actually exists", () => {
    process.env.APP_ENV = "staging";
    delete process.env.TRUSTED_PROXY;
    render(<SystemReadinessBanner role="ADMIN" />);
    expect(screen.queryByText(/customers cannot complete bookings/i)).not.toBeInTheDocument();
    expect(screen.getByText(/signer ip addresses are not being recorded/i)).toBeInTheDocument();
  });
});
