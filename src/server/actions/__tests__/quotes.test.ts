import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedActionError } from "@/lib/expected-action-error";

// Regression coverage for the System Health incident "An unhandled error
// occurred in action /quotes/[id] (Error)." — reproduced and root-caused as
// follows: these actions already validate input, check authorization/
// visibility, check the record exists, and enforce business-rule
// preconditions correctly (every case below shows a safe, clear, user-facing
// rejection, never a crash). The genuine defect was one layer up: Next.js
// reports EVERY Server Action throw to onRequestError, so this deliberate,
// already-handled rejection was being recorded as an "unhandled server
// error" purely because a user (or an agent) triggered it a few times.
// ExpectedActionError (see src/lib/expected-action-error.ts) is the fix:
// every assertion below both proves the action still behaves exactly as
// before (same message reaches the caller) AND proves the thrown value is
// now an ExpectedActionError, which src/server/system/server-errors.ts skips.

type FakeQuote = {
  id: string;
  status: string;
  companyId: string;
  contactId: string;
  agentId: string | null;
  leadAssignedAgentId?: string | null;
  contactOwnerId?: string | null;
  leadId: string;
  bookingId?: string | null;
};

let quotes: Map<string, FakeQuote>;
let currentActor: { id: string; role: string; companyId: string; status: string } | null;
let auditLogs: Array<Record<string, unknown>>;
let transitionCalls: Array<{ quoteId: string; toStatus: string }>;
let deletedIds: string[];

function visible(q: FakeQuote): boolean {
  if (!currentActor) return false;
  if (currentActor.role === "ADMIN" || currentActor.role === "MANAGER" || currentActor.role === "TICKETING_AGENT") return q.companyId === currentActor.companyId;
  return q.agentId === currentActor.id || q.leadAssignedAgentId === currentActor.id || q.contactOwnerId === currentActor.id;
}

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/quote-status", () => ({
  transitionQuoteStatus: vi.fn(async (quoteId: string, toStatus: string) => {
    transitionCalls.push({ quoteId, toStatus });
    const q = quotes.get(quoteId);
    if (q) q.status = toStatus;
  }),
}));

let simulateDatabaseFailure = false;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    quote: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } & Record<string, unknown> }) => {
        if (simulateDatabaseFailure) throw new Error("connection terminated unexpectedly");
        const q = quotes.get(where.id);
        if (!q || !visible(q)) return null;
        return { ...q, booking: q.bookingId ? { id: q.bookingId } : null };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeQuote> }) => {
        const q = quotes.get(where.id);
        if (!q) throw new Error("not found");
        Object.assign(q, data);
        return q;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        deletedIds.push(where.id);
        quotes.delete(where.id);
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        auditLogs.push(data);
        return data;
      }),
    },
  },
}));

beforeEach(() => {
  quotes = new Map();
  auditLogs = [];
  transitionCalls = [];
  deletedIds = [];
  simulateDatabaseFailure = false;
  currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "co-1", status: "ACTIVE" };
});

function seed(overrides: Partial<FakeQuote> = {}) {
  const q: FakeQuote = { id: "quote-1", status: "SENT", companyId: "co-1", contactId: "contact-1", agentId: "agent-1", leadId: "lead-1", ...overrides };
  quotes.set(q.id, q);
  return q;
}

