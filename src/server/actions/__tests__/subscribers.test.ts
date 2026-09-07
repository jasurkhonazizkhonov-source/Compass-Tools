import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 8 §2 — deleteSubscribersMatchingFilter is the server-side core of
// "select all N matching this filter": the browser never sends a list of
// every matching id, only the filter (status) plus whatever the user
// explicitly excluded. This file proves the server reconstructs the
// actual delete target itself, scoped by the caller's own companyId,
// rather than trusting any client-supplied notion of "everything matching".

type FakeAccount = { id: string; role: string; companyId: string };
type FakeSubscriber = { id: string; companyId: string; status: "SUBSCRIBED" | "UNSUBSCRIBED" };

let currentActor: FakeAccount | null;
let subscribers: Map<string, FakeSubscriber>;
let deleteManyCalls: Array<{ where: unknown }>;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscriber: {
      deleteMany: vi.fn(async ({ where }: { where: { companyId: string; status?: string; id?: { in?: string[]; notIn?: string[] } } }) => {
        deleteManyCalls.push({ where });
        let matched = [...subscribers.values()].filter((s) => s.companyId === where.companyId);
        if (where.status) matched = matched.filter((s) => s.status === where.status);
        if (where.id?.in) matched = matched.filter((s) => where.id!.in!.includes(s.id));
        if (where.id?.notIn) matched = matched.filter((s) => !where.id!.notIn!.includes(s.id));
        for (const s of matched) subscribers.delete(s.id);
        return { count: matched.length };
      }),
      count: vi.fn(async ({ where }: { where: { companyId: string; status?: string } }) => {
        let matched = [...subscribers.values()].filter((s) => s.companyId === where.companyId);
        if (where.status) matched = matched.filter((s) => s.status === where.status);
        return matched.length;
      }),
    },
  },
}));

beforeEach(() => {
  currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
  subscribers = new Map([
    ["sub-1", { id: "sub-1", companyId: "company-1", status: "SUBSCRIBED" }],
    ["sub-2", { id: "sub-2", companyId: "company-1", status: "SUBSCRIBED" }],
    ["sub-3", { id: "sub-3", companyId: "company-1", status: "UNSUBSCRIBED" }],
    ["sub-other-co", { id: "sub-other-co", companyId: "company-2", status: "SUBSCRIBED" }],
  ]);
  deleteManyCalls = [];
  vi.clearAllMocks();
});

describe("deleteSubscribersMatchingFilter — server-side reconstruction (Pass 8 §2)", () => {
  it("deletes every subscriber matching the filter, scoped to the caller's own company", async () => {
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    const result = await deleteSubscribersMatchingFilter({ status: "SUBSCRIBED" as never, excludeIds: [] });

    expect(result.deleted).toBe(2); // sub-1, sub-2 — not sub-3 (wrong status) or sub-other-co (wrong company)
    expect(subscribers.has("sub-1")).toBe(false);
    expect(subscribers.has("sub-2")).toBe(false);
    expect(subscribers.has("sub-3")).toBe(true);
  });

  it("never touches another company's subscribers even if their id happens to match the status filter", async () => {
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    await deleteSubscribersMatchingFilter({ status: "SUBSCRIBED" as never, excludeIds: [] });

    expect(subscribers.has("sub-other-co")).toBe(true); // untouched — different company
  });

  it("excludeIds shrinks the delete target — an excluded subscriber survives", async () => {
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    const result = await deleteSubscribersMatchingFilter({ status: "SUBSCRIBED" as never, excludeIds: ["sub-1"] });

    expect(result.deleted).toBe(1);
    expect(subscribers.has("sub-1")).toBe(true); // excluded — survives
    expect(subscribers.has("sub-2")).toBe(false); // still deleted
  });

  it("an excludeIds entry for a DIFFERENT company's subscriber has no effect (can't be used to protect or target another company's rows)", async () => {
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    await deleteSubscribersMatchingFilter({ status: "SUBSCRIBED" as never, excludeIds: ["sub-other-co"] });

    // sub-other-co was never in scope anyway (different company); excluding
    // it doesn't change what actually gets deleted in company-1.
    expect(subscribers.has("sub-1")).toBe(false);
    expect(subscribers.has("sub-2")).toBe(false);
  });

  it("omitting status deletes every one of the caller's company's subscribers ('All' filter)", async () => {
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    const result = await deleteSubscribersMatchingFilter({ excludeIds: [] });

    expect(result.deleted).toBe(3); // sub-1, sub-2, sub-3 — every company-1 row
    expect(subscribers.has("sub-other-co")).toBe(true);
  });

  it("the where clause the server actually sends never contains a client-supplied 'these are the ids to delete' list — only companyId, status, and exclusions", async () => {
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    await deleteSubscribersMatchingFilter({ status: "SUBSCRIBED" as never, excludeIds: ["sub-1"] });

    expect(deleteManyCalls[0].where).toEqual({
      companyId: "company-1",
      status: "SUBSCRIBED",
      id: { notIn: ["sub-1"] },
    });
  });

  it("matches nothing gracefully when the filter matches zero rows", async () => {
    subscribers.clear();
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    const result = await deleteSubscribersMatchingFilter({ status: "SUBSCRIBED" as never, excludeIds: [] });
    expect(result.deleted).toBe(0);
  });

  it("rejects a caller without subscriptions access (authorization enforced server-side, not just hidden UI)", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    await expect(deleteSubscribersMatchingFilter({ excludeIds: [] })).rejects.toThrow(/not authorized/i);
    expect(deleteManyCalls).toHaveLength(0);
    expect(subscribers.size).toBe(4); // nothing deleted
  });

  it("rejects an unauthenticated caller", async () => {
    currentActor = null;
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    await expect(deleteSubscribersMatchingFilter({ excludeIds: [] })).rejects.toThrow(/not authorized/i);
  });

  it("a MARKETING_AGENT (not just ADMIN) is authorized", async () => {
    currentActor = { id: "marketer-1", role: "MARKETING_AGENT", companyId: "company-1" };
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    await expect(deleteSubscribersMatchingFilter({ status: "UNSUBSCRIBED" as never, excludeIds: [] })).resolves.toEqual({ deleted: 1 });
  });
});

