import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 22 — CONFIRMED STATUS-MACHINE GAP, now fixed: cancelQuote() had no
// status precondition at all (transitionQuoteStatus's forward-only rank
// check deliberately exempts CANCELED for every caller — see
// quote-status.ts's own STATUS_RANK comment). The client "Cancel Quote"
// button tried to hide itself past BOOKED/exchange/cancellation states but
// was missing CHARGED entirely, and even where the client DID hide the
// button, nothing stopped a direct call to this action. These tests prove
// the new isQuoteCancelable() guard actually blocks it server-side, not
// just in the UI.

type FakeQuote = { id: string; status: string; companyId: string };

let currentActor: { id: string; role: string; companyId: string } | null;
let quotes: Map<string, FakeQuote>;
let transitionCalls: Array<{ quoteId: string; toStatus: string }>;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/quote-status", () => ({
  transitionQuoteStatus: vi.fn(async (quoteId: string, toStatus: string) => {
    transitionCalls.push({ quoteId, toStatus });
    const q = quotes.get(quoteId);
    if (q) q.status = toStatus;
  }),
}));

// quotes.ts pulls in a wide import graph (email templates/service,
// activity log, company/lead lookups) that cancelQuote() itself never
// actually calls — stubbed out purely so importing the module can't reach
// any real, unmocked dependency (e.g. an email-provider SDK) during the
// test's dynamic import.
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/email/service", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/server/email/templates", () => ({ buildQuoteEmail: vi.fn(() => ({ subject: "", html: "" })) }));
vi.mock("@/server/email/segment-mapper", () => ({ toEmailSegments: vi.fn(() => []) }));
vi.mock("@/server/queries/company", () => ({ getCompanyForAccountId: vi.fn(async () => ({ id: "company-1", name: "Test Co" })) }));
vi.mock("@/lib/company-config", () => ({ resolveBaseUrl: vi.fn(() => "https://app.example.com") }));
vi.mock("@/server/actions/leads", () => ({ applyLeadStatusChange: vi.fn(async () => {}) }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    quote: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; companyId?: string; OR?: unknown } }) => {
        const q = quotes.get(where.id);
        if (!q) return null;
        // Mirrors the real quoteVisibilityWhere's company-wide shape for
        // roles with full visibility (ADMIN/MANAGER/etc in this fake) —
        // this test isn't exercising IDOR, just the new status guard, so
        // any actor in the same company can see the quote.
        if (!currentActor || q.companyId !== currentActor.companyId) return null;
        return { id: q.id, status: q.status };
      }),
    },
  },
}));

vi.mock("@/server/visibility", () => ({
  quoteVisibilityWhere: vi.fn((actor: { companyId: string } | null) => ({ companyId: actor?.companyId })),
  leadAccessForQuoting: vi.fn(() => ({})),
}));

beforeEach(() => {
  currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1" };
  quotes = new Map();
  transitionCalls = [];
  vi.clearAllMocks();
});

function seedQuote(status: string) {
  quotes.set("quote-1", { id: "quote-1", status, companyId: "company-1" });
}

describe("cancelQuote — server-side status guard (Pass 22 fix)", () => {
  it("allows canceling a DRAFT quote", async () => {
    seedQuote("DRAFT");
    const { cancelQuote } = await import("../quotes");
    await cancelQuote("quote-1");
    expect(transitionCalls).toEqual([{ quoteId: "quote-1", toStatus: "CANCELED" }]);
  });

  it("allows canceling a SENT/VIEWED/SIGNED quote", async () => {
    for (const status of ["SENT", "VIEWED", "SIGNED"]) {
      seedQuote(status);
      transitionCalls = [];
      const { cancelQuote } = await import("../quotes");
      await cancelQuote("quote-1");
      expect(transitionCalls).toEqual([{ quoteId: "quote-1", toStatus: "CANCELED" }]);
    }
  });

  it("REJECTS canceling an already-CHARGED (paid) quote — the confirmed gap this pass fixed", async () => {
    seedQuote("CHARGED");
    const { cancelQuote } = await import("../quotes");
    await expect(cancelQuote("quote-1")).rejects.toThrow(/can no longer be canceled directly/i);
    expect(transitionCalls).toHaveLength(0);
    expect(quotes.get("quote-1")!.status).toBe("CHARGED"); // unchanged
  });

  it("REJECTS canceling a BOOKED quote", async () => {
    seedQuote("BOOKED");
    const { cancelQuote } = await import("../quotes");
    await expect(cancelQuote("quote-1")).rejects.toThrow(/can no longer be canceled directly/i);
    expect(transitionCalls).toHaveLength(0);
  });

  it("REJECTS canceling a quote mid-exchange or mid-cancellation-review", async () => {
    for (const status of ["PENDING_EXCHANGE_APPROVAL", "EXCHANGE_APPROVED", "PENDING_CANCELLATION_APPROVAL", "CANCELLATION_FORM_SENT"]) {
      seedQuote(status);
      transitionCalls = [];
      const { cancelQuote } = await import("../quotes");
      await expect(cancelQuote("quote-1")).rejects.toThrow(/can no longer be canceled directly/i);
      expect(transitionCalls).toHaveLength(0);
    }
  });

  it("REJECTS canceling an already-CANCELED quote (idempotent no-op via rejection, never double-transitions)", async () => {
    seedQuote("CANCELED");
    const { cancelQuote } = await import("../quotes");
    await expect(cancelQuote("quote-1")).rejects.toThrow(/can no longer be canceled directly/i);
  });

  it("rejects a quote outside the actor's company (IDOR) before ever reaching the status guard", async () => {
    quotes.set("quote-1", { id: "quote-1", status: "DRAFT", companyId: "other-company" });
    const { cancelQuote } = await import("../quotes");
    await expect(cancelQuote("quote-1")).rejects.toThrow(/not found/i);
    expect(transitionCalls).toHaveLength(0);
  });
});