describe("updateQuoteInternalNotes", () => {
  it("valid quote: updates without throwing", async () => {
    seed();
    const { updateQuoteInternalNotes } = await import("../quotes");
    await expect(updateQuoteInternalNotes("quote-1", { internalNotes: "note" })).resolves.toBeUndefined();
  });

  it("nonexistent quote id: a clear ExpectedActionError, not a crash", async () => {
    const { updateQuoteInternalNotes } = await import("../quotes");
    const err = await updateQuoteInternalNotes("does-not-exist", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedActionError);
    expect((err as Error).message).toBe("Quote not found");
  });

  it("malformed / garbage id behaves exactly like any other nonexistent id (Prisma ids are opaque strings — no crash)", async () => {
    const { updateQuoteInternalNotes } = await import("../quotes");
    for (const badId of ["", "' OR 1=1 --", "../../etc/passwd", "🙂".repeat(50)]) {
      const err = await updateQuoteInternalNotes(badId, {}).catch((e) => e);
      expect(err, badId).toBeInstanceOf(ExpectedActionError);
    }
  });

  it("unauthorized (not visible to this actor): the same not-found message — never confirms the quote exists (no enumeration)", async () => {
    seed({ agentId: "someone-else", companyId: "co-1" });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "co-1", status: "ACTIVE" };
    const { updateQuoteInternalNotes } = await import("../quotes");
    const err = await updateQuoteInternalNotes("quote-1", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedActionError);
    expect((err as Error).message).toBe("Quote not found");
  });

  it("a genuine database failure is NOT converted to an ExpectedActionError — it must still surface as a real incident", async () => {
    seed();
    simulateDatabaseFailure = true;
    const { updateQuoteInternalNotes } = await import("../quotes");
    const err = await updateQuoteInternalNotes("quote-1", {}).catch((e) => e);
    expect(err).not.toBeInstanceOf(ExpectedActionError);
    expect((err as Error).message).toBe("connection terminated unexpectedly");
  });
});

describe("cancelQuote — expected business-rule failures", () => {
  it("valid, cancelable quote: transitions to CANCELED", async () => {
    seed({ status: "SENT" });
    const { cancelQuote } = await import("../quotes");
    await cancelQuote("quote-1");
    expect(transitionCalls).toEqual([{ quoteId: "quote-1", toStatus: "CANCELED" }]);
  });

  it("nonexistent quote: ExpectedActionError, not a crash", async () => {
    const { cancelQuote } = await import("../quotes");
    await expect(cancelQuote("nope")).rejects.toBeInstanceOf(ExpectedActionError);
  });

  it("business-rule failure: a quote that is no longer cancelable this way is rejected with a clear message and nothing is changed", async () => {
    seed({ status: "CHARGED" });
    const { cancelQuote } = await import("../quotes");
    const err = await cancelQuote("quote-1").catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedActionError);
    expect((err as Error).message).toMatch(/Exchange\/Cancellation workflow/);
    expect(transitionCalls).toEqual([]);
  });
});

describe("deleteDraftQuote", () => {
  it("valid draft: deletes", async () => {
    seed({ status: "DRAFT" });
    const { deleteDraftQuote } = await import("../quotes");
    await deleteDraftQuote("quote-1");
    expect(deletedIds).toEqual(["quote-1"]);
  });

  it("business-rule failure: a non-draft quote is refused, and nothing is deleted", async () => {
    seed({ status: "SENT" });
    const { deleteDraftQuote } = await import("../quotes");
    const err = await deleteDraftQuote("quote-1").catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedActionError);
    expect((err as Error).message).toBe("Only draft quotes can be deleted");
    expect(deletedIds).toEqual([]);
  });
});

describe("deleteQuote — Admin-only, any status", () => {
  it("unauthorized role: refused, audited, and nothing deleted", async () => {
    seed();
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "co-1", status: "ACTIVE" };
    const { deleteQuote } = await import("../quotes");
    const err = await deleteQuote("quote-1").catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedActionError);
    expect((err as Error).message).toBe("You are not authorized to delete this quote");
    expect(deletedIds).toEqual([]);
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]).toMatchObject({ action: "QUOTE_DELETE_DENIED" });
  });

  it("Admin, quote not accessible (different company): same denial, audited, no enumeration", async () => {
    seed({ companyId: "other-co" });
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "co-1", status: "ACTIVE" };
    const { deleteQuote } = await import("../quotes");
    const err = await deleteQuote("quote-1").catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedActionError);
    expect(auditLogs[0]).toMatchObject({ action: "QUOTE_DELETE_DENIED", metadata: { reason: "NOT_ACCESSIBLE" } });
  });

  it("Admin, accessible quote: deletes and audits QUOTE_DELETED", async () => {
    seed();
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "co-1", status: "ACTIVE" };
    const { deleteQuote } = await import("../quotes");
    await deleteQuote("quote-1");
    expect(deletedIds).toEqual(["quote-1"]);
    expect(auditLogs[0]).toMatchObject({ action: "QUOTE_DELETED" });
  });
});
