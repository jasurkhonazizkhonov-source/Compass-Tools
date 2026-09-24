import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Real bug found and fixed: the session-lookup query inside src/proxy.ts —
// which gates EVERY single protected CRM route, running before any page or
// React error boundary exists — had no error handling at all. A transient
// database hiccup there (a dropped connection, a brief network blip to the
// external Postgres host) threw uncaught straight out of the proxy for an
// otherwise completely healthy, signed-in user on a request to a totally
// unrelated page — a strong candidate for the intermittent "This page
// couldn't load / A server error occurred" reports, since it could happen
// on ANY protected route for ANY signed-in user. These tests prove the
// lookup now fails CLOSED (redirects to /login, exactly like every other
// "can't verify this session" case already does) rather than throwing, and
// that the failure is logged with a safe, non-sensitive category tag.

const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { account: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRequest(pathname: string, cookieValue?: string) {
  const init = cookieValue ? { headers: { cookie: `compass_dev_account=${cookieValue}` } } : undefined;
  return new NextRequest(`http://localhost:3000${pathname}`, init);
}

describe("proxy — session-lookup database failure", () => {
  it("a database error during the session lookup fails CLOSED — redirects to /login rather than throwing uncaught", async () => {
    findUnique.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const { proxy } = await import("../proxy");

    const response = await proxy(makeRequest("/dashboard", "some-valid-looking-token"));

    expect(response.headers.get("location")).toContain("/login");
  });

  it("logs a safe, greppable category — never the raw error message (which could embed connection details)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    findUnique.mockRejectedValue(new Error("postgresql://user:s3cret@host:5432/db unreachable"));
    const { proxy } = await import("../proxy");

    await proxy(makeRequest("/dashboard", "some-valid-looking-token"));

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("SESSION_LOOKUP_FAILED");
    expect(logged).not.toContain("s3cret");
    errorSpy.mockRestore();
  });

  it("does not fail closed for a request with no session cookie at all (unrelated pre-existing path, unchanged)", async () => {
    const { proxy } = await import("../proxy");
    const response = await proxy(makeRequest("/dashboard"));

    expect(findUnique).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toContain("/login");
  });

  it("a normal, successful lookup still allows the request through (no regression on the happy path)", async () => {
    findUnique.mockResolvedValue({ status: "ACTIVE", role: "ADMIN", sessionCreatedAt: new Date() });
    const { proxy } = await import("../proxy");

    const response = await proxy(makeRequest("/dashboard", "some-valid-looking-token"));

    expect(response.headers.get("location")).toBeNull();
  });
});

// The public marketing homepage / CRM Inquiry admin-only route pass added
// the new public website (Part 3) and removed "/" from the proxy matcher
// so it could be served publicly. These tests guard both halves of that
// change: a non-Admin still can't reach the Admin-only inquiry list by
// typing the URL directly (server-enforced, not just hidden from nav —
// canViewGetInTouch is also checked again at the page level, see
// src/app/(crm)/get-in-touch/page.tsx), and "/" staying out of the
// matcher is a deliberate, documented choice rather than an accidental gap.
describe("proxy — CRM Inquiry (/get-in-touch) is Admin-only", () => {
  it("a signed-in non-Admin (e.g. Travel Agent) hitting /get-in-touch directly is redirected away, not shown the inquiry list", async () => {
    findUnique.mockResolvedValue({ status: "ACTIVE", role: "TRAVEL_AGENT", sessionCreatedAt: new Date() });
    const { proxy } = await import("../proxy");

    const response = await proxy(makeRequest("/get-in-touch", "some-valid-looking-token"));

    expect(response.headers.get("location")).not.toContain("/get-in-touch");
  });

  it("a signed-in Admin hitting /get-in-touch is let through", async () => {
    findUnique.mockResolvedValue({ status: "ACTIVE", role: "ADMIN", sessionCreatedAt: new Date() });
    const { proxy } = await import("../proxy");

    const response = await proxy(makeRequest("/get-in-touch", "some-valid-looking-token"));

    expect(response.headers.get("location")).toBeNull();
  });
});

describe("proxy — matcher config", () => {
  it("does not list \"/\" — the public marketing homepage manages its own auth check and must not be redirected to /login", async () => {
    const { config } = await import("../proxy");

    expect(config.matcher).not.toContain("/");
    expect(config.matcher).toContain("/get-in-touch/:path*");
  });
});
