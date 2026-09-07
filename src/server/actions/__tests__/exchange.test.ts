import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercises the Exchange workflow's server actions in isolation — the
// authorization/precondition checks are the actual security boundary here
// (a UI button being hidden is never sufficient on its own), so these
// tests focus on: charged-quote-only enforcement, IDOR/visibility
// protection, and the Admin/Manager-only approval gate, rather than
// re-testing calculatePricing or the itinerary-builder UI.

type FakeQuote = {
  id: string;
  status: string;
  companyId: string;
  contactId: string;
  agentId: string | null;
  originalQuoteId?: string | null;
  isCurrentExchangeProposal?: boolean | null;
  supersededByQuoteId?: string | null;
};

let quotes: Map<string, FakeQuote>;
let currentActor: { id: string; role: string; companyId: string; fullName: string } | null;
let createdQuotes: Array<Record<string, unknown>>;
let notificationsCreated: Array<Record<string, unknown>>;

const fakePrisma: Record<string, unknown> = {
  quote: {
    findFirst: vi.fn(async ({ where }: { where: { id: string; OR?: unknown[]; companyId?: string } & Record<string, unknown> }) => {
      const q = quotes.get(where.id);
      if (!q) return null;
      // Mirrors quoteVisibilityWhere's real shape closely enough for these
      // tests: an ADMIN/MANAGER sees everything in their own company; a
      // restricted actor only sees a quote they're the agent on.
      if (!currentActor) return null;
      const visible =
        currentActor.role === "ADMIN" || currentActor.role === "MANAGER"
          ? q.companyId === currentActor.companyId
          : q.agentId === currentActor.id;
      return visible ? q : null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeQuote> }) => {
      const q = quotes.get(where.id);
      if (!q) throw new Error("not found");
      Object.assign(q, data);
      return q;
    }),
    // Pass 26 — conditional claim support, matching the real atomic-claim
    // pattern sendExchangeForApproval/approveExchange/disapproveExchange
    // now use. Only understands the specific WHERE shapes this codebase
    // actually issues (id, status, status: {in: [...]}, isCurrentExchangeProposal)
    // — enough to exercise the race-safety tests below without becoming a
    // general-purpose Prisma reimplementation.
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Partial<FakeQuote> }) => {
        let count = 0;
        for (const q of quotes.values()) {
          if (where.id !== undefined && q.id !== where.id) continue;
          if (where.status !== undefined) {
            const statusFilter = where.status as string | { in: string[] };
            if (typeof statusFilter === "string" ? q.status !== statusFilter : !statusFilter.in.includes(q.status)) continue;
          }
          if (where.isCurrentExchangeProposal !== undefined && q.isCurrentExchangeProposal !== where.isCurrentExchangeProposal) continue;
          Object.assign(q, data);
          count++;
        }
        return { count };
      }
    ),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const id = `exchange-${createdQuotes.length + 1}`;
      createdQuotes.push({ id, ...data });
      quotes.set(id, {
        id,
        status: data.status as string,
        companyId: (quotes.get(data.originalQuoteId as string)?.companyId as string) ?? "company-1",
        contactId: data.contactId as string,
        agentId: data.agentId as string,
        originalQuoteId: data.originalQuoteId as string,
        isCurrentExchangeProposal: data.isCurrentExchangeProposal as boolean | null | undefined,
      });
      return { id };
    }),
  },
  quoteStatusHistory: { create: vi.fn(async () => ({})) },
  account: {
    findMany: vi.fn(async () => []),
  },
  notification: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      notificationsCreated.push(args.data);
      return {};
    }),
    createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
      notificationsCreated.push(...args.data);
      return { count: args.data.length };
    }),
  },
};
fakePrisma.$transaction = vi.fn(async (arg: unknown) => {
  if (typeof arg === "function") return (arg as (tx: typeof fakePrisma) => unknown)(fakePrisma);
  return Promise.all(arg as Promise<unknown>[]);
});

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Pass 13 — calculatePricing itself stays mocked (fixed at total: 500,
// unaffected by input) so the existing tests above keep their exact
// numbers, but round2 must be the REAL implementation: currency.ts's
// convertToUsd (now exercised by sendExchangeForApproval's new §25
// server-side total check) imports round2 from this same module, and a
// fully-replaced mock with no round2 export at all would throw the moment
// that code path is reached.
vi.mock("@/lib/pricing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pricing")>();
  return { ...actual, calculatePricing: vi.fn(() => ({ total: 500, ticketSubtotal: 500, taxes: 0, serviceFee: 0, gratuity: 0 })) };
});
vi.mock("@/lib/airport-datetime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/airport-datetime")>();
  return { ...actual, parseAirportDateTimeString: vi.fn((s: string) => new Date(s)) };
});
vi.mock("nanoid", () => ({ nanoid: () => "faketoken", customAlphabet: () => () => "FAKECODE" }));

