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
        return {
          id,
          contact: { primaryEmail: lead.contactEmail, emails: [] },
          assignedAgent: lead.noAgent ? null : { id: lead.agentId ?? "agent-1", fullName: "Agent One" },
        };
      });
    }),
  },
  activity: {
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      activities.push(...data);
      return { count: data.length };
    }),
  },
  // The interactive-transaction callback runs against this same fake; the advisory lock is recorded, not simulated.
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakePrismaClient)),
  $queryRaw: vi.fn(async () => []),
  sequenceEnrollment: {
    findMany: vi.fn(async () => []),
    createMany: vi.fn(async () => ({ count: 0 })),
    findUniqueOrThrow: vi.fn(async () => { throw new Error("not found"); }),
    findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      const row = enrollments.find((e) => e.id === id);
      return row ? { id: row.id, sequenceId: row.sequenceId ?? "seq-1", leadId: row.leadId, sequence: { name: "Test Sequence" } } : null;
    }),
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
    count: vi.fn(async ({ where }: { where: { enrollmentId: string; stepId: string; status: string } }) =>
      stepLogs.filter((l) => l.enrollmentId === where.enrollmentId && l.stepId === where.stepId && l.status === where.status).length
    ),
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
  sequenceId?: string;
  sequence: { name?: string; isActive?: boolean; steps: Array<{ id: string; subject: string; body: string; delayMinutes: number }> };
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
let sendEmailCalls: Array<{ to: string; html: string; subject: string; replyTo?: string; senderName?: string; accountId: string }>;
// Pass 35 — fixtures for enrollLeads' batched-activity-log test.
let leads: Map<string, { contactEmail: string | null; noAgent?: boolean; agentId?: string }>;
let activities: Array<Record<string, unknown>>;

let gmailReadiness: { ready: true; verified: boolean } | { ready: false; code: "NOT_CONNECTED" | "REAUTH_REQUIRED"; error: string };
const gmailChecks: string[] = [];
vi.mock("@/server/email/gmail-send", () => ({
  checkGmailSendReadiness: vi.fn(async (accountId: string) => {
    gmailChecks.push(accountId);
    return gmailReadiness;
  }),
}));
let enrolledRows: Array<{ sequenceId: string; leadId: string; status: string }>;
const defaultEnrollmentFindMany = async ({ where }: { where: { sequenceId?: string; leadId?: { in: string[] }; status?: string } }) =>
  enrolledRows.filter((r) => r.sequenceId === where.sequenceId && (where.leadId?.in ?? []).includes(r.leadId) && r.status === where.status).map((r) => ({ leadId: r.leadId }));
