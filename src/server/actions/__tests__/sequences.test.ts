import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fake Prisma, same convention as other server-action test files.
// Focused on the Part 4/12 IDOR fix: assertSequenceAccess() previously did
// not exist at all — deleteSequence/toggleSequenceActive/addStep/updateStep/
// deleteStep/enrollLeads/unenrollLead had zero authorization check.

type FakeAccount = { id: string; role: string; companyId: string };
type FakeSequence = { id: string; name: string; isActive: boolean; createdById: string | null; companyId: string };
type FakeStep = { id: string; sequenceId: string; subject: string; body: string; delayMinutes: number; order: number };

let currentActor: FakeAccount | null;
let sequences: Map<string, FakeSequence>;
let steps: Map<string, FakeStep>;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakePrismaClient: any = {
  sequence: {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const seq = sequences.get(where.id as string);
      if (!seq) return null;
      if ("createdById" in where && where.createdById !== undefined) {
        return seq.createdById === where.createdById ? seq : null;
      }
      if ("OR" in where) {
        const or = where.OR as Array<Record<string, unknown>>;
        const matches = or.some((cond) => {
          if ("createdBy" in cond) {
            const companyId = (cond.createdBy as { companyId: string }).companyId;
            return seq.createdById !== null && accounts.get(seq.createdById)?.companyId === companyId;
          }
          if ("createdById" in cond) return seq.createdById === cond.createdById;
          return false;
        });
        return matches ? seq : null;
      }
      return seq;
    }),
    findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      const seq = sequences.get(id);
      if (!seq) throw new Error("not found");
      return { ...seq, steps: [...steps.values()].filter((s) => s.sequenceId === id) };
    }),
    create: vi.fn(async ({ data }: { data: Partial<FakeSequence> }) => {
      const id = `seq-${sequences.size + 1}`;
      const seq: FakeSequence = { id, name: data.name ?? "", isActive: true, createdById: data.createdById ?? null, companyId: "company-1" };
      sequences.set(id, seq);
      return seq;
    }),
    update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakeSequence> }) => {
      const seq = sequences.get(id)!;
      Object.assign(seq, data);
      return seq;
    }),
    delete: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      sequences.delete(id);
    }),
  },
  sequenceStep: {
    count: vi.fn(async ({ where }: { where: { sequenceId: string } }) => [...steps.values()].filter((s) => s.sequenceId === where.sequenceId).length),
    create: vi.fn(async ({ data }: { data: Partial<FakeStep> }) => {
      const id = `step-${steps.size + 1}`;
      const step: FakeStep = { id, sequenceId: data.sequenceId!, subject: data.subject ?? "", body: data.body ?? "", delayMinutes: data.delayMinutes ?? 0, order: data.order ?? 0 };
      steps.set(id, step);
      return step;
    }),
    update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakeStep> }) => {
      const step = steps.get(id)!;
      Object.assign(step, data);
      return step;
    }),
    delete: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      const step = steps.get(id)!;
      steps.delete(id);
      return step;
    }),
    findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      const step = steps.get(id);
      if (!step) throw new Error("not found");
      return step;
    }),
  },
  lead: {
    // Pass 35 — extended (was a dumb `() => []` stub) so enrollLeads' own
    // visibility-filter query and its recipientEmail-validation query both
    // resolve against real seeded data, for the batched-activity-log test
    // below. Ignores the visibility fragment's exact shape — every test
    // using this runs as an ADMIN/company-wide actor, so returning every
    // seeded lead matching the requested ids is equivalent.
    findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) => {
      const ids = where.id?.in ?? [];
      return ids.filter((id) => leads.has(id)).map((id) => {
        const lead = leads.get(id)!;
        return { id, contact: { primaryEmail: lead.contactEmail, emails: [] } };
      });
    }),
  },
  activity: {
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      activities.push(...data);
      return { count: data.length };
    }),
  },
  sequenceEnrollment: {
    findMany: vi.fn(async () => []),
    createMany: vi.fn(async () => ({ count: 0 })),
    findUniqueOrThrow: vi.fn(async () => { throw new Error("not found"); }),
    // Pass 19 — extended for processDueSequenceSteps' concurrency-claim
    // tests below. `enrollments` (a plain array, mutated in place) backs
    // both findMany and the claim's conditional updateMany, so the two
    // behave like the real Postgres row they're standing in for: a
    // successful claim actually changes what a SECOND findMany-then-claim
    // attempt would see.
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; status?: string; nextSendAt?: Date | null }; data: Record<string, unknown> }) => {
      const row = enrollments.find((e) => e.id === where.id);
      if (!row) return { count: 0 };
      if (where.status !== undefined && row.status !== where.status) return { count: 0 };
      if (where.nextSendAt !== undefined && row.nextSendAt?.getTime() !== where.nextSendAt?.getTime()) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = enrollments.find((e) => e.id === id)!;
      Object.assign(row, data);
      return row;
    }),
  },
  sequenceStepLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      stepLogs.push(data);
      return data;
    }),
  },
  emailLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      emailLogs.push(data);
      return data;
    }),
  },
};

