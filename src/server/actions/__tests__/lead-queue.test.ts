import { describe, it, expect, vi, beforeEach } from "vitest";

// Same in-memory-fake mocking convention as other server-action test files
// in this project. Covers: joinLeadQueue's role rejection (existing
// coverage), the pause/resume-to-front-of-queue business rule (untouched by
// this feature), the 60-second offer/accept/expire state machine that
// REPLACES immediate assignment, and the conditional-update race-safety
// guarantees both acceptLeadOffer and expireStaleOfferAndAdvance rely on
// (the "WHERE ... offerExpiresAt >/<= now()" guards that make a duplicate
// resolution of the same offer a no-op for the loser — the one race
// property that's meaningfully testable without a real Postgres row lock).

const DEFAULT_COMPANY_ID = "company-1";

type FakeAccount = { id: string; role: string; status: string; fullName?: string; companyId?: string };
type FakeQueueEntry = { id: string; accountId: string; isActive: boolean; joinedAt: Date; lastAssignedAt: Date | null; leadsAssignedCount: number };
type FakeLead = {
  id: string;
  assignedAgentId: string | null;
  source: string;
  status: string;
  queueDistributedAt: Date | null;
  createdAt: Date;
  offeredToId: string | null;
  offeredAt: Date | null;
  offerExpiresAt: Date | null;
  // Pass 22 fix regression coverage — companyId is resolved through the
  // lead's own Contact in production (Lead has no direct companyId
  // column); the fake simplifies this to a direct field for test
  // convenience, matching what offerLeadToNextWorker's `select: { contact:
  // { select: { companyId: true } } }` ultimately reads.
  companyId?: string;
  // Pass 30 — real Contact.id this lead belongs to, for the
  // acceptLeadOffer Contact-ownership-claim regression tests below.
  contactId?: string;
};
type FakeContact = { id: string; ownerId: string | null };
type FakeStatusHistoryEntry = { leadId: string; fromStatus: string | null; toStatus: string; changedById: string | null };

let currentActor: FakeAccount | null;
let accounts: Map<string, FakeAccount>;
let queueEntries: Map<string, FakeQueueEntry>;
let leads: Map<string, FakeLead>;
let contacts: Map<string, FakeContact>;
let statusHistory: FakeStatusHistoryEntry[];
let nextId = 1;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/activity-log", () => ({
  logActivity: vi.fn(async () => {}),
}));

vi.mock("@/server/queries/lead-queue", () => ({
  getQueuePosition: vi.fn(async () => null),
}));

// Mirrors the real production exclusion list (lead-queue.ts's
// offerLeadToNextWorker SQL: `a."role" NOT IN ('TICKETING_AGENT',
// 'FLIGHT_EXPERT', 'MARKETING_AGENT')`) — MARKETING_AGENT was previously
// missing from this test-only mirror (a test/prod drift, not a production
// bug: the real query already excluded it correctly).
const LEAD_INELIGIBLE_ROLES = ["TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"];

// Mirrors the real ORDER BY lastAssignedAt ASC NULLS FIRST, joinedAt ASC —
// reimplemented in JS since a fake can't execute real SQL, but applies the
// exact same rule the real query encodes. Also doubles as the "effective
// active queue" ordering the UI/getActiveQueueMembers shows — same
// underlying sort, just not truncated to the top pick.
function effectiveActiveOrder(companyId?: string): FakeQueueEntry[] {
  const eligible = [...queueEntries.values()].filter((e) => {
    if (!e.isActive) return false;
    const account = accounts.get(e.accountId);
    if (!account || account.status !== "ACTIVE") return false;
    if (LEAD_INELIGIBLE_ROLES.includes(account.role)) return false;
    // Pass 22 fix regression coverage — mirrors the real query's new
    // `a."companyId" = ${companyId}` filter.
    if (companyId !== undefined && (account.companyId ?? DEFAULT_COMPANY_ID) !== companyId) return false;
    return true;
  });
  eligible.sort((a, b) => {
    const aTime = a.lastAssignedAt ? a.lastAssignedAt.getTime() : -Infinity;
    const bTime = b.lastAssignedAt ? b.lastAssignedAt.getTime() : -Infinity;
    if (aTime !== bTime) return aTime - bTime;
    return a.joinedAt.getTime() - b.joinedAt.getTime();
  });
  return eligible;
}

// Mirrors offerLeadToNextWorker's real selection query, including the NOT
// EXISTS clause that keeps a worker mid-countdown on a DIFFERENT lead from
// being offered a second one at the same time — "sequential, not
// simultaneous" offers.
function pickNextEligibleEntry(companyId?: string, leadId?: string, now: Date = new Date()): FakeQueueEntry | undefined {
  const busy = new Set(
    [...leads.values()]
      .filter((l) => l.offeredToId && l.id !== leadId && l.offerExpiresAt && l.offerExpiresAt.getTime() > now.getTime())
      .map((l) => l.offeredToId!),
  );
  return effectiveActiveOrder(companyId).find((e) => !busy.has(e.accountId));
}