const defaultEnrollmentCreateMany = async ({ data }: { data: Array<{ sequenceId: string; leadId: string }> }) => {
  for (const d of data) enrolledRows.push({ sequenceId: d.sequenceId, leadId: d.leadId, status: "ACTIVE" });
  return { count: data.length };
};
vi.mock("@/lib/prisma", () => ({ prisma: fakePrismaClient }));
vi.mock("@/lib/company-config", () => ({ resolveBaseUrl: vi.fn(() => "https://example.com") }));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ id: "company-1", name: "Test Travel Co", brandColor: "#1c3a5e", logoEmailUrl: null, logoWebUrl: "", logoIconUrl: "", website: null, phone: null, signatureTemplate: "" })),
}));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (args: { to: string; html: string; subject: string; replyTo?: string; senderName?: string; accountId: string }) => {
    sendEmailCalls.push({ to: args.to, html: args.html, subject: args.subject, replyTo: args.replyTo, senderName: args.senderName, accountId: args.accountId });
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
  enrolledRows = [];
  gmailChecks.length = 0;
  gmailReadiness = { ready: true, verified: true };
  vi.clearAllMocks();
  fakePrismaClient.sequenceEnrollment.findMany = vi.fn(defaultEnrollmentFindMany);
  fakePrismaClient.sequenceEnrollment.createMany = vi.fn(defaultEnrollmentCreateMany);
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
  fakePrismaClient.sequenceEnrollment.findMany = vi.fn(async ({ where }: { where: { status: string; nextSendAt: { lte: Date }; sequence?: { isActive?: boolean } } }) =>
    enrollments
      .filter((row) => row.status === where.status && row.nextSendAt != null && row.nextSendAt.getTime() <= where.nextSendAt.lte.getTime())
      // a sequence with no explicit flag in a fixture counts as active, as every pre-existing fixture assumes
      .filter((row) => where.sequence?.isActive === undefined || (row.sequence.isActive ?? true) === where.sequence.isActive)
      .map((row) => ({ ...row }))
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
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
    const result = await processDueSequenceSteps();
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(sendEmailCalls).toHaveLength(1);
    expect(sendEmailCalls[0].to).toBe("andrew@example.com");
  });

  it("the automated send uses the sequence design: the agent as sender and reply-to, subtle branding, and this enrollment's own one-click unsubscribe link", async () => {
    seedDueEnrollment();
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
    await processDueSequenceSteps();
    expect(sendEmailCalls).toHaveLength(1);
    const call = sendEmailCalls[0];
    expect(call.replyTo).toBeTruthy();
    expect(call.senderName).toBeTruthy();
    expect(call.html).toContain("https://example.com/api/public/sequence-unsubscribe?enrollment=");
    expect(call.html).toContain("Unsubscribe");
    expect(call.html).toContain("following your travel enquiry");
    expect(call.html).not.toContain('class="ct-hero-title"');
    expect(call.html).not.toMatch(/Compass Tools|CRM|Business Flights/i);
  });

  it("two concurrent invocations processing the SAME due enrollment send exactly once, not twice", async () => {
    seedDueEnrollment();
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
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
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
    await processDueSequenceSteps();
    expect(e.currentStepIdx).toBe(1);
    expect(e.status).toBe("COMPLETED"); // only one step existed in the fixture
  });

  it("a worker's claim self-heals if it crashes before completing — the row becomes due again after the lease expires, not stuck forever", async () => {
    // Simulate a crashed worker: it claimed the row (nextSendAt pushed into
    // the future) but never got to update it to its real final value.
    const e = seedDueEnrollment({ nextSendAt: new Date(Date.now() + 2 * 60_000) }); // mid-lease
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
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
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
    const result = await processDueSequenceSteps();
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("a contact with no email on file fails closed (logged, not sent, never throws to a caller)", async () => {
    const base = seedDueEnrollment();
    enrollments.length = 0;
    seedDueEnrollment({ ...base, id: "enr-1", lead: { ...base.lead, contact: { firstName: "A", lastName: "B", primaryPhone: null, primaryEmail: null } } });
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
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
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");

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
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");

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

    expect(result).toEqual({
      enrolled: 3, skipped: 0, alreadyActive: 0, missingEmail: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0,
      byLead: { "lead-1": "enrolled", "lead-2": "enrolled", "lead-3": "enrolled" },
    });
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

    expect(result).toEqual({
      enrolled: 0, skipped: 0, alreadyActive: 0, missingEmail: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 1,
      byLead: { "lead-not-visible": "inaccessible" },
    });
    expect(fakePrismaClient.activity.createMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Sequence enrollment reliability: a failed enrollment must never look ACTIVE, must not block a retry, Gmail is checked BEFORE enrolling,
// and nothing sends after an unenroll.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function seedEnrollContext(leadIds: string[] = ["lead-1"], opts: { actor?: FakeAccount } = {}) {
  currentActor = opts.actor ?? { id: "admin-1", role: "ADMIN", companyId: "company-1" };
  accounts.set(currentActor.id, currentActor);
  sequences.set("seq-1", { id: "seq-1", name: "Welcome Series", isActive: true, createdById: null, companyId: "company-1" });
  steps.set("step-1", { id: "step-1", sequenceId: "seq-1", subject: "Hi", body: "Hello", delayMinutes: 60, order: 0 });
  for (const id of leadIds) leads.set(id, { contactEmail: `${id}@example.com` });
}

describe("enrollLeads — Gmail is checked before anything is enrolled", () => {
  it("enrolls normally when the sending account's Gmail is usable", async () => {
    seedEnrollContext();
    const { enrollLeads } = await import("../sequences");
    const r = await enrollLeads("seq-1", ["lead-1"]);
    expect(r).toMatchObject({ enrolled: 1, gmailUnavailable: 0 });
    expect(r.error).toBeUndefined();
    expect(enrolledRows).toEqual([{ sequenceId: "seq-1", leadId: "lead-1", status: "ACTIVE" }]);
    expect(gmailChecks).toEqual(["agent-1"]);
  });

  it("Gmail NOT connected: nothing is enrolled, no send is scheduled, a clear error is returned and the failed attempt is kept in the lead's history", async () => {
    seedEnrollContext();
    gmailReadiness = { ready: false, code: "NOT_CONNECTED", error: "x" };
    const { enrollLeads } = await import("../sequences");
    const r = await enrollLeads("seq-1", ["lead-1"]);
    expect(r.enrolled).toBe(0);
    expect(r.gmailUnavailable).toBe(1);
    expect(r.gmailProblem).toBe("NOT_CONNECTED");
    expect(r.error).toMatch(/Gmail is not connected/);
    expect(r.error).toMatch(/connect Gmail/i);
    expect(fakePrismaClient.sequenceEnrollment.createMany).not.toHaveBeenCalled();
    expect(enrolledRows).toHaveLength(0); // no false ACTIVE row
    expect(activities.map((a) => a.type)).toEqual(["SEQUENCE_ENROLL_FAILED"]);
    expect(String(activities[0].description)).toMatch(/Could not enroll/);
  });

  it("an expired/revoked authorization (REAUTH_REQUIRED) is refused the same way, with a reconnect message", async () => {
    seedEnrollContext();
    gmailReadiness = { ready: false, code: "REAUTH_REQUIRED", error: "x" };
    const { enrollLeads } = await import("../sequences");
    const r = await enrollLeads("seq-1", ["lead-1"]);
    expect(r).toMatchObject({ enrolled: 0, gmailUnavailable: 1, gmailProblem: "REAUTH_REQUIRED" });
    expect(r.error).toMatch(/reconnected/);
    expect(enrolledRows).toHaveLength(0);
  });

  it("the message names the sender when it is not the person enrolling", async () => {
    seedEnrollContext();
    gmailReadiness = { ready: false, code: "NOT_CONNECTED", error: "x" };
    const { enrollLeads } = await import("../sequences");
    const r = await enrollLeads("seq-1", ["lead-1"]);
    expect(r.gmailMessage).toMatch(/Agent One's Gmail/);
    expect(r.gmailMessage).toMatch(/Ask Agent One/);
  });

  it("after Gmail is reconnected the SAME lead can be enrolled again — the earlier failed attempt blocked nothing", async () => {
    seedEnrollContext();
    const { enrollLeads } = await import("../sequences");
    gmailReadiness = { ready: false, code: "NOT_CONNECTED", error: "x" };
    expect((await enrollLeads("seq-1", ["lead-1"])).enrolled).toBe(0);
    gmailReadiness = { ready: true, verified: true };
    const retry = await enrollLeads("seq-1", ["lead-1"]);
    expect(retry).toMatchObject({ enrolled: 1, alreadyActive: 0 });
    expect(enrolledRows.filter((r) => r.status === "ACTIVE")).toHaveLength(1);
    // the failed attempt is still in the history next to the successful enrollment
    expect(activities.map((a) => a.type)).toEqual(["SEQUENCE_ENROLL_FAILED", "SEQUENCE_ENROLLED"]);
  });

  it("only an ACTIVE enrollment blocks a new one: FAILED, UNSUBSCRIBED and COMPLETED rows do not", async () => {
    seedEnrollContext(["lead-1", "lead-2", "lead-3", "lead-4"]);
    enrolledRows.push(
      { sequenceId: "seq-1", leadId: "lead-1", status: "FAILED" },
      { sequenceId: "seq-1", leadId: "lead-2", status: "UNSUBSCRIBED" },
      { sequenceId: "seq-1", leadId: "lead-3", status: "COMPLETED" },
      { sequenceId: "seq-1", leadId: "lead-4", status: "ACTIVE" }
    );
    const { enrollLeads } = await import("../sequences");
    const r = await enrollLeads("seq-1", ["lead-1", "lead-2", "lead-3", "lead-4"]);
    expect(r).toMatchObject({ enrolled: 3, alreadyActive: 1, skipped: 1 });
    expect(enrolledRows.filter((x) => x.status === "ACTIVE").map((x) => x.leadId).sort()).toEqual(["lead-1", "lead-2", "lead-3", "lead-4"]);
  });

  it("a lead with no email, and a lead with no assigned agent, are refused and counted separately", async () => {
    seedEnrollContext(["lead-1", "lead-2", "lead-3"]);
    leads.set("lead-1", { contactEmail: null });
    leads.set("lead-2", { contactEmail: "x@example.com", noAgent: true });
    const { enrollLeads } = await import("../sequences");
    const r = await enrollLeads("seq-1", ["lead-1", "lead-2", "lead-3"]);
    expect(r).toMatchObject({ enrolled: 1, missingEmail: 1, noAssignedAgent: 1 });
    expect(enrolledRows.map((x) => x.leadId)).toEqual(["lead-3"]);
  });

  it("partial success: one agent's Gmail is down, another's is fine — only the reachable leads enroll, and the result says exactly that", async () => {
    seedEnrollContext(["lead-1", "lead-2"]);
    leads.set("lead-2", { contactEmail: "l2@example.com", agentId: "agent-2" });
    const { checkGmailSendReadiness } = await import("@/server/email/gmail-send");
    // one-shot implementations, in the order the agents are first met (lead-1's agent-1, then lead-2's agent-2), so nothing leaks into later tests
    const check = checkGmailSendReadiness as unknown as ReturnType<typeof vi.fn>;
    check.mockImplementationOnce(async () => ({ ready: true, verified: true }));
    check.mockImplementationOnce(async () => ({ ready: false, code: "NOT_CONNECTED", error: "x" }));
    const { enrollLeads } = await import("../sequences");
    const r = await enrollLeads("seq-1", ["lead-1", "lead-2"]);
    expect(r).toMatchObject({ enrolled: 1, gmailUnavailable: 1 });
    expect(r.error).toBeUndefined(); // something DID enroll, so this is partial success, not a failure
    expect(enrolledRows.map((x) => x.leadId)).toEqual(["lead-1"]);
  });

  it("Gmail is checked once per distinct sending account, not once per lead", async () => {
    seedEnrollContext(["lead-1", "lead-2", "lead-3"]);
    const { enrollLeads } = await import("../sequences");
    await enrollLeads("seq-1", ["lead-1", "lead-2", "lead-3"]);
    expect(gmailChecks).toEqual(["agent-1"]);
  });

  it("leads the caller cannot see are not enrolled and are counted as inaccessible", async () => {
    seedEnrollContext(["lead-1"]);
    const { enrollLeads } = await import("../sequences");
    const r = await enrollLeads("seq-1", ["lead-1", "lead-of-another-company"]);
    expect(r).toMatchObject({ enrolled: 1, inaccessible: 1 });
  });

  it("an invalid sequence id and an unauthorised role are both refused", async () => {
    seedEnrollContext();
    const { enrollLeads } = await import("../sequences");
    await expect(enrollLeads("no-such-sequence", ["lead-1"])).rejects.toThrow("Sequence not found");
    currentActor = { id: "tick-1", role: "TICKETING_AGENT", companyId: "company-1" };
    await expect(enrollLeads("seq-1", ["lead-1"])).rejects.toThrow("Sequence not found");
    expect(enrolledRows).toHaveLength(0);
  });
});

describe("enrollLeads — duplicates and races", () => {
  it("an ACTIVE enrollment that appears between the first check and the transaction (double click, two admins) is NOT duplicated", async () => {
    seedEnrollContext();
    // 1st lookup (before the transaction) sees nothing; the 2nd (inside the transaction, after the advisory lock) sees the other caller's row.
    const findMany = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ leadId: "lead-1" }]);
    fakePrismaClient.sequenceEnrollment.findMany = findMany;
    const { enrollLeads } = await import("../sequences");
    const r = await enrollLeads("seq-1", ["lead-1"]);
    expect(r).toMatchObject({ enrolled: 0, alreadyActive: 1, skipped: 1 });
    expect(fakePrismaClient.sequenceEnrollment.createMany).not.toHaveBeenCalled();
    expect(activities).toHaveLength(0);
  });

  it("each (sequence, lead) is locked inside the transaction, in sorted order, before it is checked or created", async () => {
    seedEnrollContext(["lead-c", "lead-a", "lead-b"]);
    const { enrollLeads } = await import("../sequences");
    await enrollLeads("seq-1", ["lead-c", "lead-a", "lead-b"]);
    expect(fakePrismaClient.$transaction).toHaveBeenCalledTimes(1);
    const lockArgs = (fakePrismaClient.$queryRaw as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.slice(1)[0]);
    expect(lockArgs).toEqual(["seq-1:lead-a", "seq-1:lead-b", "seq-1:lead-c"]);
  });

  it("a large selection is processed in bounded chunks of 100, never as one transaction", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `lead-${String(i).padStart(3, "0")}`);
    seedEnrollContext(ids);
    const { enrollLeads } = await import("../sequences");
    const r = await enrollLeads("seq-1", ids);
    expect(r.enrolled).toBe(250);
    expect(fakePrismaClient.$transaction).toHaveBeenCalledTimes(3);
    expect(fakePrismaClient.sequenceEnrollment.createMany).toHaveBeenCalledTimes(3);
  });

  it("the same lead id repeated in one request is enrolled once", async () => {
    seedEnrollContext();
    const { enrollLeads } = await import("../sequences");
    const r = await enrollLeads("seq-1", ["lead-1", "lead-1", "lead-1"]);
    expect(r.enrolled).toBe(1);
    expect(enrolledRows).toHaveLength(1);
  });
});

