import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 7 §17/§18/§23/§25/§31 — the 4 CRM lists that had NO server-side
// pagination before this pass (Sequences, Get in Touch, Marketing
// Campaigns, Subscribers). Each of these must, for real: (1) compute
// skip/take correctly for the requested page, (2) get `total` from a real
// Prisma count() rather than array length, (3) hard-cap pageSize at 25
// server-side regardless of what's passed in, and (4) never return a
// pageCount below 1. A lightweight fake Prisma records the exact args each
// findMany/count call received so these can be asserted directly, rather
// than inferring correctness from the returned rows alone.

type Call = { where: unknown; skip?: number; take?: number };

function makeFakeModel(rows: unknown[], total: number) {
  const findManyCalls: Call[] = [];
  const countCalls: Array<{ where: unknown }> = [];
  return {
    findMany: vi.fn(async (args: Call) => {
      findManyCalls.push(args);
      return rows;
    }),
    count: vi.fn(async (args: { where: unknown }) => {
      countCalls.push(args);
      return total;
    }),
    findManyCalls,
    countCalls,
  };
}

// Each test sets up its own vi.doMock for @/lib/prisma with a fresh fake —
// vi.resetModules() forces the next dynamic import() to re-evaluate the
// query module against THAT test's mock rather than reusing whatever
// module instance an earlier test's import() already cached.
beforeEach(() => {
  vi.resetModules();
});

describe("getSequences — server-side pagination", () => {
  it("computes skip/take for page 3 and returns total from count(), not rows.length", async () => {
    const sequence = makeFakeModel([{ id: "s1" }], 67);
    vi.doMock("@/lib/prisma", () => ({ prisma: { sequence } }));
    vi.doMock("@/server/visibility", () => ({ sequenceVisibilityWhere: () => ({ companyId: "company-1" }) }));

    const { getSequences } = await import("../sequences");
    const result = await getSequences({ viewer: { id: "a", role: "ADMIN", companyId: "company-1" } as never, page: 3 });

    expect(sequence.findManyCalls[0].skip).toBe(50); // (3-1) * 25
    expect(sequence.findManyCalls[0].take).toBe(25);
    expect(result.total).toBe(67);
    expect(result.pageCount).toBe(3); // ceil(67/25)
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  it("hard-caps pageSize at 25 even when a caller passes a larger value (§31)", async () => {
    const sequence = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { sequence } }));
    vi.doMock("@/server/visibility", () => ({ sequenceVisibilityWhere: () => ({}) }));

    const { getSequences } = await import("../sequences");
    await getSequences({ viewer: null, pageSize: 100000, page: 1 });

    expect(sequence.findManyCalls[0].take).toBe(25);
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  it("pageCount is never below 1 for an empty result set", async () => {
    const sequence = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { sequence } }));
    vi.doMock("@/server/visibility", () => ({ sequenceVisibilityWhere: () => ({}) }));

    const { getSequences } = await import("../sequences");
    const result = await getSequences({ viewer: null });

    expect(result.pageCount).toBe(1);
    expect(result.total).toBe(0);
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  // Pass 12 §28/§30 — the new 25/50/75/100 rows-per-page allow-list, proven
  // end to end through the real query (not just the resolvePageSize unit).
  it.each([25, 50, 75, 100])("honors an explicit, allow-listed pageSize of %i", async (size) => {
    const sequence = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { sequence } }));
    vi.doMock("@/server/visibility", () => ({ sequenceVisibilityWhere: () => ({}) }));

    const { getSequences } = await import("../sequences");
    await getSequences({ viewer: null, pageSize: size, page: 1 });

    expect(sequence.findManyCalls[0].take).toBe(size);
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  it("rejects an in-range-but-not-allow-listed pageSize (e.g. 40) — falls back to 25, never silently honors an arbitrary value", async () => {
    const sequence = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { sequence } }));
    vi.doMock("@/server/visibility", () => ({ sequenceVisibilityWhere: () => ({}) }));

    const { getSequences } = await import("../sequences");
    await getSequences({ viewer: null, pageSize: 40, page: 1 });

    expect(sequence.findManyCalls[0].take).toBe(25);
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  it("a larger pageSize (100) combined with filters/search still uses count() for the same where as findMany() — no count/filter mismatch introduced by the new page-size range", async () => {
    const sequence = makeFakeModel([{ id: "s1" }], 240);
    vi.doMock("@/lib/prisma", () => ({ prisma: { sequence } }));
    vi.doMock("@/server/visibility", () => ({ sequenceVisibilityWhere: () => ({ companyId: "company-1" }) }));

    const { getSequences } = await import("../sequences");
    const result = await getSequences({ viewer: { id: "a", role: "ADMIN", companyId: "company-1" } as never, pageSize: 100, page: 2 });

    expect(sequence.findManyCalls[0].skip).toBe(100);
    expect(sequence.findManyCalls[0].take).toBe(100);
    expect(sequence.countCalls[0].where).toEqual(sequence.findManyCalls[0].where);
    expect(result.pageCount).toBe(3); // ceil(240/100)
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });
});

