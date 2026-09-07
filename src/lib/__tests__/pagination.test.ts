import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 7 §32/§33 — redirectToValidPageIfNeeded is the "recover to the
// nearest valid page" guard every paginated CRM list page calls after its
// own query resolves pageCount. Mocking next/navigation's redirect() lets
// these tests assert exactly what URL it would navigate to, without
// actually needing a Next.js request/render context.

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("redirectToValidPageIfNeeded", () => {
  it("does nothing when the page is within range", async () => {
    const { redirectToValidPageIfNeeded } = await import("../pagination");
    expect(() => redirectToValidPageIfNeeded({}, "/contacts", 2, 5)).not.toThrow();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does nothing when the page is exactly the last page", async () => {
    const { redirectToValidPageIfNeeded } = await import("../pagination");
    expect(() => redirectToValidPageIfNeeded({}, "/contacts", 5, 5)).not.toThrow();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("redirects to the last valid page when the requested page is too high", async () => {
    const { redirectToValidPageIfNeeded } = await import("../pagination");
    expect(() => redirectToValidPageIfNeeded({}, "/contacts", 50, 5)).toThrow("REDIRECT:/contacts?page=5");
  });

  it("omits the page param entirely when the corrected page is 1 (matches PaginationControls' own convention)", async () => {
    const { redirectToValidPageIfNeeded } = await import("../pagination");
    expect(() => redirectToValidPageIfNeeded({}, "/sequences", 9, 1)).toThrow("REDIRECT:/sequences");
  });

  it("preserves every other search param, correcting only the page param", async () => {
    const { redirectToValidPageIfNeeded } = await import("../pagination");
    expect(() =>
      redirectToValidPageIfNeeded({ q: "john", status: "NEW", page: "99" }, "/leads", 99, 4)
    ).toThrow(/REDIRECT:\/leads\?/);
    const call = vi.mocked(redirect).mock.calls[0][0];
    const url = new URL(call, "http://x");
    expect(url.searchParams.get("q")).toBe("john");
    expect(url.searchParams.get("status")).toBe("NEW");
    expect(url.searchParams.get("page")).toBe("4");
  });

  it("uses a custom pageParam when given, and never touches an unrelated page param on the same route", async () => {
    const { redirectToValidPageIfNeeded } = await import("../pagination");
    expect(() =>
      redirectToValidPageIfNeeded({ campaignsPage: "3", subscribersPage: "50" }, "/subscriptions", 50, 2, "subscribersPage")
    ).toThrow(/REDIRECT:\/subscriptions\?/);
    const call = vi.mocked(redirect).mock.calls[0][0];
    const url = new URL(call, "http://x");
    expect(url.searchParams.get("campaignsPage")).toBe("3"); // untouched
    expect(url.searchParams.get("subscribersPage")).toBe("2"); // corrected
  });
});

// Pass 12 §28/§30 — the one shared server-side page-size validator every
// paginated query in the app now calls. A strict allow-list, not a
// min/max clamp: only exactly 25/50/75/100 are ever accepted.
describe("resolvePageSize", () => {
  it.each([25, 50, 75, 100])("accepts %i verbatim", async (size) => {
    const { resolvePageSize } = await import("../pagination");
    expect(resolvePageSize(size)).toBe(size);
  });

  it("falls back to 25 for undefined (the default, most common call shape)", async () => {
    const { resolvePageSize } = await import("../pagination");
    expect(resolvePageSize(undefined)).toBe(25);
  });

  it("falls back to 25 for a value not on the allow-list (e.g. 40, 60, 10) — never clamps to the nearest option", async () => {
    const { resolvePageSize } = await import("../pagination");
    expect(resolvePageSize(40)).toBe(25);
    expect(resolvePageSize(60)).toBe(25);
    expect(resolvePageSize(10)).toBe(25);
  });

  it("falls back to 25 for an absurdly large requested value — never lets a caller force-fetch an unbounded number of rows", async () => {
    const { resolvePageSize } = await import("../pagination");
    expect(resolvePageSize(10000)).toBe(25);
    expect(resolvePageSize(Number.MAX_SAFE_INTEGER)).toBe(25);
  });

  it("falls back to 25 for negative, zero, or a fractional value that truncates to an unlisted number", async () => {
    const { resolvePageSize } = await import("../pagination");
    expect(resolvePageSize(-25)).toBe(25);
    expect(resolvePageSize(0)).toBe(25);
    expect(resolvePageSize(40.5)).toBe(25); // truncates to 40, not on the allow-list
  });

  it("truncates a fractional value before checking the allow-list (50.9 -> 50, a valid option)", async () => {
    const { resolvePageSize } = await import("../pagination");
    expect(resolvePageSize(50.9)).toBe(50);
  });

  it("accepts a string numeric value (URL search params arrive as strings)", async () => {
    const { resolvePageSize } = await import("../pagination");
    expect(resolvePageSize("75")).toBe(75);
    expect(resolvePageSize("not-a-number")).toBe(25);
  });
});