describe("processDueSequenceSteps — a failed send never advances the sequence", () => {
  const failWith = async (code: "NOT_CONNECTED" | "REAUTH_REQUIRED" | "SEND_FAILED") => {
    const mod = await import("@/server/email/service");
    (mod.sendEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: "boom", code });
  };

  it("Gmail NOT connected at send time: the enrollment becomes FAILED, stays on the same step, stops being due, and is logged", async () => {
    seedSequence("seq-1");
    const e = seedDueEnrollment({
      sequenceId: "seq-1",
      sequence: { name: "Welcome Series", steps: [{ id: "step-1", subject: "a", body: "b", delayMinutes: 60 }, { id: "step-2", subject: "c", body: "d", delayMinutes: 1440 }] },
    });
    await failWith("NOT_CONNECTED");
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
    const r = await processDueSequenceSteps();
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(e.status).toBe("FAILED");
    expect(e.currentStepIdx).toBe(0); // NOT advanced to "Step 2 of 2"
    expect(e.nextSendAt).toBeNull(); // nothing scheduled
    expect(stepLogs.map((l) => l.status)).toEqual(["FAILED"]);
    const again = await processDueSequenceSteps();
    expect(again.processed).toBe(0); // no repeated attempts while Gmail is unavailable
  });

  it("a revoked/expired authorization (REAUTH_REQUIRED) is treated the same way", async () => {
    const e = seedDueEnrollment();
    await failWith("REAUTH_REQUIRED");
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
    await processDueSequenceSteps();
    expect(e.status).toBe("FAILED");
  });

  it("a transient failure is retried on the SAME step with backoff, and after 3 attempts the enrollment is FAILED — bounded, no endless loop, step never skipped", async () => {
    const e = seedDueEnrollment({
      sequence: { name: "S", steps: [{ id: "step-1", subject: "a", body: "b", delayMinutes: 60 }, { id: "step-2", subject: "c", body: "d", delayMinutes: 60 }] },
    });
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
    const before = Date.now();

    await failWith("SEND_FAILED");
    await processDueSequenceSteps();
    expect(e.status).toBe("ACTIVE");
    expect(e.currentStepIdx).toBe(0);
    expect(e.nextSendAt!.getTime()).toBeGreaterThanOrEqual(before + 10 * 60_000 - 5_000);

    e.nextSendAt = new Date(Date.now() - 1000); // the backoff elapsed
    await failWith("SEND_FAILED");
    await processDueSequenceSteps();
    expect(e.status).toBe("ACTIVE");
    expect(e.currentStepIdx).toBe(0);
    expect(e.nextSendAt!.getTime()).toBeGreaterThanOrEqual(Date.now() + 60 * 60_000 - 5_000);

    e.nextSendAt = new Date(Date.now() - 1000);
    await failWith("SEND_FAILED");
    await processDueSequenceSteps();
    expect(e.status).toBe("FAILED");
    expect(e.currentStepIdx).toBe(0);
    expect(e.nextSendAt).toBeNull();
    expect(stepLogs.filter((l) => l.status === "FAILED")).toHaveLength(3);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("a failed first send followed by success after Gmail recovers advances normally", async () => {
    const e = seedDueEnrollment({
      sequence: { name: "S", steps: [{ id: "step-1", subject: "a", body: "b", delayMinutes: 60 }, { id: "step-2", subject: "c", body: "d", delayMinutes: 60 }] },
    });
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
    await failWith("SEND_FAILED");
    await processDueSequenceSteps();
    e.nextSendAt = new Date(Date.now() - 1000);
    const r = await processDueSequenceSteps();
    expect(r.sent).toBe(1);
    expect(e.currentStepIdx).toBe(1);
    expect(e.status).toBe("ACTIVE");
  });
});

describe("unenrollment and the sending worker", () => {
  it("unenrolling an ACTIVE enrollment stops it, clears the next send, and writes an audit entry", async () => {
    seedSequence("seq-1");
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    accounts.set("admin-1", currentActor);
    const e = seedDueEnrollment({ sequenceId: "seq-1", nextSendAt: new Date(Date.now() + 86_400_000) });
    const { unenrollLead } = await import("../sequences");
    const r = await unenrollLead(e.id, e.leadId);
    expect(r).toEqual({ ok: true });
    expect(e.status).toBe("UNSUBSCRIBED");
    expect(e.nextSendAt).toBeNull();
    const { logActivity } = await import("@/server/activity-log");
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ leadId: "lead-1", actorId: "admin-1", type: "SEQUENCE_UNENROLLED" }));
  });

  it("only an ACTIVE enrollment can be unenrolled: a COMPLETED/FAILED one is left exactly as it is", async () => {
    seedSequence("seq-1");
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    accounts.set("admin-1", currentActor);
    const done = seedDueEnrollment({ sequenceId: "seq-1", status: "COMPLETED", nextSendAt: null });
    const failed = seedDueEnrollment({ sequenceId: "seq-1", status: "FAILED", nextSendAt: null });
    const { unenrollLead } = await import("../sequences");
    expect(await unenrollLead(done.id)).toMatchObject({ ok: false });
    expect(await unenrollLead(failed.id)).toMatchObject({ ok: false });
    expect(done.status).toBe("COMPLETED");
    expect(failed.status).toBe("FAILED");
  });

  it("an enrollment that does not belong to the lead being viewed is refused with the generic not-found answer (no IDOR)", async () => {
    seedSequence("seq-1");
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    accounts.set("admin-1", currentActor);
    const e = seedDueEnrollment({ sequenceId: "seq-1" });
    const { unenrollLead } = await import("../sequences");
    await expect(unenrollLead(e.id, "some-other-lead")).rejects.toThrow("Sequence not found");
    expect(e.status).toBe("ACTIVE");
  });

  it("a role that may not manage sequences, and an agent who does not own the sequence, cannot unenroll", async () => {
    seedSequence("seq-1", { createdById: "owner-1" });
    accounts.set("owner-1", { id: "owner-1", role: "TRAVEL_AGENT", companyId: "company-1" });
    const e = seedDueEnrollment({ sequenceId: "seq-1" });
    const { unenrollLead } = await import("../sequences");
    currentActor = { id: "tick-1", role: "TICKETING_AGENT", companyId: "company-1" };
    await expect(unenrollLead(e.id)).rejects.toThrow("Sequence not found");
    currentActor = { id: "other-agent", role: "TRAVEL_AGENT", companyId: "company-1" };
    accounts.set("other-agent", currentActor);
    await expect(unenrollLead(e.id)).rejects.toThrow("Sequence not found");
    expect(e.status).toBe("ACTIVE");
  });

  it("a job that is already due cannot send once the enrollment has been unenrolled", async () => {
    seedSequence("seq-1");
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    accounts.set("admin-1", currentActor);
    const e = seedDueEnrollment({ sequenceId: "seq-1" });
    const { unenrollLead } = await import("../sequences");
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
    await unenrollLead(e.id);
    const r = await processDueSequenceSteps();
    expect(r.processed).toBe(0);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("RACE: unenrolled after the worker claimed the row but before it dispatches — the dispatch-time re-check stops the send", async () => {
    const e = seedDueEnrollment();
    const real = fakePrismaClient.sequenceEnrollment.updateMany;
    let calls = 0;
    fakePrismaClient.sequenceEnrollment.updateMany = vi.fn(async (args: Parameters<typeof real>[0]) => {
      const out = await real(args);
      calls++;
      if (calls === 1) e.status = "UNSUBSCRIBED"; // the claim just succeeded; a person unenrolls now
      return out;
    });
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
    const r = await processDueSequenceSteps();
    expect(sendEmailCalls).toHaveLength(0);
    expect(r.sent).toBe(0);
    expect(stepLogs).toHaveLength(0);
    expect(e.status).toBe("UNSUBSCRIBED");
  });

  it("RACE: unenrolled while the email is in flight — the sent email is kept, but the enrollment is not resurrected or turned into COMPLETED", async () => {
    const e = seedDueEnrollment();
    const mod = await import("@/server/email/service");
    (mod.sendEmail as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      e.status = "UNSUBSCRIBED"; // unenrolled while Gmail is sending
      return { ok: true as const, messageId: "m-inflight" };
    });
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
    const r = await processDueSequenceSteps();
    expect(r.sent).toBe(1);
    expect(stepLogs.map((l) => l.status)).toEqual(["SENT"]); // already-sent mail stays in history
    expect(e.status).toBe("UNSUBSCRIBED"); // previously this single-step sequence flipped to COMPLETED
  });
});