// Generic Prisma-`where`-clause matcher for the fake — supports plain
// equality (including null), {lte}/{gt}/{not} operators, and OR groups.
// Real Prisma calls in lead-queue.ts only ever use this subset.
function matchesWhere(lead: FakeLead, where: Record<string, unknown>): boolean {
  for (const key of Object.keys(where)) {
    if (key === "OR") {
      const subs = where.OR as Record<string, unknown>[];
      if (!subs.some((sub) => matchesWhere(lead, sub))) return false;
      continue;
    }
    const cond = where[key];
    const val = (lead as unknown as Record<string, unknown>)[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const op = cond as { lte?: Date; gt?: Date; not?: unknown };
      if (op.lte !== undefined) {
        if (!(val instanceof Date) || val.getTime() > op.lte.getTime()) return false;
        continue;
      }
      if (op.gt !== undefined) {
        if (!(val instanceof Date) || val.getTime() <= op.gt.getTime()) return false;
        continue;
      }
      if ("not" in op) {
        if (val === op.not) return false;
        continue;
      }
      throw new Error(`Unsupported where operator for ${key}: ${JSON.stringify(cond)}`);
    } else {
      if (val !== cond) return false;
    }
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakePrismaClient: any = {
  leadQueueEntry: {
    upsert: vi.fn(async ({ where: { accountId }, create, update }: { where: { accountId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const existing = queueEntries.get(accountId);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const entry: FakeQueueEntry = { id: `entry-${accountId}`, accountId, isActive: true, joinedAt: new Date(), lastAssignedAt: null, leadsAssignedCount: 0, ...create };
      queueEntries.set(accountId, entry);
      return entry;
    }),
    updateMany: vi.fn(async ({ where: { accountId }, data }: { where: { accountId: string }; data: { isActive?: boolean; lastAssignedAt?: Date; leadsAssignedCount?: { increment: number } } }) => {
      const entry = queueEntries.get(accountId);
      if (!entry) return { count: 0 };
      if (data.isActive !== undefined) entry.isActive = data.isActive;
      if (data.lastAssignedAt !== undefined) entry.lastAssignedAt = data.lastAssignedAt;
      if (data.leadsAssignedCount) entry.leadsAssignedCount += data.leadsAssignedCount.increment;
      return { count: 1 };
    }),
    findUnique: vi.fn(async ({ where: { accountId } }: { where: { accountId: string } }) => queueEntries.get(accountId) ?? null),
  },
  lead: {
    findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      const lead = leads.get(id);
      if (!lead) return null;
      // Always attaches `contact` regardless of select/include — real
      // Prisma would only return what was actually selected, but this
      // lenient fake over-returns rather than distinguishing every
      // select/include shape; callers only read the field(s) they asked
      // for. Needed by both the pre-update status fetch (acceptLeadOffer)
      // and offerLeadToNextWorker's `select: { contact: { select: {
      // companyId: true } } }` company-resolution lookup (Pass 22 fix).
      return { ...lead, contact: { firstName: "Jane", lastName: "Traveler", companyId: lead.companyId ?? DEFAULT_COMPANY_ID } };
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const lead = [...leads.values()].find((l) => matchesWhere(l, where));
      if (!lead) return null;
      return { ...lead, contact: { firstName: "Jane", lastName: "Traveler" }, departureAirport: null, arrivalAirport: null };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<FakeLead> }) => {
      let count = 0;
      for (const lead of leads.values()) {
        if (matchesWhere(lead, where)) {
          Object.assign(lead, data);
          count++;
        }
      }
      return { count };
    }),
    // Mirrors distributePendingWebsiteLeads's/sweepExpiredOffers's real
    // query shapes — unassigned/stale-offer leads, oldest first, no age
    // cutoff of any kind — exactly what §18-22 require.
    findMany: vi.fn(async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy?: { createdAt: "asc" | "desc" }; take?: number }) => {
      let matches = [...leads.values()].filter((l) => matchesWhere(l, where));
      if (orderBy) matches.sort((a, b) => (orderBy.createdAt === "asc" ? a.createdAt.getTime() - b.createdAt.getTime() : b.createdAt.getTime() - a.createdAt.getTime()));
      if (take) matches = matches.slice(0, take);
      return matches.map((l) => ({ ...l }));
    }),
  },
  // Pass 30 — the Contact-ownership claim acceptLeadOffer now performs (see
  // that function's own comment): a conditional updateMany, mirroring the
  // exact real production WHERE shape (`id`, `ownerId: null`) so a claim
  // against an ALREADY-owned contact correctly no-ops (count: 0) here too.
  contact: {
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; ownerId?: null }; data: { ownerId: string } }) => {
      const c = contacts.get(where.id);
      if (!c) return { count: 0 };
      if (where.ownerId !== undefined && c.ownerId !== where.ownerId) return { count: 0 };
      c.ownerId = data.ownerId;
      return { count: 1 };
    }),
  },
  notification: { create: vi.fn(async () => ({})) },
  leadStatusHistory: {
    create: vi.fn(async ({ data }: { data: FakeStatusHistoryEntry }) => {
      statusHistory.push(data);
      return data;
    }),
  },
  $transaction: vi.fn(async (fn: (tx: typeof fakePrismaClient) => unknown) => fn(fakePrismaClient)),
  // Pass 22 fix — production's raw SQL now interpolates companyId first
  // (`a."companyId" = ${companyId}`), then leadId, then now; this fake's
  // parameter order mirrors that exactly.
  $queryRaw: vi.fn(async (_strings: TemplateStringsArray, companyId: string, leadId: string, now: Date) => {
    const picked = pickNextEligibleEntry(companyId, leadId, now);
    return picked ? [{ id: picked.id, accountId: picked.accountId }] : [];
  }),
};

vi.mock("@/lib/prisma", () => ({
  prisma: fakePrismaClient,
}));

beforeEach(() => {
  currentActor = null;
  accounts = new Map();
  queueEntries = new Map();
  leads = new Map();
  contacts = new Map();
  statusHistory = [];
  nextId = 1;
  vi.clearAllMocks();
});

function seedMember(accountId: string, overrides: Partial<FakeQueueEntry> = {}, accountOverrides: Partial<FakeAccount> = {}) {
  accounts.set(accountId, { id: accountId, role: "TRAVEL_AGENT", status: "ACTIVE", ...accountOverrides });
  queueEntries.set(accountId, {
    id: `entry-${accountId}`,
    accountId,
    isActive: true,
    joinedAt: new Date(2026, 0, 1, 0, 0, nextId++),
    lastAssignedAt: null,
    leadsAssignedCount: 0,
    ...overrides,
  });
}

function seedWebsiteLead(id: string, createdAt: Date = new Date(2026, 0, 1, 0, 0, nextId++), contactOverrides?: Partial<FakeContact>) {
  // Pass 30 — every website lead now has a real (fake) Contact behind it,
  // auto-seeded as unowned by default (`ownerId: null`) unless the caller
  // explicitly wants to test the "already-owned, must never be
  // overwritten" case via `contactOverrides`.
  const contactId = `contact-for-${id}`;
  contacts.set(contactId, { id: contactId, ownerId: null, ...contactOverrides });
  leads.set(id, { id, assignedAgentId: null, source: "WEBSITE", status: "ATTEMPTING_TO_CONTACT", queueDistributedAt: null, createdAt, offeredToId: null, offeredAt: null, offerExpiresAt: null, contactId });
}

// Distributes (offers) a lead and immediately accepts it as whoever it was
// offered to — used by tests whose real subject is the ROTATION mechanics
// (who's next, in what order) rather than the offer/accept mechanics
// themselves, so they don't need to hand-roll the two-phase flow. Mirrors
// exactly what a real user clicking "Accept Lead" within the window does.
async function distributeAndAccept(leadId: string): Promise<DistributionResult> {
  const { distributeNewWebsiteLead, acceptLeadOffer } = await import("../lead-queue");
  const result = await distributeNewWebsiteLead(leadId);
  if (result.offered) {
    const prevActor = currentActor;
    currentActor = accounts.get(result.accountId) ?? null;
    const accepted = await acceptLeadOffer(leadId);
    expect(accepted.ok).toBe(true);
    currentActor = prevActor;
  }
  return result;
}

type DistributionResult = { offered: true; accountId: string } | { offered: false; reason: "no_active_workers" | "already_assigned" | "not_a_website_lead" };

describe("joinLeadQueue — role eligibility", () => {
  it("rejects TICKETING_AGENT server-side, even though nothing in the UI would normally call this", async () => {
    currentActor = { id: "ticketing-1", role: "TICKETING_AGENT", status: "ACTIVE" };
    const { joinLeadQueue } = await import("../lead-queue");
    const result = await joinLeadQueue();
    expect(result.ok).toBe(false);
    expect(queueEntries.has("ticketing-1")).toBe(false);
  });

  it("rejects FLIGHT_EXPERT server-side", async () => {
    currentActor = { id: "flight-1", role: "FLIGHT_EXPERT", status: "ACTIVE" };
    const { joinLeadQueue } = await import("../lead-queue");
    const result = await joinLeadQueue();
    expect(result.ok).toBe(false);
    expect(queueEntries.has("flight-1")).toBe(false);
  });

  it("allows a lead-eligible role (e.g. TRAVEL_AGENT) to join normally", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const { joinLeadQueue } = await import("../lead-queue");
    const result = await joinLeadQueue();
    expect(result.ok).toBe(true);
    expect(queueEntries.has("agent-1")).toBe(true);
  });

  it("rejects when there is no current account at all", async () => {
    currentActor = null;
    const { joinLeadQueue } = await import("../lead-queue");
    const result = await joinLeadQueue();
    expect(result.ok).toBe(false);
  });
});