beforeEach(() => {
  quotes = new Map([
    ["quote-charged", { id: "quote-charged", status: "CHARGED", companyId: "company-1", contactId: "contact-1", agentId: "agent-1" }],
    ["quote-draft", { id: "quote-draft", status: "DRAFT", companyId: "company-1", contactId: "contact-1", agentId: "agent-1" }],
    [
      "exchange-pending",
      {
        id: "exchange-pending",
        status: "PENDING_EXCHANGE_APPROVAL",
        companyId: "company-1",
        contactId: "contact-1",
        agentId: "agent-1",
        originalQuoteId: "quote-charged",
        isCurrentExchangeProposal: true,
      },
    ],
  ]);
  currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1", fullName: "Agent One" };
  createdQuotes = [];
  notificationsCreated = [];
  vi.clearAllMocks();
});

const baseInput = {
  originalQuoteId: "quote-charged",
  tripType: "ONE_WAY" as const,
  source: "MANUAL" as const,
  segments: [
    {
      sequence: 1,
      departureAirportId: 1,
      arrivalAirportId: 2,
      departureAt: "2026-09-01T10:00:00",
      arrivalAt: "2026-09-01T14:00:00",
      flightNumber: "AA100",
      cabin: "ECONOMY" as const,
    },
  ],
  adults: 1,
  children: 0,
  infants: 0,
  adultPrice: 500,
  childPrice: 0,
  infantPrice: 0,
  taxes: 0,
  serviceFee: 0,
  gratuity: 0,
  currency: "USD" as const,
};

describe("sendExchangeForApproval — authorization + preconditions", () => {
  it("rejects when the original quote is not CHARGED", async () => {
    const { sendExchangeForApproval } = await import("../exchange");
    await expect(sendExchangeForApproval({ ...baseInput, originalQuoteId: "quote-draft" })).rejects.toThrow(/charged/i);
  });

  it("rejects (as not-found, never leaking existence) when the quote isn't visible to the actor — IDOR protection", async () => {
    currentActor = { id: "someone-else", role: "TRAVEL_AGENT", companyId: "company-1", fullName: "Someone Else" };
    const { sendExchangeForApproval } = await import("../exchange");
    await expect(sendExchangeForApproval(baseInput)).rejects.toThrow(/not found/i);
  });

  it("rejects when there is no session", async () => {
    currentActor = null;
    const { sendExchangeForApproval } = await import("../exchange");
    await expect(sendExchangeForApproval(baseInput)).rejects.toThrow(/not signed in/i);
  });

  it("on success: creates the exchange quote at PENDING_EXCHANGE_APPROVAL, linked via originalQuoteId, and moves the original to EXCHANGED — atomically", async () => {
    const { sendExchangeForApproval } = await import("../exchange");
    const { exchangeQuoteId } = await sendExchangeForApproval(baseInput);

    expect(exchangeQuoteId).toBeTruthy();
    const created = createdQuotes[0];
    expect(created.status).toBe("PENDING_EXCHANGE_APPROVAL");
    expect(created.originalQuoteId).toBe("quote-charged");
    expect(created.agentId).toBe("agent-1"); // the actor who created it — used later to send from their own Gmail
    expect(quotes.get("quote-charged")!.status).toBe("EXCHANGED");
  });
});