describe("enrollLeads - first send is scheduled from the FIRST step's delay", () => {
  it("each new enrollment starts at step 0 with nextSendAt = now + the first step's delay, and the enrolling user", async () => {
    seedEnrollContext(["lead-1", "lead-2"]);
    steps.set("step-1", { id: "step-1", sequenceId: "seq-1", subject: "Hi", body: "Hello", delayMinutes: 90, order: 0 });
    steps.set("step-2", { id: "step-2", sequenceId: "seq-1", subject: "Later", body: "Again", delayMinutes: 5000, order: 1 });
    const before = Date.now();
    const { enrollLeads } = await import("../sequences");
    await enrollLeads("seq-1", ["lead-1", "lead-2"]);
    const after = Date.now();

    const calls = (fakePrismaClient.sequenceEnrollment.createMany as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const rows = calls[0][0].data as Array<{ leadId: string; nextSendAt: Date; recipientEmail?: string; enrolledById?: string }>;
    expect(rows.map((r) => r.leadId).sort()).toEqual(["lead-1", "lead-2"]);
    for (const r of rows) {
      // The SECOND step's 5000-minute delay is not used for the first send.
      expect(r.nextSendAt.getTime()).toBeGreaterThanOrEqual(before + 90 * 60_000);
      expect(r.nextSendAt.getTime()).toBeLessThanOrEqual(after + 90 * 60_000);
      expect(r.recipientEmail).toBeUndefined(); // only snapshotted when a recipient was explicitly requested
      expect(r.enrolledById).toBe("admin-1");
    }
  });
});

describe("the sequence's Active/Inactive switch", () => {
  it("an enrollment whose sequence is Inactive is not sent, is left untouched, and is sent as soon as the sequence is switched back on", async () => {
    const e = seedDueEnrollment();
    e.sequence.isActive = false;
    const dueAt = e.nextSendAt!.getTime();
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");

    const off = await processDueSequenceSteps();
    expect(off.sent).toBe(0);
    expect(sendEmailCalls).toHaveLength(0);
    expect(e.status).toBe("ACTIVE"); // not failed, not completed, not unenrolled
    expect(e.currentStepIdx).toBe(0);
    expect(e.nextSendAt!.getTime()).toBe(dueAt); // not claimed, not rescheduled

    e.sequence.isActive = true;
    const on = await processDueSequenceSteps();
    expect(on.sent).toBe(1);
    expect(sendEmailCalls).toHaveLength(1);
  });

  it("an Active sequence's due enrollments are unaffected (the flag defaults to active)", async () => {
    seedDueEnrollment();
    const { runDueSequenceSteps: processDueSequenceSteps } = await import("@/server/due-sequence-steps");
    expect((await processDueSequenceSteps()).sent).toBe(1);
  });

  it("enrollLeads refuses an Inactive sequence before looking at any lead, Gmail or database row, and creates nothing", async () => {
    seedEnrollContext(["lead-1"]);
    sequences.get("seq-1")!.isActive = false;
    const { enrollLeads } = await import("../sequences");
    const r = await enrollLeads("seq-1", ["lead-1"]);
    expect(r.enrolled).toBe(0);
    expect(r.error).toMatch(/inactive/i);
    expect(r.byLead).toEqual({});
    expect(fakePrismaClient.sequenceEnrollment.createMany).not.toHaveBeenCalled();
    expect(activities).toHaveLength(0);
    expect(gmailChecks).toHaveLength(0);
  });
});