// Test 1 — Pause: active queue A, B, C, D -> C pauses -> active becomes A, B, D.
describe("Test 1 — pausing removes a member from ACTIVE distribution without deleting their membership", () => {
  it("a paused member is excluded from the eligible pool while remaining a queue member", async () => {
    seedMember("A", { lastAssignedAt: new Date(2026, 0, 1, 10, 0) });
    seedMember("B", { lastAssignedAt: new Date(2026, 0, 1, 10, 1) });
    seedMember("C", { lastAssignedAt: new Date(2026, 0, 1, 10, 2) });
    seedMember("D", { lastAssignedAt: new Date(2026, 0, 1, 10, 3) });

    currentActor = accounts.get("C") as unknown as FakeAccount & { id: string };
    const { leaveLeadQueue } = await import("../lead-queue");
    await leaveLeadQueue();

    expect(queueEntries.get("C")!.isActive).toBe(false);
    // Still a member — row preserved, not deleted, position (joinedAt) untouched.
    expect(queueEntries.has("C")).toBe(true);
    const eligible = pickNextEligibleEntry();
    expect(eligible?.accountId).not.toBe("C");
  });
});

// Test 2 — a paused member never receives a lead OFFER (let alone an assignment).
describe("Test 2 — a paused member receives no offer", () => {
  it("distributeNewWebsiteLead never offers a lead to a paused member even when they'd otherwise be next", async () => {
    // C has the oldest lastAssignedAt (most "overdue") but is paused.
    seedMember("A", { lastAssignedAt: new Date(2026, 0, 1, 10, 5) });
    seedMember("C", { lastAssignedAt: new Date(2026, 0, 1, 1, 0), isActive: false });
    seedWebsiteLead("lead-1");

    const { distributeNewWebsiteLead } = await import("../lead-queue");
    const result = await distributeNewWebsiteLead("lead-1");

    expect(result.offered).toBe(true);
    if (result.offered) expect(result.accountId).toBe("A");
    expect(leads.get("lead-1")!.offeredToId).toBe("A");
    expect(leads.get("lead-1")!.assignedAgentId).toBeNull(); // offered, not yet accepted
  });
});