describe("getContactInquiries — server-side pagination", () => {
  it("computes skip/take for page 2 and scopes the count to the same where clause", async () => {
    const contactInquiry = makeFakeModel([{ id: "i1" }], 30);
    vi.doMock("@/lib/prisma", () => ({ prisma: { contactInquiry } }));

    const { getContactInquiries } = await import("../contact-inquiries");
    const result = await getContactInquiries({ companyId: "company-1", page: 2 });

    expect(contactInquiry.findManyCalls[0].skip).toBe(25);
    expect(contactInquiry.findManyCalls[0].take).toBe(25);
    expect(contactInquiry.countCalls[0].where).toEqual(contactInquiry.findManyCalls[0].where);
    expect(result.pageCount).toBe(2); // ceil(30/25)
    vi.doUnmock("@/lib/prisma");
  });

  it("filters by status when given, scoping both findMany and count identically", async () => {
    const contactInquiry = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { contactInquiry } }));

    const { getContactInquiries } = await import("../contact-inquiries");
    await getContactInquiries({ companyId: "company-1", status: "NEW" as never });

    expect(contactInquiry.findManyCalls[0].where).toMatchObject({ companyId: "company-1", status: "NEW" });
    vi.doUnmock("@/lib/prisma");
  });
});

describe("getMarketingCampaigns — server-side pagination", () => {
  it("computes skip/take correctly and never fetches the whole company's campaigns", async () => {
    const marketingCampaign = makeFakeModel(Array.from({ length: 25 }, (_, i) => ({ id: `c${i}` })), 142);
    vi.doMock("@/lib/prisma", () => ({ prisma: { marketingCampaign } }));

    const { getMarketingCampaigns } = await import("../marketing-campaigns");
    const result = await getMarketingCampaigns({ companyId: "company-1", page: 4 });

    expect(marketingCampaign.findManyCalls[0].skip).toBe(75); // (4-1) * 25
    expect(marketingCampaign.findManyCalls[0].take).toBe(25);
    expect(result.campaigns).toHaveLength(25); // the fake page, not all 142
    expect(result.total).toBe(142);
    expect(result.pageCount).toBe(6); // ceil(142/25)
    vi.doUnmock("@/lib/prisma");
  });
});

describe("getSubscribers — server-side pagination", () => {
  it("computes skip/take correctly and filters by status when given", async () => {
    const subscriber = makeFakeModel([{ id: "sub1" }], 51);
    vi.doMock("@/lib/prisma", () => ({ prisma: { subscriber } }));

    const { getSubscribers } = await import("../subscribers");
    const result = await getSubscribers({ companyId: "company-1", status: "UNSUBSCRIBED" as never, page: 2 });

    expect(subscriber.findManyCalls[0].skip).toBe(25);
    expect(subscriber.findManyCalls[0].take).toBe(25);
    expect(subscriber.findManyCalls[0].where).toMatchObject({ companyId: "company-1", status: "UNSUBSCRIBED" });
    expect(result.pageCount).toBe(3); // ceil(51/25)
    vi.doUnmock("@/lib/prisma");
  });

  it("omits the status filter entirely when none is given (the 'All' tab)", async () => {
    const subscriber = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { subscriber } }));

    const { getSubscribers } = await import("../subscribers");
    await getSubscribers({ companyId: "company-1" });

    expect(subscriber.findManyCalls[0].where).toEqual({ companyId: "company-1" });
    vi.doUnmock("@/lib/prisma");
  });
});

