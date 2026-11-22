import { describe, it, expect, vi, beforeEach } from "vitest";

// Subscriber addresses follow the customer-email rule: a viewer without full-address access sees masked addresses, can find a subscriber by typing the COMPLETE
// address, never by a fragment, and "select all matching" deletes exactly what that search shows (never more).

let restricted = true;
let actor: { id: string; role: string; companyId: string; fullName?: string; email?: string; phone?: string } | null;
const findMany = vi.fn();
const count = vi.fn(async () => 0);
const deleteMany = vi.fn(async () => ({ count: 0 }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscriber: { findMany: (...a: unknown[]) => findMany(...a), count: (...a: unknown[]) => count(...(a as [])), deleteMany: (...a: unknown[]) => deleteMany(...(a as [])) },
    marketingCampaignSend: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));
vi.mock("@/server/privacy/customer-email", () => ({ getEmailViewer: vi.fn(async () => ({ restricted })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/email/crm-email", () => ({ sendCrmEmail: vi.fn() }));

import { subscriberSearchWhere } from "@/server/search/subscriber-search";
import { getSubscribers } from "@/server/queries/subscribers";
import { deleteSubscribersMatchingFilter, getSubscriberCountForFilter } from "@/server/actions/subscribers";

const ROW = { id: "s1", email: "jane.doe@example.com", status: "SUBSCRIBED", source: "x", subscribedAt: new Date(), unsubscribedAt: null, unsubscribeReasonCategory: null, unsubscribeReason: null, unsubscribeSource: null, unsubscribeRespondedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  restricted = true;
  actor = { id: "m1", role: "MARKETING_AGENT", companyId: "company-1" };
  findMany.mockResolvedValue([ROW]);
  count.mockResolvedValue(1);
});

describe("subscriberSearchWhere", () => {
  it("a blank search adds no condition", () => {
    expect(subscriberSearchWhere(undefined, true)).toEqual({});
    expect(subscriberSearchWhere("   ", false)).toEqual({});
  });
  it("a COMPLETE address is an exact, case-insensitive match for everybody", () => {
    for (const restrictedViewer of [true, false]) {
      expect(subscriberSearchWhere("  Jane.Doe@Example.com ", restrictedViewer)).toEqual({ email: { equals: "Jane.Doe@Example.com", mode: "insensitive" } });
    }
  });
  it("a fragment matches nothing for a restricted viewer (never 'everything') and by substring for a viewer who may see addresses", () => {
    expect(subscriberSearchWhere("jane", true)).toEqual({ id: { in: [] } });
    expect(subscriberSearchWhere("@example.com", true)).toEqual({ id: { in: [] } });
    expect(subscriberSearchWhere("jane", false)).toEqual({ email: { contains: "jane", mode: "insensitive" } });
  });
});

describe("getSubscribers", () => {
  it("masks every address for a restricted viewer and shows them in full otherwise", async () => {
    const masked = await getSubscribers({ companyId: "company-1", emailRestricted: true });
    expect(masked.subscribers[0].email).not.toBe("jane.doe@example.com");
    expect(masked.subscribers[0].email).toMatch(/\*\*\*/);
    expect(JSON.stringify(masked)).not.toContain("jane.doe@example.com"); // nowhere in the payload that reaches the page
    const full = await getSubscribers({ companyId: "company-1", emailRestricted: false });
    expect(full.subscribers[0].email).toBe("jane.doe@example.com");
  });
  it("applies the search to the list and to the count with the same filter, inside the company", async () => {
    await getSubscribers({ companyId: "company-1", q: "jane.doe@example.com", emailRestricted: true });
    const where = (findMany.mock.calls[0][0] as { where: unknown }).where;
    expect(where).toEqual({ companyId: "company-1", email: { equals: "jane.doe@example.com", mode: "insensitive" } });
    expect((count.mock.calls[0] as unknown[])[0]).toEqual({ where });
  });
  it("a restricted fragment search lists nothing", async () => {
    await getSubscribers({ companyId: "company-1", q: "jane", emailRestricted: true });
    expect((findMany.mock.calls[0][0] as { where: unknown }).where).toEqual({ companyId: "company-1", id: { in: [] } });
  });
});

describe("'select all matching' means exactly what the search shows", () => {
  it("the count and the delete use the same status + search + company filter, and excludeIds only ever narrows", async () => {
    restricted = false;
    await getSubscriberCountForFilter("SUBSCRIBED", "jane");
    await deleteSubscribersMatchingFilter({ status: "SUBSCRIBED", q: "jane", excludeIds: ["keep-1"] });
    const countWhere = (count.mock.calls[0] as unknown as [{ where: unknown }])[0].where;
    const deleteWhere = (deleteMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(countWhere).toEqual({ companyId: "company-1", status: "SUBSCRIBED", email: { contains: "jane", mode: "insensitive" } });
    expect(deleteWhere).toEqual({ ...(countWhere as object), id: { notIn: ["keep-1"] } });
  });
  it("a restricted viewer's FRAGMENT search deletes nothing (it matches no row) instead of everything", async () => {
    await deleteSubscribersMatchingFilter({ q: "jane", excludeIds: [] });
    expect((deleteMany.mock.calls[0] as unknown as [{ where: unknown }])[0].where).toEqual({ companyId: "company-1", id: { in: [] } });
  });
  it("a restricted viewer's COMPLETE-address search deletes exactly that subscriber's rows (the address they typed)", async () => {
    await deleteSubscribersMatchingFilter({ q: "jane.doe@example.com", excludeIds: [] });
    expect((deleteMany.mock.calls[0] as unknown as [{ where: unknown }])[0].where).toEqual({ companyId: "company-1", email: { equals: "jane.doe@example.com", mode: "insensitive" } });
  });
  it("the permission is read when the delete runs: a viewer who lost full access in the meantime cannot use a fragment any more", async () => {
    restricted = false;
    await deleteSubscribersMatchingFilter({ q: "jane", excludeIds: [] });
    restricted = true; // an administrator switched the permission off
    await deleteSubscribersMatchingFilter({ q: "jane", excludeIds: [] });
    expect((deleteMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where).toMatchObject({ email: { contains: "jane", mode: "insensitive" } });
    expect((deleteMany.mock.calls[1] as unknown as [{ where: Record<string, unknown> }])[0].where).toMatchObject({ id: { in: [] } });
  });
  it("without subscription access nothing is counted or deleted", async () => {
    actor = { id: "t1", role: "TRAVEL_AGENT", companyId: "company-1" };
    await expect(deleteSubscribersMatchingFilter({ excludeIds: [] })).rejects.toThrow();
    await expect(getSubscriberCountForFilter()).rejects.toThrow();
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