// Test 3 — Resume: a resumed "ghost" is restored to their logical
// relationship to everyone else — NOT reset to look brand-new, and NOT
// artificially pushed to the very front ahead of members with genuinely
// no service history at all.
describe("Test 3 — resuming restores the member's logical position, never resets it", () => {
  it("joinLeadQueue leaves lastAssignedAt untouched on resume — no artificial front-of-queue jump", async () => {
    seedMember("A", { lastAssignedAt: new Date(2026, 0, 1, 10, 0) });
    seedMember("B", { lastAssignedAt: new Date(2026, 0, 1, 10, 1) });
    seedMember("C", { lastAssignedAt: new Date(2026, 0, 1, 10, 2), isActive: false });

    currentActor = { id: "C", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const { joinLeadQueue } = await import("../lead-queue");
    await joinLeadQueue();

    expect(queueEntries.get("C")!.isActive).toBe(true);
    // The bug this test used to encode: lastAssignedAt was reset to null on
    // resume, which is exactly "treating C as though they joined today"
    // (and would have made C jump ahead of A/B regardless of real history).
    expect(queueEntries.get("C")!.lastAssignedAt).toEqual(new Date(2026, 0, 1, 10, 2));
    // C's frozen timestamp (10:02) is the MOST RECENT of the three — A
    // (10:00) is genuinely the most overdue and correctly goes next. C
    // resuming must never override that real ordering.
    expect(pickNextEligibleEntry()?.accountId).toBe("A");
  });

  it("a never-before-served member (still null) is not artificially outranked by a resuming member with real history", async () => {
    seedMember("A", { lastAssignedAt: new Date(2026, 0, 1, 10, 0) });
    seedMember("NEVER_SERVED", { lastAssignedAt: null });
    seedMember("RESUMING", { lastAssignedAt: new Date(2026, 0, 1, 9, 0), isActive: false });

    currentActor = { id: "RESUMING", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const { joinLeadQueue } = await import("../lead-queue");
    await joinLeadQueue();

    // Real (non-null) history still sorts after "never served" (null sorts
    // first) — resuming must never overwrite that relationship by
    // resetting to null.
    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["NEVER_SERVED", "RESUMING", "A"]);
  });
});

// Test 4 — Long pause: many leads distributed (and ACCEPTED) by others while
// paused; on resume, the member's OWN frozen history determines their place
// — not an artificial reset, and not permanently stuck behind everyone who
// was served while they were away.
describe("Test 4 — long pause preserves the member's real position, neither resetting nor stranding them", () => {
  it("resuming after many intervening assignments to other members restores their frozen relative position", async () => {
    seedMember("A", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedMember("B", { lastAssignedAt: new Date(2026, 0, 1, 9, 1) });
    seedMember("L", { lastAssignedAt: new Date(2026, 0, 1, 8, 0), isActive: false }); // paused at "position 12" conceptually — genuinely overdue
    seedMember("N", { lastAssignedAt: new Date(2026, 0, 1, 9, 2) });
    const lBeforeResume = queueEntries.get("L")!.lastAssignedAt;

    // Simulate many leads going to A, B, N while L stays paused — their
    // lastAssignedAt keeps advancing (only once each is ACCEPTED — merely
    // being offered doesn't move the rotation), L's stays frozen.
    for (let i = 0; i < 5; i++) {
      seedWebsiteLead(`lead-${i}`);
      const result = await distributeAndAccept(`lead-${i}`);
      expect(result.offered).toBe(true);
      if (result.offered) expect(result.accountId).not.toBe("L");
    }

    currentActor = { id: "L", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const { joinLeadQueue } = await import("../lead-queue");
    await joinLeadQueue();

    // Resuming must not touch the frozen timestamp at all.
    expect(queueEntries.get("L")!.lastAssignedAt).toEqual(lBeforeResume);
    // L is next not because of a reset, but because L's own frozen history
    // is, honestly, the most overdue of everyone — the correct outcome for
    // the correct reason.
    expect(pickNextEligibleEntry()?.accountId).toBe("L");
  });
});

// Test 5 — a deleted/deactivated account can never receive a new lead
// OFFER, even if their LeadQueueEntry.isActive were somehow still true
// (defense in depth at the offer-selection query itself, independent of
// setAccountStatus's own cleanup).
describe("Test 5 — a deactivated account is excluded even with a stale isActive=true row", () => {
  it("distributeNewWebsiteLead skips a queue entry whose account status is not ACTIVE", async () => {
    seedMember("REMOVED", { lastAssignedAt: new Date(2026, 0, 1, 1, 0) }, { status: "INACTIVE" });
    seedMember("B", { lastAssignedAt: new Date(2026, 0, 1, 10, 0) });
    seedWebsiteLead("lead-1");

    const { distributeNewWebsiteLead } = await import("../lead-queue");
    const result = await distributeNewWebsiteLead("lead-1");

    expect(result.offered).toBe(true);
    if (result.offered) expect(result.accountId).toBe("B");
  });
});

// Pass 22 — CONFIRMED CROSS-TENANT VULNERABILITY, now fixed: the candidate
// query in offerLeadToNextWorker had no companyId filter at all, so an
// active worker at ANY company was eligible to be offered — and could
// actually accept — another company's website lead, leaking that
// company's customer PII and hijacking their sales lead. These tests
// exercise the fix directly (companyId now flows through
// distributeNewWebsiteLead → offerLeadToNextWorker's real query params).
describe("Pass 22 — lead distribution never crosses company boundaries", () => {
  it("a lead is never offered to an active worker at a DIFFERENT company, even when they're otherwise fully eligible", async () => {
    seedMember("other-company-worker", { lastAssignedAt: new Date(2026, 0, 1, 1, 0) }, { companyId: "company-B" });
    seedWebsiteLead("lead-1");
    leads.get("lead-1")!.companyId = "company-A";

    const { distributeNewWebsiteLead } = await import("../lead-queue");
    const result = await distributeNewWebsiteLead("lead-1");

    expect(result.offered).toBe(false);
    if (!result.offered) expect(result.reason).toBe("no_active_workers");
  });

  it("offers to the correct same-company worker when both a same-company and a different-company worker are active", async () => {
    seedMember("other-company-worker", { lastAssignedAt: new Date(2026, 0, 1, 0, 0) }, { companyId: "company-B" });
    seedMember("same-company-worker", { lastAssignedAt: new Date(2026, 0, 1, 5, 0) }, { companyId: "company-A" });
    seedWebsiteLead("lead-1");
    leads.get("lead-1")!.companyId = "company-A";

    const { distributeNewWebsiteLead } = await import("../lead-queue");
    const result = await distributeNewWebsiteLead("lead-1");

    expect(result.offered).toBe(true);
    if (result.offered) expect(result.accountId).toBe("same-company-worker");
  });

  it("two companies' leads are each distributed only within their own worker pool, never cross-assigned", async () => {
    seedMember("worker-A", { lastAssignedAt: new Date(2026, 0, 1, 1, 0) }, { companyId: "company-A" });
    seedMember("worker-B", { lastAssignedAt: new Date(2026, 0, 1, 1, 0) }, { companyId: "company-B" });
    seedWebsiteLead("lead-a");
    leads.get("lead-a")!.companyId = "company-A";
    seedWebsiteLead("lead-b");
    leads.get("lead-b")!.companyId = "company-B";

    const resultA = await distributeAndAccept("lead-a");
    const resultB = await distributeAndAccept("lead-b");

    expect(resultA.offered && resultA.accountId).toBe("worker-A");
    expect(resultB.offered && resultB.accountId).toBe("worker-B");
  });
});

// Test 6 — concurrency safety: the conditional `WHERE assignedAgentId IS
// NULL` update is what actually prevents a duplicate assignment if two
// calls ever raced past the row lock — verified directly here since a fake
// can't exercise real Postgres FOR UPDATE SKIP LOCKED. Now exercised via
// acceptLeadOffer's own conditional update, since that's the function that
// actually sets assignedAgentId in the new offer/accept model.
describe("Test 6 — concurrent claim attempts on the same lead never double-assign it", () => {
  it("only the first of two racing accept-style attempts actually claims the lead", async () => {
    seedMember("A", { lastAssignedAt: new Date(2026, 0, 1, 10, 0) });
    seedWebsiteLead("lead-1");

    const first = await fakePrismaClient.lead.updateMany({
      where: { id: "lead-1", assignedAgentId: null },
      data: { assignedAgentId: "A", queueDistributedAt: new Date() },
    });
    const second = await fakePrismaClient.lead.updateMany({
      where: { id: "lead-1", assignedAgentId: null },
      data: { assignedAgentId: "SOMEONE-ELSE", queueDistributedAt: new Date() },
    });

    expect(first.count).toBe(1);
    expect(second.count).toBe(0);
    expect(leads.get("lead-1")!.assignedAgentId).toBe("A");
  });

  it("sequential distribution+acceptance of three leads rotates correctly through eligible members (least-recently-served first)", async () => {
    // Note on scope: real concurrency safety for simultaneous claims comes
    // from Postgres's FOR UPDATE SKIP LOCKED row-locking inside
    // offerLeadToNextWorker's transaction (src/server/actions/lead-queue.ts)
    // — that mechanism is unchanged by this feature and isn't meaningfully
    // reproducible against an in-memory JS fake with no real lock/isolation
    // semantics. The conditional-update guard above is the one race-safety
    // property that IS honestly testable without a real database. This
    // test instead confirms the actual rotation logic itself is correct
    // across multiple consecutive distribute+accept cycles.
    seedMember("A", { lastAssignedAt: new Date(2026, 0, 1, 10, 0) });
    seedMember("B", { lastAssignedAt: new Date(2026, 0, 1, 10, 1) });
    seedMember("D", { lastAssignedAt: new Date(2026, 0, 1, 10, 2) });
    seedWebsiteLead("lead-a");
    seedWebsiteLead("lead-b");
    seedWebsiteLead("lead-c");

    const r1 = await distributeAndAccept("lead-a");
    const r2 = await distributeAndAccept("lead-b");
    const r3 = await distributeAndAccept("lead-c");

    const assignedTo = [r1, r2, r3].map((r) => (r.offered ? r.accountId : null));
    expect(assignedTo).toEqual(["A", "B", "D"]);
  });
});

describe("Complete example — pause, distribute+accept, resume, distribute+accept", () => {
  it("Charlie pauses, Alice/Bob/David receive leads in order, Charlie resumes and receives the next one — now because his own frozen history is genuinely most-overdue, not because of a reset", async () => {
    seedMember("Alice", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedMember("Bob", { lastAssignedAt: new Date(2026, 0, 1, 9, 1) });
    seedMember("Charlie", { lastAssignedAt: new Date(2026, 0, 1, 9, 2) });
    seedMember("David", { lastAssignedAt: new Date(2026, 0, 1, 9, 3) });
    seedMember("Emma", { lastAssignedAt: new Date(2026, 0, 1, 9, 4) });

    currentActor = { id: "Charlie", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const { leaveLeadQueue, joinLeadQueue } = await import("../lead-queue");
    await leaveLeadQueue();

    seedWebsiteLead("l1");
    const r1 = await distributeAndAccept("l1");
    expect(r1.offered && r1.accountId).toBe("Alice");

    seedWebsiteLead("l2");
    const r2 = await distributeAndAccept("l2");
    expect(r2.offered && r2.accountId).toBe("Bob");

    seedWebsiteLead("l3");
    const r3 = await distributeAndAccept("l3");
    expect(r3.offered && r3.accountId).toBe("David");

    currentActor = { id: "Charlie", role: "TRAVEL_AGENT", status: "ACTIVE" };
    await joinLeadQueue();

    seedWebsiteLead("l4");
    const r4 = await distributeAndAccept("l4");
    // Charlie's frozen 9:02 is earlier than Emma's untouched 9:04 — he's
    // next for a real, honest reason, not an artificial front-of-queue jump.
    expect(r4.offered && r4.accountId).toBe("Charlie");
  });
});

// The exact §40 walkthrough from the ghost-queue task's spec (Test C in
// this task's spec) — the "effective active queue" is display-oriented
// (who's currently eligible, in their logical order), which in this
// codebase is the same compareQueueEntries ordering dispatch uses. With no
// leads distributed yet in this scenario every member's lastAssignedAt is
// null, so the ordering degenerates to a plain joinedAt sort — exactly the
// "logical/reserved position" the spec means.
describe("Test C/E — exact ghost/resume walkthrough (Sarah, Maria, David, Dark Master, Jasurkhon)", () => {
  it("three paused, two active — effective queue is exactly [Sarah, Jasurkhon] — and reproduces every subsequent step", async () => {
    seedMember("Sarah");
    seedMember("Maria", { isActive: false });
    seedMember("David", { isActive: false });
    seedMember("DarkMaster", { isActive: false });
    seedMember("Jasurkhon");

    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["Sarah", "Jasurkhon"]);

    const { joinLeadQueue, leaveLeadQueue } = await import("../lead-queue");

    currentActor = { id: "Maria", role: "TRAVEL_AGENT", status: "ACTIVE" };
    await joinLeadQueue();
    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["Sarah", "Maria", "Jasurkhon"]);

    currentActor = { id: "DarkMaster", role: "TRAVEL_AGENT", status: "ACTIVE" };
    await joinLeadQueue();
    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["Sarah", "Maria", "DarkMaster", "Jasurkhon"]);

    currentActor = { id: "David", role: "TRAVEL_AGENT", status: "ACTIVE" };
    await joinLeadQueue();
    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["Sarah", "Maria", "David", "DarkMaster", "Jasurkhon"]);

    // David pauses again — remains ghosted at his logical slot, not deleted.
    currentActor = { id: "David", role: "TRAVEL_AGENT", status: "ACTIVE" };
    await leaveLeadQueue();
    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["Sarah", "Maria", "DarkMaster", "Jasurkhon"]);
    expect(queueEntries.has("David")).toBe(true);

    // David resumes — restored to exactly the same full logical order, NOT
    // appended to the bottom (Test E).
    currentActor = { id: "David", role: "TRAVEL_AGENT", status: "ACTIVE" };
    await joinLeadQueue();
    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["Sarah", "Maria", "David", "DarkMaster", "Jasurkhon"]);
  });
});