// Pass 8 §3 — the per-sequence enrollment list, previously an unbounded
// `include: { enrollments: {...} }` inside getSequenceDetail. Now its own
// paginated query, independently re-checking sequenceVisibilityWhere (a
// user must not see another company's/user's sequence's enrollments merely
// by guessing a sequenceId in the URL — this is what proves that).
describe("getSequenceEnrollments — server-side pagination (Pass 8 §3)", () => {
  const VISIBILITY_WHERE = { sequence: { companyId: "company-1" } };

  function mockDeps(model: ReturnType<typeof makeFakeModel>) {
    vi.doMock("@/lib/prisma", () => ({ prisma: { sequenceEnrollment: model } }));
    vi.doMock("@/server/visibility", () => ({ sequenceVisibilityWhere: () => VISIBILITY_WHERE.sequence }));
  }

  it("first page: skip 0, take 25", async () => {
    const sequenceEnrollment = makeFakeModel([{ id: "e1" }], 60);
    mockDeps(sequenceEnrollment);

    const { getSequenceEnrollments } = await import("../sequences");
    const result = await getSequenceEnrollments({ sequenceId: "seq-1", viewer: { id: "a", role: "ADMIN", companyId: "company-1" } as never, page: 1 });

    expect(sequenceEnrollment.findManyCalls[0].skip).toBe(0);
    expect(sequenceEnrollment.findManyCalls[0].take).toBe(25);
    expect(result.total).toBe(60);
    expect(result.pageCount).toBe(3); // ceil(60/25)
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  it("second page: skip 25, take 25", async () => {
    const sequenceEnrollment = makeFakeModel([{ id: "e26" }], 60);
    mockDeps(sequenceEnrollment);

    const { getSequenceEnrollments } = await import("../sequences");
    await getSequenceEnrollments({ sequenceId: "seq-1", viewer: null, page: 2 });

    expect(sequenceEnrollment.findManyCalls[0].skip).toBe(25);
    expect(sequenceEnrollment.findManyCalls[0].take).toBe(25);
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  it("last page: skip lands correctly for a partial final page", async () => {
    const sequenceEnrollment = makeFakeModel([{ id: "e51" }], 51);
    mockDeps(sequenceEnrollment);

    const { getSequenceEnrollments } = await import("../sequences");
    const result = await getSequenceEnrollments({ sequenceId: "seq-1", viewer: null, page: 3 });

    expect(sequenceEnrollment.findManyCalls[0].skip).toBe(50); // (3-1)*25
    expect(result.pageCount).toBe(3);
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  it("a page beyond the last still computes a well-formed (if empty-result) skip — never throws", async () => {
    const sequenceEnrollment = makeFakeModel([], 10);
    mockDeps(sequenceEnrollment);

    const { getSequenceEnrollments } = await import("../sequences");
    const result = await getSequenceEnrollments({ sequenceId: "seq-1", viewer: null, page: 999999999 });

    expect(sequenceEnrollment.findManyCalls[0].skip).toBe((999999999 - 1) * 25);
    expect(result.enrollments).toEqual([]);
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  it("negative page is clamped to page 1", async () => {
    const sequenceEnrollment = makeFakeModel([], 0);
    mockDeps(sequenceEnrollment);

    const { getSequenceEnrollments } = await import("../sequences");
    const result = await getSequenceEnrollments({ sequenceId: "seq-1", viewer: null, page: -5 });

    expect(sequenceEnrollment.findManyCalls[0].skip).toBe(0);
    expect(result.page).toBe(1);
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  it("an invalid (NaN) page is clamped to page 1, never producing a NaN skip", async () => {
    const sequenceEnrollment = makeFakeModel([], 0);
    mockDeps(sequenceEnrollment);

    const { getSequenceEnrollments } = await import("../sequences");
    const result = await getSequenceEnrollments({ sequenceId: "seq-1", viewer: null, page: Number.NaN });

    expect(sequenceEnrollment.findManyCalls[0].skip).toBe(0);
    expect(Number.isNaN(sequenceEnrollment.findManyCalls[0].skip)).toBe(false);
    expect(result.page).toBe(1);
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  it("hard-caps pageSize at 25 even when a caller passes a larger value (§31)", async () => {
    const sequenceEnrollment = makeFakeModel([], 0);
    mockDeps(sequenceEnrollment);

    const { getSequenceEnrollments } = await import("../sequences");
    await getSequenceEnrollments({ sequenceId: "seq-1", viewer: null, pageSize: 100000 });

    expect(sequenceEnrollment.findManyCalls[0].take).toBe(25);
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  it("scopes BOTH findMany and count to the same sequenceId + visibility where — never a fetch-all", async () => {
    const sequenceEnrollment = makeFakeModel([], 0);
    mockDeps(sequenceEnrollment);

    const { getSequenceEnrollments } = await import("../sequences");
    await getSequenceEnrollments({ sequenceId: "seq-1", viewer: { id: "a", role: "TRAVEL_AGENT", companyId: "company-1" } as never });

    expect(sequenceEnrollment.findManyCalls[0].where).toEqual({ sequenceId: "seq-1", sequence: { companyId: "company-1" } });
    expect(sequenceEnrollment.countCalls[0].where).toEqual(sequenceEnrollment.findManyCalls[0].where);
    // A real pagination query always supplies skip/take — the defining
    // difference from a "fetch everything, slice in JS" implementation.
    expect(sequenceEnrollment.findManyCalls[0].skip).toBeDefined();
    expect(sequenceEnrollment.findManyCalls[0].take).toBeDefined();
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });

  it("re-applies sequenceVisibilityWhere independently — never trusts the caller already checked it", async () => {
    const sequenceEnrollment = makeFakeModel([], 0);
    const sequenceVisibilityWhere = vi.fn(() => ({ companyId: "company-1" }));
    vi.doMock("@/lib/prisma", () => ({ prisma: { sequenceEnrollment } }));
    vi.doMock("@/server/visibility", () => ({ sequenceVisibilityWhere }));

    const { getSequenceEnrollments } = await import("../sequences");
    await getSequenceEnrollments({ sequenceId: "seq-1", viewer: { id: "a", role: "TRAVEL_AGENT", companyId: "company-1" } as never });

    expect(sequenceVisibilityWhere).toHaveBeenCalledTimes(1);
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/server/visibility");
  });
});
