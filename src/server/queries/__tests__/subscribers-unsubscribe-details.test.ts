import { describe, it, expect, vi, beforeEach } from "vitest";

// The Subscriptions list: the unsubscribe details the CRM shows, with the opaque unsubscribe token
// never selected (it is the capability behind a subscriber's own unsubscribe link and must not reach
// the page payload of any CRM user), plus the campaign context derived from existing send records.

let findManyArgs: { select?: Record<string, unknown> } | undefined;
const rows = [
  { id: "s1", email: "a@example.com", status: "UNSUBSCRIBED", source: "website", subscribedAt: new Date("2026-01-01"), unsubscribedAt: new Date("2026-10-02T12:00:00Z"), unsubscribeReasonCategory: "TOO_MANY_EMAILS", unsubscribeReason: "too many", unsubscribeSource: "EMAIL_LINK", unsubscribeRespondedAt: null },
  { id: "s2", email: "b@example.com", status: "SUBSCRIBED", source: null, subscribedAt: new Date("2026-02-01"), unsubscribedAt: null, unsubscribeReasonCategory: null, unsubscribeReason: null, unsubscribeSource: null, unsubscribeRespondedAt: null },
  { id: "s3", email: "c@example.com", status: "UNSUBSCRIBED", source: null, subscribedAt: new Date("2026-03-01"), unsubscribedAt: new Date("2026-10-02T12:00:00Z"), unsubscribeReasonCategory: null, unsubscribeReason: null, unsubscribeSource: null, unsubscribeRespondedAt: null },
];
const sends = [
  { subscriberId: "s1", sentAt: new Date("2026-10-05T00:00:00Z"), campaign: { name: "Sent AFTER they unsubscribed" } },
  { subscriberId: "s1", sentAt: new Date("2026-10-01T00:00:00Z"), campaign: { name: "Winter schedule" } },
  { subscriberId: "s1", sentAt: new Date("2026-09-01T00:00:00Z"), campaign: { name: "Older campaign" } },
];
let sendQueryIds: string[] | undefined;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscriber: {
      findMany: vi.fn(async (args: { select?: Record<string, unknown> }) => {
        findManyArgs = args;
        return rows;
      }),
      count: vi.fn(async () => rows.length),
    },
    marketingCampaignSend: {
      findMany: vi.fn(async ({ where }: { where: { subscriberId: { in: string[] } } }) => {
        sendQueryIds = where.subscriberId.in;
        return sends.filter((s) => where.subscriberId.in.includes(s.subscriberId));
      }),
    },
  },
}));

beforeEach(() => {
  findManyArgs = undefined;
  sendQueryIds = undefined;
});

describe("getSubscribers", () => {
  it("never selects the unsubscribe token — and no returned row carries one", async () => {
    const { getSubscribers } = await import("../subscribers");
    const result = await getSubscribers({ companyId: "co-1" });
    expect(findManyArgs?.select).toBeDefined();
    expect(Object.keys(findManyArgs!.select!)).not.toContain("unsubscribeToken");
    expect(JSON.stringify(result.subscribers)).not.toMatch(/unsubscribeToken/i);
  });

  it("includes the reason, source, date and responded marker for the CRM", async () => {
    const { getSubscribers } = await import("../subscribers");
    const { subscribers } = await getSubscribers({ companyId: "co-1" });
    expect(subscribers[0]).toMatchObject({ unsubscribeReasonCategory: "TOO_MANY_EMAILS", unsubscribeReason: "too many", unsubscribeSource: "EMAIL_LINK", unsubscribeRespondedAt: null });
    expect(subscribers[0].unsubscribedAt).toEqual(new Date("2026-10-02T12:00:00Z"));
  });

  it("derives the 'last campaign received' from existing send records — the most recent one BEFORE the unsubscribe, never one sent after it", async () => {
    const { getSubscribers } = await import("../subscribers");
    const { subscribers } = await getSubscribers({ companyId: "co-1" });
    expect(subscribers[0].lastCampaignName).toBe("Winter schedule");
    expect(subscribers[2].lastCampaignName).toBeNull(); // unsubscribed, nothing sent to them
    expect(subscribers[1].lastCampaignName).toBeNull(); // still subscribed: not applicable
  });

  it("looks sends up only for the unsubscribed rows on the page (one batched query)", async () => {
    const { getSubscribers } = await import("../subscribers");
    await getSubscribers({ companyId: "co-1" });
    expect(sendQueryIds).toEqual(["s1", "s3"]);
  });
});