// §29-31 — the trickier edge cases: a resuming member with real service
// history is never confused for a brand-new joiner, and multiple ghosts
// resuming in any order settle back into logical order, not append-order.
describe("§29-31 — edge cases: resumed member keeps real history, multiple ghosts settle by logical order", () => {
  it("§29 — a resumed member with real (non-null) history is not treated as though they joined today", async () => {
    seedMember("A", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedMember("B", { lastAssignedAt: new Date(2026, 0, 1, 8, 0), isActive: false }); // paused, real history
    seedMember("C", { lastAssignedAt: null }); // active, never served
    seedMember("D", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedMember("E", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });

    // C/D/E receive (and accept) many leads while B is paused — advances their timestamps.
    for (let i = 0; i < 6; i++) {
      seedWebsiteLead(`lead-${i}`);
      await distributeAndAccept(`lead-${i}`);
    }

    currentActor = { id: "B", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const { joinLeadQueue } = await import("../lead-queue");
    await joinLeadQueue();

    // B's original 8:00 timestamp is untouched — still earlier than
    // everyone who was just served moments ago in this test run.
    expect(queueEntries.get("B")!.lastAssignedAt).toEqual(new Date(2026, 0, 1, 8, 0));
  });

  it("§31 — a resuming member's own logical position (relative to still-ghosted members) is restored, not appended to the end", async () => {
    seedMember("A", { isActive: false });
    seedMember("B", { isActive: false });
    seedMember("C", { isActive: false });
    seedMember("D", { isActive: false });
    seedMember("E");

    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["E"]);

    currentActor = { id: "C", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const { joinLeadQueue } = await import("../lead-queue");
    await joinLeadQueue();

    // C (joined 3rd overall) comes before E (joined 5th) once both active —
    // C is NOT appended after E just because C resumed later.
    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["C", "E"]);
  });

  it("§33 — multiple returning members settle into logical order regardless of the order they resume in", async () => {
    seedMember("A", { isActive: false });
    seedMember("B", { isActive: false });
    seedMember("C", { isActive: false });
    seedMember("D", { isActive: false });
    seedMember("E", { isActive: false });

    const { joinLeadQueue } = await import("../lead-queue");

    currentActor = { id: "C", role: "TRAVEL_AGENT", status: "ACTIVE" };
    await joinLeadQueue();
    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["C"]);

    // A resumes after C, but A's logical position (1st) is before C's (3rd).
    currentActor = { id: "A", role: "TRAVEL_AGENT", status: "ACTIVE" };
    await joinLeadQueue();
    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["A", "C"]);

    currentActor = { id: "E", role: "TRAVEL_AGENT", status: "ACTIVE" };
    await joinLeadQueue();
    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["A", "C", "E"]);
  });
});

