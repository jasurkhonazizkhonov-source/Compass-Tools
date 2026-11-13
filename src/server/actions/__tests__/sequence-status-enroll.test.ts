import { describe, it, expect, vi, beforeEach } from "vitest";

// Status-based enrollment (Sequences section -> Enroll Leads -> By status). Database-free: prisma, the shared eligibility module and enrollLeads
// are replaced so the tests pin down what THIS module is responsible for - validation, authorization, the server-side lookup by status inside
// the caller's visibility, chunking, the size limit, and honest aggregation - without a database.

type Actor = { id: string; role: string; companyId: string } | null;
let actor: Actor;
let sequenceRow: { id: string; name: string; _count: { steps: number } } | null;
let leadsByQuery: string[];
let verdictOf: (id: string) => string;
let enrollImpl: (sequenceId: string, ids: string[]) => Promise<Record<string, unknown>>;

const leadFindMany = vi.fn();
const sequenceFindFirst = vi.fn();
const classify = vi.fn();
const enrollLeadsMock = vi.fn();

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lead: { findMany: (...a: unknown[]) => leadFindMany(...a) },
    sequence: { findFirst: (...a: unknown[]) => sequenceFindFirst(...a) },
  },
}));
vi.mock("@/server/sequence-enrollment-eligibility", () => ({ classifyLeadsForEnrollment: (...a: unknown[]) => classify(...a) }));
vi.mock("@/server/actions/sequences", () => ({ enrollLeads: (...a: unknown[]) => enrollLeadsMock(...a) }));

const ADMIN = { id: "admin-1", role: "ADMIN", companyId: "co-1" };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `lead-${String(i).padStart(5, "0")}`);

beforeEach(() => {
  actor = ADMIN;
  sequenceRow = { id: "seq-1", name: "Welcome Series", _count: { steps: 3 } };
  leadsByQuery = ids(3);
  verdictOf = () => "eligible";
  enrollImpl = async (_s, chunk) => ({ enrolled: chunk.length, alreadyActive: 0, missingEmail: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0 });
  vi.clearAllMocks();
  leadFindMany.mockImplementation(async (args: { take?: number }) => leadsByQuery.slice(0, args.take ?? leadsByQuery.length).map((id) => ({ id })));
  sequenceFindFirst.mockImplementation(async () => sequenceRow);
  classify.mockImplementation(async ({ leadIds }: { leadIds: string[] }) => ({ verdicts: new Map(leadIds.map((id) => [id, verdictOf(id)])), recipientByLead: new Map(), blocked: [] }));
  enrollLeadsMock.mockImplementation((s: string, chunk: string[]) => enrollImpl(s, chunk));
});

describe("status values", () => {
  it("rejects an empty list, a non-array, an unknown status and a status the CRM does not define — before any lead is queried", async () => {
    const { previewEnrollByStatus, enrollLeadsByStatus } = await import("../sequence-status-enroll");
    for (const bad of [[], "BOOKED", null, ["BOOKED", "NOT_A_STATUS"], ["booked"], [1], undefined]) {
      expect(await previewEnrollByStatus({ sequenceId: "seq-1", statuses: bad as never })).toEqual({ ok: false, error: "Choose at least one lead status." });
      expect(await enrollLeadsByStatus({ sequenceId: "seq-1", statuses: bad as never })).toEqual({ ok: false, error: "Choose at least one lead status." });
    }
    expect(leadFindMany).not.toHaveBeenCalled();
    expect(enrollLeadsMock).not.toHaveBeenCalled();
  });

  it("every status the CRM defines is accepted, and a repeated status is counted once", async () => {
    const { LEAD_STATUS_META } = await import("@/lib/status-meta");
    const { previewEnrollByStatus } = await import("../sequence-status-enroll");
    const all = Object.keys(LEAD_STATUS_META);
    expect(all.length).toBeGreaterThan(10);
    expect((await previewEnrollByStatus({ sequenceId: "seq-1", statuses: all })).ok).toBe(true);
    await previewEnrollByStatus({ sequenceId: "seq-1", statuses: ["BOOKED", "BOOKED", "QUOTED"] });
    const last = leadFindMany.mock.calls.at(-1)![0] as { where: { status: { in: string[] } } };
    expect(last.where.status.in).toEqual(["BOOKED", "QUOTED"]);
  });
});