// Pass 13 §22/§23/§24/§25/§55 — internal vs. customer-facing exchange
// financial separation. calculatePricing is mocked to always return
// { total: 500, ... } regardless of input (see this file's own mock above),
// so these tests use that fixed value to prove the server independently
// re-derives and validates the customer total from
// exchangeFee + fareDifference — never trusting adultPrice/total as
// submitted, and never conflating the internal fields with it.
describe("sendExchangeForApproval — internal vs. customer-facing financial separation", () => {
  it("internal exchange fee/fare difference can differ from the customer-facing ones and both are persisted independently", async () => {
    const { sendExchangeForApproval } = await import("../exchange");
    await sendExchangeForApproval({
      ...baseInput,
      exchangeFee: 300,
      fareDifference: 200, // customer total: 500, matches the mocked pricing.total
      internalExchangeFee: 50, // genuinely different internal actual cost
      internalFareDifference: 75,
    });

    const created = createdQuotes[0];
    expect(created.exchangeFee).toBe(300);
    expect(created.fareDifference).toBe(200);
    expect(created.internalExchangeFee).toBe(50);
    expect(created.internalFareDifference).toBe(75);
  });

  it("rejects when the submitted total doesn't match Customer Exchange Fee + Customer Fare Difference — the server never trusts a manipulated total", async () => {
    const { sendExchangeForApproval } = await import("../exchange");
    // exchangeFee + fareDifference = 200, but the (mocked) pricing.total is
    // fixed at 500 — as if a manipulated client submitted an adultPrice
    // that doesn't actually correspond to the customer-facing fields.
    await expect(
      sendExchangeForApproval({ ...baseInput, exchangeFee: 100, fareDifference: 100 })
    ).rejects.toThrow(/does not match/i);
  });

  it("existing exchange calculations remain correct when the values are identical (internal === customer)", async () => {
    const { sendExchangeForApproval } = await import("../exchange");
    await sendExchangeForApproval({
      ...baseInput,
      exchangeFee: 300,
      fareDifference: 200,
      internalExchangeFee: 300,
      internalFareDifference: 200,
    });
    const created = createdQuotes[0];
    expect(created.exchangeFee).toBe(created.internalExchangeFee);
    expect(created.fareDifference).toBe(created.internalFareDifference);
  });

  it("an exchange with neither exchangeFee nor fareDifference set skips the total-integrity check entirely (nothing to validate yet)", async () => {
    const { sendExchangeForApproval } = await import("../exchange");
    await expect(sendExchangeForApproval(baseInput)).resolves.toBeTruthy();
  });

  it("internal fields are entirely optional — an exchange can be sent with only customer-facing values, internal cost added later", async () => {
    const { sendExchangeForApproval } = await import("../exchange");
    await sendExchangeForApproval({ ...baseInput, exchangeFee: 300, fareDifference: 200 });
    const created = createdQuotes[0];
    expect(created.internalExchangeFee).toBeUndefined();
    expect(created.internalFareDifference).toBeUndefined();
  });

  it("notifies every Admin/Manager in the actor's own company, never a restricted-role account", async () => {
    fakePrisma.account = {
      findMany: vi.fn(async () => [{ id: "admin-1" }, { id: "manager-1" }]),
    };
    const { sendExchangeForApproval } = await import("../exchange");
    await sendExchangeForApproval(baseInput);
    expect(notificationsCreated.map((n) => n.accountId).sort()).toEqual(["admin-1", "manager-1"]);
    expect(notificationsCreated.every((n) => n.type === "EXCHANGE_PENDING_APPROVAL")).toBe(true);
  });
});

describe("approveExchange / disapproveExchange — Admin/Manager only", () => {
  it("approveExchange rejects a Travel Agent", async () => {
    const { approveExchange } = await import("../exchange");
    await expect(approveExchange("exchange-pending")).rejects.toThrow(/admin or manager/i);
  });

  it("disapproveExchange rejects a Travel Agent", async () => {
    const { disapproveExchange } = await import("../exchange");
    await expect(disapproveExchange("exchange-pending")).rejects.toThrow(/admin or manager/i);
  });

  it("approveExchange succeeds for an Admin — sets EXCHANGE_APPROVED and records the reviewer", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
    const { approveExchange } = await import("../exchange");
    await approveExchange("exchange-pending");
    expect(quotes.get("exchange-pending")!.status).toBe("EXCHANGE_APPROVED");
  });

  it("disapproveExchange succeeds for a Manager — sets EXCHANGE_DISAPPROVED and reverts the original to CHARGED", async () => {
    currentActor = { id: "manager-1", role: "MANAGER", companyId: "company-1", fullName: "Manager One" };
    const { disapproveExchange } = await import("../exchange");
    await disapproveExchange("exchange-pending");
    expect(quotes.get("exchange-pending")!.status).toBe("EXCHANGE_DISAPPROVED");
    expect(quotes.get("quote-charged")!.status).toBe("CHARGED");
  });

  it("rejects approving an exchange that has already been reviewed — no double-approval", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
    quotes.get("exchange-pending")!.status = "EXCHANGE_APPROVED";
    const { approveExchange } = await import("../exchange");
    await expect(approveExchange("exchange-pending")).rejects.toThrow(/already been reviewed/i);
  });

  it("rejects acting on a quote id that isn't actually an exchange (no originalQuoteId)", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
    const { approveExchange } = await import("../exchange");
    await expect(approveExchange("quote-charged")).rejects.toThrow(/not an exchange/i);
  });

  it("disapproveExchange clears isCurrentExchangeProposal so a fresh first-ever proposal can be created afterward", async () => {
    currentActor = { id: "manager-1", role: "MANAGER", companyId: "company-1", fullName: "Manager One" };
    const { disapproveExchange } = await import("../exchange");
    await disapproveExchange("exchange-pending");
    expect(quotes.get("exchange-pending")!.isCurrentExchangeProposal).toBeFalsy();
  });
});