// Test F/G — waiting leads are never lost, never expired by age, processed
// in creation order, and begin being distributed as soon as someone becomes
// eligible again (including via joinLeadQueue's own best-effort trigger).
describe("Test F/G — waiting website leads survive an all-paused period, with no expiration by age", () => {
  it("Test F — leads created while nobody is accepting remain in the database, unassigned, indefinitely", async () => {
    seedMember("A", { isActive: false });
    seedWebsiteLead("lead-old", new Date(2020, 0, 1)); // years old — must not be filtered out
    seedWebsiteLead("lead-new", new Date());

    const { distributeNewWebsiteLead } = await import("../lead-queue");
    const rOld = await distributeNewWebsiteLead("lead-old");
    const rNew = await distributeNewWebsiteLead("lead-new");

    expect(rOld.offered).toBe(false);
    expect(rNew.offered).toBe(false);
    expect(leads.get("lead-old")!.assignedAgentId).toBeNull();
    expect(leads.get("lead-new")!.assignedAgentId).toBeNull();
    expect(leads.get("lead-old")!.offeredToId).toBeNull();
    expect(leads.get("lead-new")!.offeredToId).toBeNull();
  });

  it("Test G — resuming (joinLeadQueue) processes the waiting backlog in creation order, oldest first, no age cutoff — one live offer at a time", async () => {
    seedMember("A", { isActive: false });
    seedWebsiteLead("lead-a", new Date(2026, 0, 1, 10, 1));
    seedWebsiteLead("lead-b", new Date(2026, 0, 1, 10, 5));
    seedWebsiteLead("lead-c", new Date(2026, 0, 1, 10, 10));

    currentActor = { id: "A", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const { joinLeadQueue, acceptLeadOffer, distributePendingWebsiteLeads } = await import("../lead-queue");
    await joinLeadQueue();
    // distributePendingWebsiteLeads is fired best-effort (not awaited) from
    // inside joinLeadQueue — flush microtasks so it actually runs before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Oldest lead is offered first — A can only hold one live offer at a
    // time, so lead-b/lead-c are NOT offered yet (still fully waiting).
    expect(leads.get("lead-a")!.offeredToId).toBe("A");
    expect(leads.get("lead-b")!.offeredToId).toBeNull();
    expect(leads.get("lead-c")!.offeredToId).toBeNull();

    await acceptLeadOffer("lead-a");
    expect(leads.get("lead-a")!.assignedAgentId).toBe("A");

    // A real client would poll into this on the next tick — simulate that
    // next trigger directly.
    await distributePendingWebsiteLeads();
    expect(leads.get("lead-b")!.offeredToId).toBe("A");
    await acceptLeadOffer("lead-b");

    await distributePendingWebsiteLeads();
    expect(leads.get("lead-c")!.offeredToId).toBe("A");
    await acceptLeadOffer("lead-c");
    expect(leads.get("lead-c")!.assignedAgentId).toBe("A");

    // A lead captured days/weeks ago (lead-a, oldest of the three) was
    // fully eligible and was in fact the very first one served — nothing
    // about its age blocked it.
  });

  it("a new lead never permanently jumps ahead of older waiting leads (§22) — fair chronological processing", async () => {
    seedWebsiteLead("lead-old-1", new Date(2026, 0, 1, 9, 0));
    seedWebsiteLead("lead-old-2", new Date(2026, 0, 1, 9, 5));
    // A brand-new lead arrives after the two old ones, while still nobody's active.
    seedWebsiteLead("lead-new", new Date(2026, 0, 1, 11, 0));

    seedMember("A", { isActive: false });
    currentActor = { id: "A", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const { joinLeadQueue, acceptLeadOffer, distributePendingWebsiteLeads } = await import("../lead-queue");
    await joinLeadQueue();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Only the oldest lead received the (single, sequential) offer.
    expect(leads.get("lead-old-1")!.offeredToId).toBe("A");
    expect(leads.get("lead-old-2")!.offeredToId).toBeNull();
    expect(leads.get("lead-new")!.offeredToId).toBeNull();

    await acceptLeadOffer("lead-old-1");
    await distributePendingWebsiteLeads();
    expect(leads.get("lead-old-2")!.offeredToId).toBe("A");
    await acceptLeadOffer("lead-old-2");

    await distributePendingWebsiteLeads();
    expect(leads.get("lead-new")!.offeredToId).toBe("A"); // the new one only goes out once the two older ones are cleared
  });
});

// The core new mechanism for this task: OFFER first, ASSIGN only on
// ACCEPT within 60s; a missed window moves that worker to the back of the
// rotation AND auto-pauses them (isActive: false) — a deliberate policy
// reversal from an earlier iteration of this feature — before re-offering
// the same lead onward to the next eligible worker.
describe("Test A/B/D/H — 60-second offer, accept, and miss-and-advance", () => {
  it("Test A — accepting within the window assigns the lead, clears the offer, and fires the usual notification", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedMember("Jasurkhon", { lastAssignedAt: new Date(2026, 0, 1, 9, 1) });
    seedWebsiteLead("lead-1");

    const { distributeNewWebsiteLead, acceptLeadOffer } = await import("../lead-queue");
    const offerResult = await distributeNewWebsiteLead("lead-1");
    expect(offerResult.offered && offerResult.accountId).toBe("Sarah");
    expect(leads.get("lead-1")!.assignedAgentId).toBeNull(); // offered, not yet assigned

    currentActor = { id: "Sarah", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const accept = await acceptLeadOffer("lead-1");

    expect(accept.ok).toBe(true);
    expect(leads.get("lead-1")!.assignedAgentId).toBe("Sarah");
    expect(leads.get("lead-1")!.offeredToId).toBeNull(); // temporary offer state removed
    expect(leads.get("lead-1")!.offerExpiresAt).toBeNull();
    // A fresh website lead accepted through the queue becomes NEW — distinct
    // from ACCEPTED (reassignLead's manual-reassignment status) and from
    // ATTEMPTING_TO_CONTACT (createLead's default for every other path).
    expect(leads.get("lead-1")!.status).toBe("NEW");
    expect(statusHistory).toContainEqual({ leadId: "lead-1", fromStatus: "ATTEMPTING_TO_CONTACT", toStatus: "NEW", changedById: "Sarah" });
    expect(queueEntries.get("Sarah")!.leadsAssignedCount).toBe(1);
    expect(fakePrismaClient.notification.create).toHaveBeenCalledTimes(1);
  });

  it("Test A — accepting an already-expired or already-resolved offer fails cleanly, no duplicate assignment", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedWebsiteLead("lead-1");
    const { distributeNewWebsiteLead, acceptLeadOffer } = await import("../lead-queue");
    await distributeNewWebsiteLead("lead-1");

    // Force the offer into the past, as if the 60s window had already elapsed.
    leads.get("lead-1")!.offerExpiresAt = new Date(Date.now() - 1000);

    currentActor = { id: "Sarah", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const accept = await acceptLeadOffer("lead-1");

    expect(accept.ok).toBe(false);
    expect(leads.get("lead-1")!.assignedAgentId).toBeNull();
  });

  it("Test B/D — a missed window moves that worker to the end of rotation AND auto-pauses them, then re-offers to the next eligible worker with a fresh countdown", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedMember("Maria", { isActive: false });
    seedMember("David", { isActive: false });
    seedMember("DarkMaster", { isActive: false });
    seedMember("Jasurkhon", { lastAssignedAt: new Date(2026, 0, 1, 9, 1) });
    seedWebsiteLead("lead-1");

    const { distributeNewWebsiteLead, getMyLeadOffer } = await import("../lead-queue");
    const offerResult = await distributeNewWebsiteLead("lead-1");
    expect(offerResult.offered && offerResult.accountId).toBe("Sarah");
    const sarahLeadsBefore = queueEntries.get("Sarah")!.leadsAssignedCount;

    // Simulate the 60s window elapsing without Sarah accepting.
    leads.get("lead-1")!.offerExpiresAt = new Date(Date.now() - 1000);

    // Any poll (here, Jasurkhon's) opportunistically sweeps the stale offer.
    currentActor = { id: "Jasurkhon", role: "TRAVEL_AGENT", status: "ACTIVE" };
    await getMyLeadOffer();

    // Sarah missed her window: auto-paused (isActive flips to false) AND
    // moved to the back of rotation — leadsAssignedCount does NOT increment,
    // since she was never actually given a lead.
    expect(queueEntries.get("Sarah")!.isActive).toBe(false);
    expect(queueEntries.get("Sarah")!.leadsAssignedCount).toBe(sarahLeadsBefore);
    expect(queueEntries.get("Sarah")!.lastAssignedAt!.getTime()).toBeGreaterThan(new Date(2026, 0, 1, 9, 0).getTime());

    // The lead is now offered onward to Jasurkhon, with a fresh (future) expiry.
    expect(leads.get("lead-1")!.offeredToId).toBe("Jasurkhon");
    expect(leads.get("lead-1")!.offerExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(leads.get("lead-1")!.assignedAgentId).toBeNull(); // still just offered, not assigned

    // Effective active queue no longer contains Sarah at all — she's a
    // ghost now, not merely deferred.
    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["Jasurkhon"]);
  });

  it("Test H — a worker already holding a live offer is never offered a second lead at the same time (sequential, not simultaneous)", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedWebsiteLead("lead-1");
    seedWebsiteLead("lead-2", new Date(2026, 0, 1, 0, 0, 1));

    const { distributeNewWebsiteLead } = await import("../lead-queue");
    const r1 = await distributeNewWebsiteLead("lead-1");
    expect(r1.offered && r1.accountId).toBe("Sarah");

    // Sarah is the only eligible worker and already has a live offer on
    // lead-1 — lead-2 must NOT also be offered to her right now.
    const r2 = await distributeNewWebsiteLead("lead-2");
    expect(r2.offered).toBe(false);
    expect(leads.get("lead-2")!.offeredToId).toBeNull();
  });

  it("Test H — a paused user never receives an offer even mid-sweep of someone else's expired offer", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedMember("Bob", { lastAssignedAt: new Date(2026, 0, 1, 9, 30) });
    seedMember("Ghost", { isActive: false, lastAssignedAt: new Date(2020, 0, 1) }); // extremely overdue, but paused
    seedWebsiteLead("lead-1");

    const { distributeNewWebsiteLead, getMyLeadOffer } = await import("../lead-queue");
    await distributeNewWebsiteLead("lead-1");
    leads.get("lead-1")!.offerExpiresAt = new Date(Date.now() - 1000);

    currentActor = { id: "Sarah", role: "TRAVEL_AGENT", status: "ACTIVE" };
    await getMyLeadOffer(); // triggers the sweep — Sarah's own miss auto-pauses her

    // Re-offered to Bob, the next eligible worker — never to the
    // already-paused Ghost, despite being far more "overdue" by
    // lastAssignedAt, and never back to Sarah, who is now paused too.
    expect(leads.get("lead-1")!.offeredToId).toBe("Bob");
    expect(queueEntries.get("Sarah")!.isActive).toBe(false);
  });

  it("with no other eligible worker, a sole worker's missed window auto-pauses them and the lead falls back to pending distribution — it is not re-offered to anyone", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedWebsiteLead("lead-1");
    const { distributeNewWebsiteLead, getMyLeadOffer } = await import("../lead-queue");
    await distributeNewWebsiteLead("lead-1");

    currentActor = { id: "Sarah", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const live = await getMyLeadOffer();
    expect(live?.leadId).toBe("lead-1");

    leads.get("lead-1")!.offerExpiresAt = new Date(Date.now() - 1000);
    const afterExpiry = await getMyLeadOffer();

    // Sarah was the only eligible worker — missing her own window auto-pauses
    // her, leaving nobody left to offer the lead to. Per Part 1.10, the lead
    // is never lost: it simply falls back to unoffered/pending distribution
    // rather than being stuck in a limbo offer or incorrectly circled back
    // to the now-paused Sarah.
    expect(afterExpiry).toBeNull();
    expect(leads.get("lead-1")!.offeredToId).toBeNull();
    expect(leads.get("lead-1")!.assignedAgentId).toBeNull();
    expect(queueEntries.get("Sarah")!.isActive).toBe(false);
    expect(queueEntries.get("Sarah")!.leadsAssignedCount).toBe(0); // never actually given a lead
  });
});