describe("authorization", () => {
  it("nobody is signed in, or the role may not manage sequences: nothing is looked up or enrolled", async () => {
    const { previewEnrollByStatus, enrollLeadsByStatus } = await import("../sequence-status-enroll");
    for (const who of [null, { id: "t-1", role: "TICKETING_AGENT", companyId: "co-1" }]) {
      actor = who;
      expect(await previewEnrollByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] })).toEqual({ ok: false, error: "That sequence is not available." });
      expect(await enrollLeadsByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] })).toEqual({ ok: false, error: "That sequence is not available." });
    }
    expect(leadFindMany).not.toHaveBeenCalled();
    expect(enrollLeadsMock).not.toHaveBeenCalled();
  });

  it("a sequence the caller cannot see (another company / not theirs) is reported as not available — no existence leak", async () => {
    sequenceRow = null;
    const { enrollLeadsByStatus } = await import("../sequence-status-enroll");
    expect(await enrollLeadsByStatus({ sequenceId: "someone-elses", statuses: ["BOOKED"] })).toEqual({ ok: false, error: "That sequence is not available." });
    expect(leadFindMany).not.toHaveBeenCalled();
  });

  it("the lead lookup is scoped to the caller's own visibility (company), never a company-wide query by status alone", async () => {
    const { previewEnrollByStatus } = await import("../sequence-status-enroll");
    await previewEnrollByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] });
    const where = (leadFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.status).toEqual({ in: ["BOOKED"] });
    expect(where.contact).toEqual({ companyId: "co-1" }); // leadVisibilityWhere for an Admin
    actor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "co-1" };
    await previewEnrollByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] });
    expect((leadFindMany.mock.calls.at(-1)![0] as { where: Record<string, unknown> }).where.assignedAgentId).toBe("agent-1"); // an agent only ever sees their own
  });

  it("a sequence with no steps cannot be enrolled into", async () => {
    sequenceRow = { id: "seq-1", name: "Empty", _count: { steps: 0 } };
    const { previewEnrollByStatus, enrollLeadsByStatus } = await import("../sequence-status-enroll");
    expect(await previewEnrollByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] })).toEqual({ ok: false, error: "This sequence has no steps yet." });
    expect(await enrollLeadsByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] })).toEqual({ ok: false, error: "This sequence has no steps yet." });
  });
});

