import { describe, it, expect, vi, beforeEach } from "vitest";

// The failed sign-in page is Administrator-only at the page itself (in addition to proxy.ts and every action): anyone else gets a 404 BEFORE any data is read.

let actor: { id: string; role: string; companyId: string } | null;
const getPage = vi.fn(async () => ({ rows: [], total: 0, page: 1, pageSize: 25, pageCount: 1, dayTotals: {}, indicators: {} }));
class NotFound extends Error {}
vi.mock("next/navigation", () => ({ notFound: () => { throw new NotFound("NEXT_NOT_FOUND"); }, redirect: vi.fn() }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));
vi.mock("@/server/queries/failed-signins", () => ({ getFailedSignInPage: (...a: unknown[]) => (getPage as unknown as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/components/failed-signins/failed-signins-view", () => ({ FailedSignInsView: () => null }));
vi.mock("@/components/crm/pagination-controls", () => ({ PaginationControls: () => null }));
vi.mock("@/lib/pagination", () => ({ redirectToValidPageIfNeeded: vi.fn() }));

beforeEach(() => getPage.mockClear());

describe("/failed-signins page authorization", () => {
  it.each(["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"])("a %s gets not-found and no record is read", async (role) => {
    actor = { id: "u", role, companyId: "c1" };
    const { default: Page } = await import("../page");
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(NotFound);
    expect(getPage).not.toHaveBeenCalled();
  });
  it("a signed-out request gets not-found and no record is read", async () => {
    actor = null;
    const { default: Page } = await import("../page");
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(NotFound);
    expect(getPage).not.toHaveBeenCalled();
  });
  it("an Administrator reads only their own company's page of records", async () => {
    actor = { id: "a", role: "ADMIN", companyId: "c1" };
    const { default: Page } = await import("../page");
    await Page({ searchParams: Promise.resolve({ page: "2", pageSize: "50" }) });
    expect(getPage).toHaveBeenCalledWith(expect.objectContaining({ companyId: "c1", page: 2, pageSize: 50 }));
  });
});
