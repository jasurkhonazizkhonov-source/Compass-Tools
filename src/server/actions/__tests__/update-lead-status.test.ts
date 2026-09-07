import { describe, it, expect, vi, beforeEach } from "vitest";

// Item 12 — once a Lead reaches BOOKED (via the completed charged-quote/
// ticketing workflow), only Admin/Manager may manually change it away from
// that status via updateLeadStatus. Every other current status remains
// open to whichever role already has ownership/visibility of the lead
// (leadVisibilityWhere, untouched by this change) — these tests focus on
// the new role gate specifically, not visibility (already covered
// elsewhere), so the fake `lead.findFirst` below is deliberately
// visibility-permissive (returns the row whenever it exists), matching the
// same simplification convention leads.test.ts's own comment documents for
// an ADMIN-actor-only fake.

type FakeLead = { id: string; status: string };

let leads: Map<string, FakeLead>;
let currentActor: { id: string; role: string } | null;
let statusHistory: Array<{ leadId: string; fromStatus: string; toStatus: string }>;

const fakePrisma = {
  lead: {
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
      const lead = leads.get(where.id);
      return lead ? { id: lead.id, status: lead.status } : null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      const lead = leads.get(where.id);
      if (!lead) throw new Error("not found");
      return lead;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
      const lead = leads.get(where.id)!;
      lead.status = data.status;
      return lead;
    }),
  },
  leadStatusHistory: {
    create: vi.fn(async ({ data }: { data: { leadId: string; fromStatus: string; toStatus: string } }) => {
      statusHistory.push(data);
      return data;
    }),
  },
  // Supports BOTH forms Prisma's $transaction API accepts: the array-of-
  // promises form (applyLeadStatusChange's own, pre-existing use) and the
  // interactive callback form (Pass 6's race-safe guarded path below,
  // which needs to read-then-write against the SAME fake `tx` client).
  $transaction: vi.fn(async (arg: Array<Promise<unknown>> | ((tx: typeof fakePrisma) => Promise<unknown>)) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg(fakePrisma);
  }),
};

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeEach(() => {
  leads = new Map([
    ["lead-booked", { id: "lead-booked", status: "BOOKED" }],
    ["lead-new", { id: "lead-new", status: "NEW" }],
  ]);
  statusHistory = [];
  currentActor = { id: "admin-1", role: "ADMIN" };
  vi.clearAllMocks();
});

describe("updateLeadStatus — Booked-lead protection (Item 12)", () => {
  it("Admin CAN change a Booked lead's status", async () => {
    const { updateLeadStatus } = await import("../leads");
    await updateLeadStatus("lead-booked", "IN_PROCESS");
    expect(leads.get("lead-booked")!.status).toBe("IN_PROCESS");
  });

  it("Manager CAN change a Booked lead's status", async () => {
    currentActor = { id: "manager-1", role: "MANAGER" };
    const { updateLeadStatus } = await import("../leads");
    await updateLeadStatus("lead-booked", "IN_PROCESS");
    expect(leads.get("lead-booked")!.status).toBe("IN_PROCESS");
  });

  it("Travel Agent CANNOT change a Booked lead's status — rejected, no write occurs", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT" };
    const { updateLeadStatus } = await import("../leads");
    await expect(updateLeadStatus("lead-booked", "IN_PROCESS")).rejects.toThrow(/Admin or Manager/i);
    expect(leads.get("lead-booked")!.status).toBe("BOOKED");
    expect(statusHistory).toHaveLength(0);
  });

  it("Ticketing Agent CANNOT change a Booked lead's status", async () => {
    currentActor = { id: "ticketing-1", role: "TICKETING_AGENT" };
    const { updateLeadStatus } = await import("../leads");
    await expect(updateLeadStatus("lead-booked", "IN_PROCESS")).rejects.toThrow(/Admin or Manager/i);
  });

  it("Flight Expert CANNOT change a Booked lead's status", async () => {
    currentActor = { id: "flight-expert-1", role: "FLIGHT_EXPERT" };
    const { updateLeadStatus } = await import("../leads");
    await expect(updateLeadStatus("lead-booked", "IN_PROCESS")).rejects.toThrow(/Admin or Manager/i);
  });

  it("an unauthenticated caller is rejected even earlier, by the pre-existing visibility guard (never even reaches the Booked-status check, never leaks the lead's status)", async () => {
    currentActor = null;
    const { updateLeadStatus } = await import("../leads");
    await expect(updateLeadStatus("lead-booked", "IN_PROCESS")).rejects.toThrow(/not found/i);
  });

  it("a non-Booked lead is completely unaffected — every role can still change it (direct server-action invocation, not just UI)", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT" };
    const { updateLeadStatus } = await import("../leads");
    await updateLeadStatus("lead-new", "ATTEMPTING_TO_CONTACT");
    expect(leads.get("lead-new")!.status).toBe("ATTEMPTING_TO_CONTACT");
  });

  it("does not throw for a Booked lead when the target status IS still Booked (a same-status no-op selection)", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT" };
    const { updateLeadStatus } = await import("../leads");
    // Still gated — going FROM Booked to any status (even Booked itself)
    // requires Admin/Manager per the current-status check; this documents
    // that exact (intentionally strict) behavior rather than assuming a
    // same-value exception exists.
    await expect(updateLeadStatus("lead-booked", "BOOKED")).rejects.toThrow(/Admin or Manager/i);
  });
});