let accounts: Map<string, FakeAccount>;

// Pass 19 — fixtures for processDueSequenceSteps' concurrency tests.
type FakeEnrollment = {
  id: string;
  status: "ACTIVE" | "UNSUBSCRIBED" | "COMPLETED" | "FAILED";
  currentStepIdx: number;
  nextSendAt: Date | null;
  recipientEmail: string | null;
  leadId: string;
  sequence: { steps: Array<{ id: string; subject: string; body: string; delayMinutes: number }> };
  lead: {
    contactId: string;
    contact: { firstName: string; lastName: string; primaryPhone: string | null; primaryEmail: string | null };
    assignedAgent: { id: string; fullName: string; email: string; phone: string | null } | null;
    departureAirport: null;
    arrivalAirport: null;
    departureDate: null;
    returnDate: null;
    tripType: string;
    cabinClass: string;
  };
};
let enrollments: FakeEnrollment[];
let stepLogs: Array<Record<string, unknown>>;
let emailLogs: Array<Record<string, unknown>>;
let sendEmailCalls: Array<{ to: string }>;
// Pass 35 — fixtures for enrollLeads' batched-activity-log test.
let leads: Map<string, { contactEmail: string | null }>;
let activities: Array<Record<string, unknown>>;

vi.mock("@/lib/prisma", () => ({ prisma: fakePrismaClient }));
vi.mock("@/lib/company-config", () => ({ resolveBaseUrl: vi.fn(() => "https://example.com") }));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ id: "company-1", name: "Test Travel Co", brandColor: "#1c3a5e", logoEmailUrl: null, logoWebUrl: "", logoIconUrl: "", website: null, phone: null, signatureTemplate: "" })),
}));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (args: { to: string }) => {
    sendEmailCalls.push({ to: args.to });
    return { ok: true as const, messageId: `msg-${sendEmailCalls.length}` };
  }),
}));

beforeEach(() => {
  currentActor = null;
  sequences = new Map();
  steps = new Map();
  accounts = new Map();
  enrollments = [];
  stepLogs = [];
  emailLogs = [];
  sendEmailCalls = [];
  leads = new Map();
  activities = [];
  vi.clearAllMocks();
});

/** Real Prisma's findMany re-reads the CURRENT row state each time it's
 * called — this mock does too, since it queries `enrollments` live rather
 * than a snapshot, matching how two genuinely concurrent invocations of
 * processDueSequenceSteps would each independently see whatever the other
 * has already committed. */
function seedDueEnrollment(overrides: Partial<FakeEnrollment> = {}): FakeEnrollment {
  const e: FakeEnrollment = {
    id: `enr-${enrollments.length + 1}`,
    status: "ACTIVE",
    currentStepIdx: 0,
    nextSendAt: new Date(Date.now() - 1000),
    recipientEmail: null,
    leadId: "lead-1",
    sequence: { steps: [{ id: "step-1", subject: "Hi {{contactFirstName}}", body: "Checking in.", delayMinutes: 60 }] },
    lead: {
      contactId: "contact-1",
      contact: { firstName: "Andrew", lastName: "Kent", primaryPhone: null, primaryEmail: "andrew@example.com" },
      assignedAgent: { id: "agent-1", fullName: "Jane Doe", email: "jane@example.com", phone: null },
      departureAirport: null,
      arrivalAirport: null,
      departureDate: null,
      returnDate: null,
      tripType: "ONE_WAY",
      cabinClass: "ECONOMY",
    },
    ...overrides,
  };
  enrollments.push(e);
  // Shallow-copies each matched row (`{...row}`) rather than returning the
  // shared object reference — a real Prisma findMany returns a snapshot of
  // each row's values at read time, never a live-mutating reference back
  // into the database. Without this, this in-memory mock would let one
  // concurrent invocation's later claim-mutation retroactively change what
  // a DIFFERENT invocation's already-fetched `due` array appears to hold
  // (since JS object mutation is visible through any shared reference),
  // which isn't how Postgres actually behaves and would make the
  // concurrency tests below pass or fail for the wrong reason.
  fakePrismaClient.sequenceEnrollment.findMany = vi.fn(async ({ where }: { where: { status: string; nextSendAt: { lte: Date } } }) =>
    enrollments.filter((row) => row.status === where.status && row.nextSendAt != null && row.nextSendAt.getTime() <= where.nextSendAt.lte.getTime()).map((row) => ({ ...row }))
  );
  return e;
}