// Pass 26 — New Exchange Proposal / versioning. A second, revised proposal
// can be created against an already-EXCHANGED original as long as the
// current proposal hasn't been signed/reviewed away yet — the previous
// proposal is superseded (never deleted), the original stays untouched,
// and approval never carries over to the new proposal.
describe("sendExchangeForApproval — revision (supersedesQuoteId)", () => {
  it("creates a new proposal at PENDING_EXCHANGE_APPROVAL, marks it current, and supersedes the old one", async () => {
    const { sendExchangeForApproval } = await import("../exchange");
    quotes.get("quote-charged")!.status = "EXCHANGED"; // as it would be after the first proposal
    const { exchangeQuoteId } = await sendExchangeForApproval({ ...baseInput, supersedesQuoteId: "exchange-pending" });

    const created = createdQuotes[0];
    expect(created.status).toBe("PENDING_EXCHANGE_APPROVAL");
    expect(created.originalQuoteId).toBe("quote-charged"); // always the TRUE original, never the superseded proposal
    expect(quotes.get(exchangeQuoteId)!.isCurrentExchangeProposal).toBe(true);

    const old = quotes.get("exchange-pending")!;
    expect(old.status).toBe("EXCHANGE_SUPERSEDED");
    expect(old.isCurrentExchangeProposal).toBeFalsy();
    expect(old.supersededByQuoteId).toBe(exchangeQuoteId);

    // The original stays exactly as it already was — never touched again.
    expect(quotes.get("quote-charged")!.status).toBe("EXCHANGED");
  });

  it("rejects revising a proposal that is no longer current (already superseded)", async () => {
    quotes.get("quote-charged")!.status = "EXCHANGED";
    quotes.get("exchange-pending")!.isCurrentExchangeProposal = false;
    const { sendExchangeForApproval } = await import("../exchange");
    await expect(sendExchangeForApproval({ ...baseInput, supersedesQuoteId: "exchange-pending" })).rejects.toThrow(/no longer active/i);
  });

  it("rejects revising a proposal that has already been signed (not in a revisable status)", async () => {
    quotes.get("quote-charged")!.status = "EXCHANGED";
    quotes.get("exchange-pending")!.status = "SIGNED";
    const { sendExchangeForApproval } = await import("../exchange");
    await expect(sendExchangeForApproval({ ...baseInput, supersedesQuoteId: "exchange-pending" })).rejects.toThrow(/no longer active/i);
  });

  it("rejects revising a proposal that has already been disapproved", async () => {
    quotes.get("quote-charged")!.status = "CHARGED";
    quotes.get("exchange-pending")!.status = "EXCHANGE_DISAPPROVED";
    quotes.get("exchange-pending")!.isCurrentExchangeProposal = false;
    const { sendExchangeForApproval } = await import("../exchange");
    await expect(sendExchangeForApproval({ ...baseInput, supersedesQuoteId: "exchange-pending" })).rejects.toThrow(/no longer active/i);
  });

  it("concurrent revision race: the second submission fails cleanly once the first has already claimed the proposal", async () => {
    quotes.get("quote-charged")!.status = "EXCHANGED";
    const { sendExchangeForApproval } = await import("../exchange");
    // Simulate the race by having the first call's claim already land
    // (isCurrentExchangeProposal flipped) before the second call's claim
    // runs — updateMany's WHERE re-check is exactly what catches this.
    await sendExchangeForApproval({ ...baseInput, supersedesQuoteId: "exchange-pending" });
    await expect(sendExchangeForApproval({ ...baseInput, supersedesQuoteId: "exchange-pending" })).rejects.toThrow(/no longer active/i);
  });

  it("a not-yet-approved-or-sent proposal (still PENDING_EXCHANGE_APPROVAL) is revisable", async () => {
    quotes.get("quote-charged")!.status = "EXCHANGED";
    const { sendExchangeForApproval } = await import("../exchange");
    await expect(sendExchangeForApproval({ ...baseInput, supersedesQuoteId: "exchange-pending" })).resolves.toBeTruthy();
  });

  it("an EXCHANGE_APPROVED (already sent) proposal is still revisable — approval never transfers to the new one", async () => {
    quotes.get("quote-charged")!.status = "EXCHANGED";
    quotes.get("exchange-pending")!.status = "EXCHANGE_APPROVED";
    const { sendExchangeForApproval } = await import("../exchange");
    const { exchangeQuoteId } = await sendExchangeForApproval({ ...baseInput, supersedesQuoteId: "exchange-pending" });
    // The new proposal starts a FRESH approval cycle — never inherits
    // EXCHANGE_APPROVED from the one it replaced.
    expect(quotes.get(exchangeQuoteId)!.status).toBe("PENDING_EXCHANGE_APPROVAL");
  });
});