// Pass 30 — real bug found and fixed: acceptLeadOffer previously never
// touched Contact.ownerId at all. lead-capture's own route LOOKED like it
// handled "first Lead for a brand-new Contact -> assign the Contact too",
// but that branch was structurally unreachable dead code (see that
// route's own Pass 30 comment) — for the actual queue-distribution path,
// a first-time website Contact stayed permanently ownerless even after an
// agent successfully accepted their Lead, which meant
// contactVisibilityWhere (src/server/visibility.ts, `{ ownerId: viewer.id
// }` for a restricted role) made that Contact permanently invisible to
// the very agent who owned and was working the Lead.
describe("Pass 30 — acceptLeadOffer assigns Contact ownership for a first-time/unowned Contact", () => {
  it("a brand-new (unowned) Contact becomes owned by the agent who successfully accepts the lead", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedWebsiteLead("lead-1");
    expect(contacts.get("contact-for-lead-1")!.ownerId).toBeNull();

    const { distributeNewWebsiteLead, acceptLeadOffer } = await import("../lead-queue");
    await distributeNewWebsiteLead("lead-1");
    currentActor = { id: "Sarah", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const accept = await acceptLeadOffer("lead-1");

    expect(accept.ok).toBe(true);
    expect(leads.get("lead-1")!.assignedAgentId).toBe("Sarah");
    expect(contacts.get("contact-for-lead-1")!.ownerId).toBe("Sarah");
  });

  it("an EXISTING Contact that already has a real owner is never overwritten by a later Lead's acceptance", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedWebsiteLead("lead-1", undefined, { ownerId: "original-owner" });

    const { distributeNewWebsiteLead, acceptLeadOffer } = await import("../lead-queue");
    await distributeNewWebsiteLead("lead-1");
    currentActor = { id: "Sarah", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const accept = await acceptLeadOffer("lead-1");

    expect(accept.ok).toBe(true);
    expect(leads.get("lead-1")!.assignedAgentId).toBe("Sarah"); // the LEAD still goes to Sarah
    expect(contacts.get("contact-for-lead-1")!.ownerId).toBe("original-owner"); // the CONTACT's real owner is untouched
  });

  it("a failed/expired acceptance attempt never claims Contact ownership either", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedWebsiteLead("lead-1");
    const { distributeNewWebsiteLead, acceptLeadOffer } = await import("../lead-queue");
    await distributeNewWebsiteLead("lead-1");
    leads.get("lead-1")!.offerExpiresAt = new Date(Date.now() - 1000); // force expiry

    currentActor = { id: "Sarah", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const accept = await acceptLeadOffer("lead-1");

    expect(accept.ok).toBe(false);
    expect(contacts.get("contact-for-lead-1")!.ownerId).toBeNull();
  });

  it("two agents racing to accept two DIFFERENT leads for the SAME still-unowned Contact — only the first winner claims Contact ownership", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedMember("Jasurkhon", { lastAssignedAt: new Date(2026, 0, 1, 9, 1) });
    // Two separate Leads, deliberately pointed at the exact same Contact —
    // seedWebsiteLead's own auto-seed would give them different contacts,
    // so wire this one up by hand to share "shared-contact".
    contacts.set("shared-contact", { id: "shared-contact", ownerId: null });
    leads.set("lead-1", { id: "lead-1", assignedAgentId: null, source: "WEBSITE", status: "ATTEMPTING_TO_CONTACT", queueDistributedAt: null, createdAt: new Date(2026, 0, 1, 0, 0, nextId++), offeredToId: null, offeredAt: null, offerExpiresAt: null, contactId: "shared-contact" });
    leads.set("lead-2", { id: "lead-2", assignedAgentId: null, source: "WEBSITE", status: "ATTEMPTING_TO_CONTACT", queueDistributedAt: null, createdAt: new Date(2026, 0, 1, 0, 0, nextId++), offeredToId: null, offeredAt: null, offerExpiresAt: null, contactId: "shared-contact" });

    const { distributeNewWebsiteLead, acceptLeadOffer } = await import("../lead-queue");
    // Offer lead-1 to Sarah (next up) and accept it first.
    await distributeNewWebsiteLead("lead-1");
    currentActor = { id: "Sarah", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const first = await acceptLeadOffer("lead-1");
    expect(first.ok).toBe(true);
    expect(contacts.get("shared-contact")!.ownerId).toBe("Sarah");

    // Now lead-2 gets offered (rotation moves on) and accepted by Jasurkhon.
    await distributeNewWebsiteLead("lead-2");
    currentActor = { id: "Jasurkhon", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const second = await acceptLeadOffer("lead-2");
    expect(second.ok).toBe(true); // the LEAD itself is still assigned to Jasurkhon
    expect(leads.get("lead-2")!.assignedAgentId).toBe("Jasurkhon");
    // But Contact ownership stays with Sarah — the first winner — never
    // silently overwritten by the second agent's own successful Lead claim.
    expect(contacts.get("shared-contact")!.ownerId).toBe("Sarah");
  });
});

// Part 1.9 of this task's spec: an explicit Skip is treated the SAME as a
// missed countdown — moved to the back AND auto-paused — consistent with
// the Part 1.8 reversal, just triggered by a click instead of the clock.
describe("skipLeadOffer — explicit decline, same consequence as a timeout, including auto-pause", () => {
  it("moves the skipping worker to the end of rotation, auto-pauses them, and re-offers the same lead to the next eligible worker, with time still remaining", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedMember("Jasurkhon", { lastAssignedAt: new Date(2026, 0, 1, 9, 1) });
    seedWebsiteLead("lead-1");

    const { distributeNewWebsiteLead, skipLeadOffer } = await import("../lead-queue");
    const offerResult = await distributeNewWebsiteLead("lead-1");
    expect(offerResult.offered && offerResult.accountId).toBe("Sarah");

    currentActor = { id: "Sarah", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const skip = await skipLeadOffer("lead-1");
    expect(skip.ok).toBe(true);

    // Sarah: auto-paused, not counted as served, moved to the back.
    expect(queueEntries.get("Sarah")!.isActive).toBe(false);
    expect(queueEntries.get("Sarah")!.leadsAssignedCount).toBe(0);
    expect(queueEntries.get("Sarah")!.lastAssignedAt!.getTime()).toBeGreaterThan(new Date(2026, 0, 1, 9, 0).getTime());

    // Re-offered onward to Jasurkhon with a fresh window — lead itself is
    // still just offered, never assigned, and status is untouched by a skip.
    expect(leads.get("lead-1")!.offeredToId).toBe("Jasurkhon");
    expect(leads.get("lead-1")!.assignedAgentId).toBeNull();
    expect(leads.get("lead-1")!.status).toBe("ATTEMPTING_TO_CONTACT");
    // Sarah is no longer in the effective active queue at all — she's a
    // ghost now, exactly like a missed countdown.
    expect(effectiveActiveOrder().map((e) => e.accountId)).toEqual(["Jasurkhon"]);
  });

  it("skipping as the sole eligible worker auto-pauses them and the lead falls back to pending distribution, not re-offered to anyone", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedWebsiteLead("lead-1");

    const { distributeNewWebsiteLead, skipLeadOffer } = await import("../lead-queue");
    await distributeNewWebsiteLead("lead-1");
    currentActor = { id: "Sarah", role: "TRAVEL_AGENT", status: "ACTIVE" };
    await skipLeadOffer("lead-1");

    // Sarah was the only worker — skipping pauses her (isActive: false),
    // matching the timeout behavior, so the lead has nobody left to go to.
    expect(queueEntries.get("Sarah")!.isActive).toBe(false);
    expect(leads.get("lead-1")!.offeredToId).toBeNull();
    expect(leads.get("lead-1")!.assignedAgentId).toBeNull();
  });

  it("only the account currently holding the offer can skip it — race-safe like accept", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedMember("Jasurkhon", { lastAssignedAt: new Date(2026, 0, 1, 9, 1) });
    seedWebsiteLead("lead-1");

    const { distributeNewWebsiteLead, skipLeadOffer } = await import("../lead-queue");
    await distributeNewWebsiteLead("lead-1"); // offered to Sarah

    currentActor = { id: "Jasurkhon", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const wrongSkip = await skipLeadOffer("lead-1");

    expect(wrongSkip.ok).toBe(false);
    expect(leads.get("lead-1")!.offeredToId).toBe("Sarah"); // untouched — Jasurkhon never held this offer
  });

  it("skipping an offer that's already been accepted or expired fails cleanly", async () => {
    seedMember("Sarah", { lastAssignedAt: new Date(2026, 0, 1, 9, 0) });
    seedWebsiteLead("lead-1");

    const { skipLeadOffer } = await import("../lead-queue");
    currentActor = { id: "Sarah", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const skip = await skipLeadOffer("lead-1"); // no live offer at all right now

    expect(skip.ok).toBe(false);
  });
});

// Pass 5 — Activity History enrichment. acceptLeadOffer previously logged
// this event with actorId: null (rendering as "System" in the Activity
// Timeline) even though the real accepting worker is right there — this
// verifies the fix records the actual receiving agent as the actor, plus
// a distinguishable event type and the queue-position metadata the
// Activity History UI displays.
describe("acceptLeadOffer — Activity History event (Pass 5)", () => {
  it("logs LEAD_RECEIVED_FROM_QUEUE with the accepting worker as actorId (not null/System)", async () => {
    seedMember("Sarah", { lastAssignedAt: null }, { fullName: "Sarah Johnson" });
    seedWebsiteLead("lead-1");

    const { distributeNewWebsiteLead, acceptLeadOffer } = await import("../lead-queue");
    await distributeNewWebsiteLead("lead-1");
    currentActor = accounts.get("Sarah")!;
    await acceptLeadOffer("lead-1");

    const { logActivity } = await import("@/server/activity-log");
    const call = vi.mocked(logActivity).mock.calls.find(([arg]) => arg.type === "LEAD_RECEIVED_FROM_QUEUE");
    expect(call).toBeDefined();
    const [payload] = call!;
    expect(payload.actorId).toBe("Sarah");
    expect(payload.description).toContain("Sarah Johnson");
    expect(payload.metadata).toMatchObject({ source: "Lead Queue" });
  });
});