function seedSequence(id: string, overrides: Partial<FakeSequence> = {}) {
  sequences.set(id, { id, name: "Test Sequence", isActive: true, createdById: null, companyId: "company-1", ...overrides });
}

describe("Sequences — IDOR/ownership fix (previously zero authorization check)", () => {
  it("a Travel Agent cannot delete a sequence created by another agent", async () => {
    seedSequence("seq-1", { createdById: "agent-owner" });
    currentActor = { id: "agent-2", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { deleteSequence } = await import("../sequences");
    await expect(deleteSequence("seq-1")).rejects.toThrow(/not found|not authorized/i);
    expect(sequences.has("seq-1")).toBe(true);
  });

  it("a Travel Agent CAN delete their own sequence", async () => {
    seedSequence("seq-1", { createdById: "agent-1" });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { deleteSequence } = await import("../sequences");
    await deleteSequence("seq-1");
    expect(sequences.has("seq-1")).toBe(false);
  });

  it("an Admin can delete ANY sequence company-wide, even one they didn't create", async () => {
    accounts.set("agent-owner", { id: "agent-owner", role: "TRAVEL_AGENT", companyId: "company-1" });
    seedSequence("seq-1", { createdById: "agent-owner" });
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    const { deleteSequence } = await import("../sequences");
    await deleteSequence("seq-1");
    expect(sequences.has("seq-1")).toBe(false);
  });

  it("a Ticketing Agent (not in canManageSequences) cannot manage sequences at all", async () => {
    seedSequence("seq-1", { createdById: "agent-1" });
    currentActor = { id: "agent-1", role: "TICKETING_AGENT", companyId: "company-1" };
    const { toggleSequenceActive } = await import("../sequences");
    await expect(toggleSequenceActive("seq-1")).rejects.toThrow(/not found/i);
  });

  it("addStep/updateStep/deleteStep all reject a non-owning restricted-role actor", async () => {
    seedSequence("seq-1", { createdById: "agent-owner" });
    steps.set("step-1", { id: "step-1", sequenceId: "seq-1", subject: "Hi", body: "Hello", delayMinutes: 0, order: 0 });
    currentActor = { id: "agent-2", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { addStep, updateStep, deleteStep } = await import("../sequences");

    await expect(addStep({ sequenceId: "seq-1", subject: "S", body: "B", delayMinutes: 0 })).rejects.toThrow(/not found/i);
    await expect(updateStep("step-1", { subject: "Changed" })).rejects.toThrow(/not found/i);
    await expect(deleteStep("step-1")).rejects.toThrow(/not found/i);
    expect(steps.get("step-1")!.subject).toBe("Hi"); // untouched
  });

  it("toggleSequenceActive works for the sequence's own creator", async () => {
    seedSequence("seq-1", { createdById: "agent-1", isActive: true });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { toggleSequenceActive } = await import("../sequences");
    await toggleSequenceActive("seq-1");
    expect(sequences.get("seq-1")!.isActive).toBe(false);
  });
});

// Pass 19 §8/§23/§49 — concurrency audit. processDueSequenceSteps had NO
// regression coverage at all before this pass, despite three consecutive
// prior passes explicitly flagging "sequence concurrency" as unaudited.
// Investigation found a real, unmitigated double-send race (see this
// pass's own report and the CLAIM_LEASE_MS comment in sequences.ts) and
// fixed it with an atomic per-enrollment claim. These tests prove the fix
// directly — including the exact failure mode (two concurrent invocations
// racing over the same due enrollment) that a naive "does it send" test
// would never catch.
describe("processDueSequenceSteps — concurrency (Pass 19)", () => {
  it("sends the due step exactly once for a single invocation", async () => {
    seedDueEnrollment();
    const { processDueSequenceSteps } = await import("../sequences");
    const result = await processDueSequenceSteps();
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(sendEmailCalls).toHaveLength(1);
    expect(sendEmailCalls[0].to).toBe("andrew@example.com");
  });

  it("two concurrent invocations processing the SAME due enrollment send exactly once, not twice", async () => {
    seedDueEnrollment();
    const { processDueSequenceSteps } = await import("../sequences");
    // True concurrency: both calls start before either finishes, exactly
    // like two overlapping cron ticks or a manual click racing a scheduled
    // run. Promise.all, not two sequential awaits — the whole point is
    // that neither invocation has committed its claim before the other
    // reads.
    const [first, second] = await Promise.all([processDueSequenceSteps(), processDueSequenceSteps()]);
    const totalSent = first.sent + second.sent;
    expect(totalSent).toBe(1); // NEVER 2 — this is the actual bug this pass fixed
    expect(sendEmailCalls).toHaveLength(1);
  });

  it("advances the enrollment to the next step's delay after a successful send", async () => {
    const e = seedDueEnrollment();
    const { processDueSequenceSteps } = await import("../sequences");
    await processDueSequenceSteps();
    expect(e.currentStepIdx).toBe(1);
    expect(e.status).toBe("COMPLETED"); // only one step existed in the fixture
  });

  it("a worker's claim self-heals if it crashes before completing — the row becomes due again after the lease expires, not stuck forever", async () => {
    // Simulate a crashed worker: it claimed the row (nextSendAt pushed into
    // the future) but never got to update it to its real final value.
    const e = seedDueEnrollment({ nextSendAt: new Date(Date.now() + 2 * 60_000) }); // mid-lease
    const { processDueSequenceSteps } = await import("../sequences");
    const stillLeased = await processDueSequenceSteps();
    expect(stillLeased.sent).toBe(0); // not due yet — the lease hasn't expired
    e.nextSendAt = new Date(Date.now() - 1000); // lease expired, as it would after CLAIM_LEASE_MS
    const afterLeaseExpiry = await processDueSequenceSteps();
    expect(afterLeaseExpiry.sent).toBe(1);
  });

  it("a lead with no assigned agent fails closed (logged, not sent) rather than sending from an arbitrary sender", async () => {
    const base = seedDueEnrollment();
    enrollments.length = 0; // undo the seed above — this test wants exactly one enrollment, the modified one
    seedDueEnrollment({ ...base, id: "enr-1", lead: { ...base.lead, assignedAgent: null } });
    const { processDueSequenceSteps } = await import("../sequences");
    const result = await processDueSequenceSteps();
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("a contact with no email on file fails closed (logged, not sent, never throws to a caller)", async () => {
    const base = seedDueEnrollment();
    enrollments.length = 0;
    seedDueEnrollment({ ...base, id: "enr-1", lead: { ...base.lead, contact: { firstName: "A", lastName: "B", primaryPhone: null, primaryEmail: null } } });
    const { processDueSequenceSteps } = await import("../sequences");
    const result = await processDueSequenceSteps();
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(sendEmailCalls).toHaveLength(0);
  });

  // Pass 29 — real bug found and fixed: a permanently-unsendable enrollment
  // (no contact email, or no assigned agent — neither resolves itself with
  // time) previously stayed ACTIVE forever after failing, so the SAME
  // enrollment became "due" again once its temporary claim lease expired,
  // retrying indefinitely and silently generating a fresh duplicate
  // SequenceStepLog + EmailLog row every cycle with no terminal state and
  // no visibility to any human. Fixed by transitioning the enrollment
  // itself to the (previously unused) EnrollmentStatus.FAILED. These two
  // tests pin that fix directly, distinct from the two above (which only
  // check the immediate result, not what happens on the NEXT run).
  it("a permanently-unsendable enrollment (no assigned agent) is marked FAILED and stops being due — no infinite retry", async () => {
    const base = seedDueEnrollment();
    enrollments.length = 0;
    seedDueEnrollment({ ...base, id: "enr-1", lead: { ...base.lead, assignedAgent: null } });
    const { processDueSequenceSteps } = await import("../sequences");

    await processDueSequenceSteps();
    expect(enrollments[0].status).toBe("FAILED");
    expect(enrollments[0].nextSendAt).toBeNull();

    // Simulate the claim lease having "expired" by moving nextSendAt back
    // into the past — even so, a FAILED enrollment must never be picked up
    // again (the real due-query filters on status: "ACTIVE").
    enrollments[0].nextSendAt = new Date(Date.now() - 1000);
    const secondRun = await processDueSequenceSteps();
    expect(secondRun.processed).toBe(0);
    expect(stepLogs).toHaveLength(1); // not 2 — no duplicate retry log
  });

  it("a permanently-unsendable enrollment (no contact email) is marked FAILED and stops being due — no infinite retry", async () => {
    const base = seedDueEnrollment();
    enrollments.length = 0;
    seedDueEnrollment({ ...base, id: "enr-1", lead: { ...base.lead, contact: { firstName: "A", lastName: "B", primaryPhone: null, primaryEmail: null } } });
    const { processDueSequenceSteps } = await import("../sequences");

    await processDueSequenceSteps();
    expect(enrollments[0].status).toBe("FAILED");
    expect(enrollments[0].nextSendAt).toBeNull();

    enrollments[0].nextSendAt = new Date(Date.now() - 1000);
    const secondRun = await processDueSequenceSteps();
    expect(secondRun.processed).toBe(0);
    expect(stepLogs).toHaveLength(1);
  });
});

// Pass 35 — enrollLeads previously logged one Activity row per enrolled
// lead via a sequential `for` loop (N round-trips for a bulk enroll of
// hundreds/thousands of leads). Batched into a single activity.createMany
// call — same rows, same fields, just one round-trip instead of N.
describe("enrollLeads — batched activity logging (Pass 35)", () => {
  it("logs exactly one Activity row per enrolled lead via a single createMany call, not N sequential creates", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    accounts.set("admin-1", { id: "admin-1", role: "ADMIN", companyId: "company-1" });
    sequences.set("seq-1", { id: "seq-1", name: "Welcome Series", isActive: true, createdById: null, companyId: "company-1" });
    steps.set("step-1", { id: "step-1", sequenceId: "seq-1", subject: "Hi", body: "Hello", delayMinutes: 60, order: 0 });
    for (const id of ["lead-1", "lead-2", "lead-3"]) leads.set(id, { contactEmail: `${id}@example.com` });

    const { enrollLeads } = await import("../sequences");
    const result = await enrollLeads("seq-1", ["lead-1", "lead-2", "lead-3"]);

    expect(result).toEqual({ enrolled: 3, skipped: 0 });
    // Exactly one createMany call (not one per lead)...
    expect(fakePrismaClient.activity.createMany).toHaveBeenCalledTimes(1);
    // ...but it still produced one Activity row per enrolled lead.
    expect(activities).toHaveLength(3);
    expect(activities.every((a) => a.type === "SEQUENCE_ENROLLED")).toBe(true);
    expect(activities.map((a) => a.leadId).sort()).toEqual(["lead-1", "lead-2", "lead-3"]);
  });

  it("logs nothing when there is nothing new to enroll", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    accounts.set("admin-1", { id: "admin-1", role: "ADMIN", companyId: "company-1" });
    sequences.set("seq-1", { id: "seq-1", name: "Welcome Series", isActive: true, createdById: null, companyId: "company-1" });
    steps.set("step-1", { id: "step-1", sequenceId: "seq-1", subject: "Hi", body: "Hello", delayMinutes: 60, order: 0 });
    // No leads seeded — the visibility-filter query returns none, so
    // toEnroll is empty and the activity/enrollment writes must be skipped
    // entirely rather than calling createMany with an empty array.
    const { enrollLeads } = await import("../sequences");
    const result = await enrollLeads("seq-1", ["lead-not-visible"]);

    expect(result).toEqual({ enrolled: 0, skipped: 0 });
    expect(fakePrismaClient.activity.createMany).not.toHaveBeenCalled();
  });
});