// Pass 6 — Pass 5's own remaining-limitations review (§32.A) flagged a real
// TOCTOU window: the original updateLeadStatus read `status` ONCE (for the
// guard) and then called applyLeadStatusChange, which performed its OWN
// separate read moments later before writing — a concurrent request (e.g.
// submitBooking completing a booking on the very same lead) could move the
// lead to BOOKED in that gap, and a non-Admin/Manager's already-in-flight
// status change would slip through ungated. Fixed with a single Serializable
// transaction that reads the CURRENT status at write time, mirroring
// resolveContactForNewLead's own established read-then-write race handling.
describe("updateLeadStatus — TOCTOU race fix (Pass 5 §32.A / Pass 6)", () => {
  it("a lead that becomes BOOKED between the visibility check and the guarded write is still caught — the guard reads status fresh at write time, not from any earlier read", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT" };
    // Models a concurrent request (e.g. a booking completing) landing in
    // the gap between this request's visibility check and its own guarded
    // transaction — the mutation happens as a side effect of the
    // visibility-check call itself, so by the time the transaction does
    // its own fresh read, it observes the concurrently-changed status.
    fakePrisma.lead.findFirst.mockImplementationOnce(async ({ where }: { where: { id: string } }) => {
      const lead = leads.get(where.id);
      if (lead) lead.status = "BOOKED";
      return lead ? { id: lead.id, status: lead.status } : null;
    });
    const { updateLeadStatus } = await import("../leads");
    await expect(updateLeadStatus("lead-new", "ATTEMPTING_TO_CONTACT")).rejects.toThrow(/Admin or Manager/i);
    expect(leads.get("lead-new")!.status).toBe("BOOKED");
    expect(statusHistory).toHaveLength(0);
  });

  it("retries on a P2034 serialization conflict and still applies the guard correctly on the retry", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT" };
    const { Prisma } = await import("@/generated/prisma/client");
    const realTransaction = fakePrisma.$transaction;
    let call = 0;
    fakePrisma.$transaction = vi.fn(async (arg: unknown) => {
      call++;
      if (call === 1) {
        throw new Prisma.PrismaClientKnownRequestError("Transaction conflict", { code: "P2034", clientVersion: "test" });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realTransaction as any)(arg);
    });
    const { updateLeadStatus } = await import("../leads");
    await updateLeadStatus("lead-new", "ATTEMPTING_TO_CONTACT");
    expect(leads.get("lead-new")!.status).toBe("ATTEMPTING_TO_CONTACT");
    expect(fakePrisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("a genuine business-rule rejection (BOOKED, no permission) is NOT retried as if it were a conflict — fails immediately on the first attempt", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT" };
    const { updateLeadStatus } = await import("../leads");
    await expect(updateLeadStatus("lead-booked", "IN_PROCESS")).rejects.toThrow(/Admin or Manager/i);
    expect(fakePrisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