// Pass 9 §6 — adversarial input handling: the exclusion list is the ONLY
// client-supplied id data this action accepts, and it must behave safely
// (never expand the delete target, never crash) no matter what shape a
// malicious or simply buggy client sends.
describe("deleteSubscribersMatchingFilter — adversarial exclusion input (Pass 9 §6)", () => {
  it("duplicate ids in excludeIds behave the same as a single occurrence", async () => {
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    const result = await deleteSubscribersMatchingFilter({ status: "SUBSCRIBED" as never, excludeIds: ["sub-1", "sub-1", "sub-1"] });

    expect(result.deleted).toBe(1); // only sub-2 — sub-1 excluded regardless of duplicate count
    expect(subscribers.has("sub-1")).toBe(true);
  });

  it("a nonexistent id in excludeIds is harmless — it simply excludes nothing", async () => {
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    const result = await deleteSubscribersMatchingFilter({ status: "SUBSCRIBED" as never, excludeIds: ["sub-does-not-exist"] });

    expect(result.deleted).toBe(2); // sub-1 and sub-2 both still deleted
  });

  it("an empty-string id in excludeIds is harmless (never matches a real subscriber id)", async () => {
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    const result = await deleteSubscribersMatchingFilter({ status: "SUBSCRIBED" as never, excludeIds: [""] });

    expect(result.deleted).toBe(2);
  });

  it("a very large exclusion list does not crash and still only excludes real, matching ids", async () => {
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    const noise = Array.from({ length: 5000 }, (_, i) => `not-a-real-id-${i}`);
    const result = await deleteSubscribersMatchingFilter({ status: "SUBSCRIBED" as never, excludeIds: [...noise, "sub-1"] });

    expect(result.deleted).toBe(1); // sub-2 only — sub-1 legitimately excluded among the noise
    expect(subscribers.has("sub-1")).toBe(true);
  });

  it("an excludeIds entry cannot be (ab)used to target a subscriber outside the status filter — it can only ever exclude, never add", async () => {
    const { deleteSubscribersMatchingFilter } = await import("../subscribers");
    // sub-3 is UNSUBSCRIBED — including it in excludeIds while filtering on
    // SUBSCRIBED can't somehow make it get deleted; it was never in scope.
    await deleteSubscribersMatchingFilter({ status: "SUBSCRIBED" as never, excludeIds: ["sub-3"] });

    expect(subscribers.has("sub-3")).toBe(true);
  });
});

describe("deleteSubscribers — explicit id list, still company-scoped", () => {
  it("never deletes an id belonging to a different company, even if explicitly requested", async () => {
    const { deleteSubscribers } = await import("../subscribers");
    const result = await deleteSubscribers(["sub-1", "sub-other-co"]);

    expect(result.deleted).toBe(1);
    expect(subscribers.has("sub-1")).toBe(false);
    expect(subscribers.has("sub-other-co")).toBe(true);
  });

  it("is a no-op for an empty id list, never issuing a delete against the whole table", async () => {
    const { deleteSubscribers } = await import("../subscribers");
    const result = await deleteSubscribers([]);
    expect(result.deleted).toBe(0);
    expect(deleteManyCalls).toHaveLength(0);
  });
});

// Pass 9 §8 — the live-refresh count shown right before a cross-page bulk
// delete confirms. Read-only, but still authorization- and company-scoped
// the same as every other subscriber query — an unauthorized caller must
// not learn another company's subscriber counts either.
describe("getSubscriberCountForFilter — live count refresh (Pass 9 §8)", () => {
  it("returns the current company-scoped count for the given status", async () => {
    const { getSubscriberCountForFilter } = await import("../subscribers");
    await expect(getSubscriberCountForFilter("SUBSCRIBED" as never)).resolves.toBe(2);
    await expect(getSubscriberCountForFilter("UNSUBSCRIBED" as never)).resolves.toBe(1);
  });

  it("returns the company's total when no status filter is given", async () => {
    const { getSubscriberCountForFilter } = await import("../subscribers");
    await expect(getSubscriberCountForFilter()).resolves.toBe(3); // sub-1, sub-2, sub-3 — not sub-other-co
  });

  it("never counts another company's subscribers", async () => {
    const { getSubscriberCountForFilter } = await import("../subscribers");
    const total = await getSubscriberCountForFilter();
    expect(total).toBe(3); // excludes sub-other-co (company-2)
  });

  it("rejects a caller without subscriptions access", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { getSubscriberCountForFilter } = await import("../subscribers");
    await expect(getSubscriberCountForFilter()).rejects.toThrow(/not authorized/i);
  });

  it("reflects a count that has changed since an earlier read (the whole point of the refresh)", async () => {
    const { getSubscriberCountForFilter } = await import("../subscribers");
    expect(await getSubscriberCountForFilter("SUBSCRIBED" as never)).toBe(2);
    subscribers.delete("sub-1"); // simulate another user deleting one concurrently
    expect(await getSubscriberCountForFilter("SUBSCRIBED" as never)).toBe(1);
  });
});