describe("preview", () => {
  it("reports exact counts per reason, produced by the shared eligibility rules, with local Gmail checks only", async () => {
    leadsByQuery = ids(6);
    const map: Record<string, string> = { "lead-00000": "eligible", "lead-00001": "eligible", "lead-00002": "alreadyActive", "lead-00003": "missingEmail", "lead-00004": "noAssignedAgent", "lead-00005": "gmailUnavailable" };
    verdictOf = (id) => map[id];
    const { previewEnrollByStatus } = await import("../sequence-status-enroll");
    const r = await previewEnrollByStatus({ sequenceId: "seq-1", statuses: ["ATTEMPTING_TO_CONTACT", "BOOKED"] });
    expect(r).toMatchObject({ ok: true, sequenceName: "Welcome Series", truncated: false, matched: 6, eligible: 2, alreadyActive: 1, missingEmail: 1, noAssignedAgent: 1, gmailUnavailable: 1, inaccessible: 0 });
    expect(classify).toHaveBeenCalledWith(expect.objectContaining({ verifyGmail: false, sequenceId: "seq-1" }));
    expect(enrollLeadsMock).not.toHaveBeenCalled(); // a preview never enrolls
  });

  it("matched = every status's leads together, and a selection of one status works", async () => {
    leadsByQuery = ids(4);
    const { previewEnrollByStatus } = await import("../sequence-status-enroll");
    expect(await previewEnrollByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] })).toMatchObject({ ok: true, matched: 4, eligible: 4 });
  });

  it("classifies in chunks of 200, so a large selection is never one unbounded query", async () => {
    leadsByQuery = ids(450);
    const { previewEnrollByStatus } = await import("../sequence-status-enroll");
    const r = await previewEnrollByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] });
    expect(r).toMatchObject({ matched: 450, eligible: 450 });
    expect(classify.mock.calls.map((c) => (c[0] as { leadIds: string[] }).leadIds.length)).toEqual([200, 200, 50]);
  });

  it("more than 5,000 matches: nothing is classified, and the person is told to narrow the selection", async () => {
    leadsByQuery = ids(5001);
    const { previewEnrollByStatus } = await import("../sequence-status-enroll");
    const r = await previewEnrollByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] });
    expect(r).toMatchObject({ ok: true, truncated: true, eligible: 0 });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("enrollment", () => {
  it("re-queries by status on the server at confirmation time and enrolls through enrollLeads (which re-validates everything), in chunks of 200", async () => {
    leadsByQuery = ids(450);
    const { enrollLeadsByStatus } = await import("../sequence-status-enroll");
    const r = await enrollLeadsByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"], previewMatched: 450 });
    expect(r).toMatchObject({ ok: true, matched: 450, enrolled: 450, failedOther: 0, changedSincePreview: 0 });
    expect(enrollLeadsMock.mock.calls.map((c) => (c[1] as string[]).length)).toEqual([200, 200, 50]);
    expect(leadFindMany).toHaveBeenCalledTimes(1); // one fresh lookup by status, not the browser's list
  });

  it("aggregates partial success honestly and surfaces the Gmail explanation", async () => {
    leadsByQuery = ids(4);
    enrollImpl = async () => ({ enrolled: 1, alreadyActive: 1, missingEmail: 1, noAssignedAgent: 0, gmailUnavailable: 1, inaccessible: 0, gmailMessage: "Gmail is not connected. Agent One's Gmail is not connected" });
    const { enrollLeadsByStatus } = await import("../sequence-status-enroll");
    const r = await enrollLeadsByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] });
    expect(r).toMatchObject({ ok: true, matched: 4, enrolled: 1, alreadyActive: 1, missingEmail: 1, gmailUnavailable: 1, failedOther: 0 });
    if (r.ok) expect(r.gmailMessage).toMatch(/Gmail is not connected/);
  });

  it("a chunk that throws is counted as failed — success is never claimed for it — while other chunks still go through", async () => {
    leadsByQuery = ids(450);
    let n = 0;
    enrollImpl = async (_s, chunk) => {
      if (++n === 2) throw new Error("database timeout");
      return { enrolled: chunk.length, alreadyActive: 0, missingEmail: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0 };
    };
    const { enrollLeadsByStatus } = await import("../sequence-status-enroll");
    const r = await enrollLeadsByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] });
    expect(r).toMatchObject({ ok: true, matched: 450, enrolled: 250, failedOther: 200 });
  });

  it("leads whose status changed after the preview are simply not matched, and the difference is reported", async () => {
    leadsByQuery = ids(7);
    const { enrollLeadsByStatus } = await import("../sequence-status-enroll");
    const r = await enrollLeadsByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"], previewMatched: 10 });
    expect(r).toMatchObject({ ok: true, matched: 7, enrolled: 7, changedSincePreview: 3 });
  });

  it("no matching leads, or more than 5,000: nothing is enrolled", async () => {
    const { enrollLeadsByStatus } = await import("../sequence-status-enroll");
    leadsByQuery = [];
    expect(await enrollLeadsByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] })).toEqual({ ok: false, error: "No leads currently have the selected status." });
    leadsByQuery = ids(5001);
    const big = await enrollLeadsByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] });
    expect(big.ok).toBe(false);
    expect(enrollLeadsMock).not.toHaveBeenCalled();
  });

  it("a repeated confirmation (double click) enrolls nobody twice: the second run finds them already active", async () => {
    leadsByQuery = ids(3);
    let call = 0;
    enrollImpl = async (_s, chunk) => (++call === 1 ? { enrolled: chunk.length, alreadyActive: 0, missingEmail: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0 } : { enrolled: 0, alreadyActive: chunk.length, missingEmail: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0 });
    const { enrollLeadsByStatus } = await import("../sequence-status-enroll");
    const first = await enrollLeadsByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] });
    const second = await enrollLeadsByStatus({ sequenceId: "seq-1", statuses: ["BOOKED"] });
    expect(first).toMatchObject({ enrolled: 3, alreadyActive: 0 });
    expect(second).toMatchObject({ enrolled: 0, alreadyActive: 3 });
  });
});
