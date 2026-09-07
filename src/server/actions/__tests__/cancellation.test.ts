import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercises the Cancellation workflow's server actions in isolation.
// The single most security-relevant behavior tested here is the
// segment-id re-validation in sendCancellationForApproval: the caller
// picks which segments to cancel client-side, so the server must never
// trust that list without confirming every id actually belongs to the
// target quote's own itinerary (an IDOR-shaped input otherwise).

type FakeQuote = {
  id: string;
  status: string;
  companyId: string;
  contactId: string;
  agentId: string | null;
  segmentIds: string[];
  secureToken: string;
  quoteNumber: string;
  bookingId?: string;
};

type FakeRequest = {
  id: string;
  quoteId: string;
  segmentIds: string[];
  status: string;
};

let quotes: Map<string, FakeQuote>;
let requests: Map<string, FakeRequest>;
let passengers: Map<string, { id: string; bookingId: string; firstName: string; lastName: string; [key: string]: unknown }>;
let currentActor: { id: string; role: string; companyId: string; fullName: string } | null;
let createdRequests: Array<Record<string, unknown>>;
let notificationsCreated: Array<Record<string, unknown>>;
let emailsSent: Array<Record<string, unknown>>;

function segmentsFor(quoteId: string) {
  return (quotes.get(quoteId)?.segmentIds ?? []).map((id) => ({
    id,
    flightNumber: "AA100",
    bookingClass: "Y",
    cabin: "ECONOMY",
    departureAt: new Date("2026-09-01T10:00:00Z"),
    arrivalAt: new Date("2026-09-01T14:00:00Z"),
    durationMinutes: 240,
    airlineCodeRaw: "AA",
    connectionType: null,
    airline: null,
    aircraftType: null,
    aircraftRaw: null,
    operatingCarrierName: null,
    departureAirport: { iata: "LAX", city: "Los Angeles" },
    arrivalAirport: { iata: "JFK", city: "New York" },
    isExtraLeg: false,
  }));
}

const fakePrisma: Record<string, unknown> = {
  quote: {
    findFirst: vi.fn(async ({ where }: { where: { id: string } & Record<string, unknown> }) => {
      const q = quotes.get(where.id);
      if (!q || !currentActor) return null;
      const visible =
        currentActor.role === "ADMIN" || currentActor.role === "MANAGER"
          ? q.companyId === currentActor.companyId
          : q.agentId === currentActor.id;
      if (!visible) return null;
      return { ...q, itinerary: { segments: segmentsFor(q.id) } };
    }),
    // Public/unauthenticated lookup by secureToken — used by
    // confirmCancellationByCustomer, which has no actor/session at all.
    findUnique: vi.fn(async ({ where }: { where: { secureToken?: string } }) => {
      if (!where.secureToken) return null;
      const q = [...quotes.values()].find((qq) => qq.secureToken === where.secureToken);
      return q
        ? { ...q, booking: q.bookingId ? { id: q.bookingId } : null, contact: { firstName: "Jane", lastName: "Doe", primaryEmail: "jane@example.com" } }
        : null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeQuote> }) => {
      const q = quotes.get(where.id);
      if (!q) throw new Error("not found");
      Object.assign(q, data);
      return q;
    }),
    // Pass 22 — sendCancellationForm's atomic single-use claim
    // (`updateMany({ where: { id, status: "CANCELLATION_APPROVED" }, ... })`)
    // needs a real conditional match here, unlike plain `update` above —
    // this is what lets a race-condition regression test actually prove
    // the second of two concurrent calls sees count===0.
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; status?: string }; data: Partial<FakeQuote> }) => {
      const q = quotes.get(where.id);
      if (!q) return { count: 0 };
      if (where.status !== undefined && q.status !== where.status) return { count: 0 };
      Object.assign(q, data);
      return { count: 1 };
    }),
  },
  quoteCancellationRequest: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const id = `req-${createdRequests.length + 1}`;
      createdRequests.push({ id, ...data });
      requests.set(id, { id, quoteId: data.quoteId as string, segmentIds: data.segmentIds as string[], status: "PENDING" });
      return { id };
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const r = requests.get(where.id);
      if (!r) return null;
      const q = quotes.get(r.quoteId);
      if (!q) return null;
      return {
        ...r,
        quote: {
          id: q.id,
          status: q.status,
          secureToken: q.secureToken,
          currency: "USD",
          leadId: "lead-1",
          contactId: q.contactId,
          companyId: q.companyId,
          quoteNumber: q.quoteNumber,
          // Real Prisma's `include: { agent: true, ... }` always returns
          // every scalar column too (agentId/sentByAgentId included), not
          // just the relation object — this mock mirrors that shape so
          // canSendCancellationForm's authorization check (which reads the
          // scalar FKs, not the relation) is exercised realistically.
          agentId: q.agentId,
          sentByAgentId: null,
          agent: q.agentId ? { id: q.agentId, fullName: "Agent One", email: "agent@example.com", phone: "+10000000000" } : null,
          contact: { firstName: "Jane", emails: [{ email: "jane@example.com", isPrimary: true }], primaryEmail: "jane@example.com" },
          itinerary: { segments: segmentsFor(q.id) },
        },
      };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeRequest> }) => {
      const r = requests.get(where.id);
      if (!r) throw new Error("not found");
      Object.assign(r, data);
      return r;
    }),
  },
  quoteStatusHistory: { create: vi.fn(async () => ({})) },
  account: { findMany: vi.fn(async () => []) },
  notification: {
    createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
      notificationsCreated.push(...args.data);
      return { count: args.data.length };
    }),
  },
  emailLog: { create: vi.fn(async () => ({})) },
  passenger: {
    findMany: vi.fn(async ({ where }: { where: { bookingId: string } }) => {
      return [...passengers.values()].filter((p) => p.bookingId === where.bookingId).map((p) => ({ id: p.id }));
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const p = passengers.get(where.id);
      if (!p) throw new Error("passenger not found");
      Object.assign(p, data);
      return p;
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
const fakeCompany = {
  name: "Compass Tools",
  brandColor: "#1c3a5e",
  logoEmailUrl: null,
  website: null,
  phone: null,
  signatureTemplate: "{{first_name}} {{last_name}}\n{{phone_number}}",
};
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => fakeCompany),
  getCompanyForContactId: vi.fn(async () => fakeCompany),
}));
vi.mock("@/lib/company-config", () => ({
  resolveBaseUrl: vi.fn(() => "https://app.example.com"),
}));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (args: Record<string, unknown>) => {
    emailsSent.push(args);
    return { ok: true };
  }),
}));
// The IP-vault write itself is exhaustively covered in isolation by
// ip-capture.test.ts — here we only assert confirmCancellationByCustomer
// calls it with the right formType/bookingId/signer identity, which is a
// genuine, previously-missing gap (this signing event used to capture no
// IP at all, unlike the original booking signature).
let capturedIpCalls: Array<Record<string, unknown>>;
vi.mock("@/server/security/ip-capture", () => ({
  recordIpCapture: vi.fn(async (params: Record<string, unknown>) => {
    capturedIpCalls.push(params);
  }),
}));

beforeEach(() => {
  quotes = new Map([
    [
      "quote-charged",
      { id: "quote-charged", status: "CHARGED", companyId: "company-1", contactId: "contact-1", agentId: "agent-1", segmentIds: ["seg-1", "seg-2"], secureToken: "token-charged", quoteNumber: "Q-ORIG", bookingId: "booking-charged" },
    ],
    [
      "quote-draft",
      { id: "quote-draft", status: "DRAFT", companyId: "company-1", contactId: "contact-1", agentId: "agent-1", segmentIds: ["seg-3"], secureToken: "token-draft", quoteNumber: "Q-DRAFT" },
    ],
    [
      "quote-other",
      { id: "quote-other", status: "CHARGED", companyId: "company-1", contactId: "contact-2", agentId: "agent-2", segmentIds: ["seg-foreign"], secureToken: "token-other", quoteNumber: "Q-OTHER" },
    ],
  ]);
  requests = new Map();
  passengers = new Map([
    ["passenger-1", { id: "passenger-1", bookingId: "booking-charged", firstName: "Jane", lastName: "Doe" }],
    ["passenger-other", { id: "passenger-other", bookingId: "booking-other-customer", firstName: "OtherCustomer", lastName: "Traveler" }],
  ]);
  currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1", fullName: "Agent One" };
  createdRequests = [];
  notificationsCreated = [];
  emailsSent = [];
  capturedIpCalls = [];
  vi.clearAllMocks();
});

describe("sendCancellationForApproval — authorization + preconditions", () => {
  it("rejects when the quote is not CHARGED", async () => {
    const { sendCancellationForApproval } = await import("../cancellation");
    await expect(sendCancellationForApproval({ quoteId: "quote-draft", segmentIds: ["seg-3"] })).rejects.toThrow(/charged/i);
  });

  it("rejects when there is no session", async () => {
    currentActor = null;
    const { sendCancellationForApproval } = await import("../cancellation");
    await expect(sendCancellationForApproval({ quoteId: "quote-charged", segmentIds: ["seg-1"] })).rejects.toThrow(/not signed in/i);
  });

  it("rejects (not-found) when the quote isn't visible to the actor — IDOR protection", async () => {
    currentActor = { id: "someone-else", role: "TRAVEL_AGENT", companyId: "company-1", fullName: "Someone Else" };
    const { sendCancellationForApproval } = await import("../cancellation");
    await expect(sendCancellationForApproval({ quoteId: "quote-charged", segmentIds: ["seg-1"] })).rejects.toThrow(/not found/i);
  });

  it("rejects a segment id that does not belong to this quote's own itinerary — IDOR protection", async () => {
    const { sendCancellationForApproval } = await import("../cancellation");
    await expect(
      sendCancellationForApproval({ quoteId: "quote-charged", segmentIds: ["seg-1", "seg-foreign"] }),
    ).rejects.toThrow(/do not belong to this quote/i);
    // Nothing should have been persisted from the rejected attempt.
    expect(createdRequests).toHaveLength(0);
    expect(quotes.get("quote-charged")!.status).toBe("CHARGED");
  });

  it("accepts a single selected segment (not all) — cancellation is never assumed to mean every segment", async () => {
    const { sendCancellationForApproval } = await import("../cancellation");
    await sendCancellationForApproval({ quoteId: "quote-charged", segmentIds: ["seg-1"] });
    expect(createdRequests[0].segmentIds).toEqual(["seg-1"]);
    expect(quotes.get("quote-charged")!.status).toBe("PENDING_CANCELLATION_APPROVAL");
  });

  it("accepts multiple/all selected segments", async () => {
    const { sendCancellationForApproval } = await import("../cancellation");
    await sendCancellationForApproval({ quoteId: "quote-charged", segmentIds: ["seg-1", "seg-2"] });
    expect(createdRequests[0].segmentIds).toEqual(["seg-1", "seg-2"]);
  });

  it("notifies every Admin/Manager in the actor's own company", async () => {
    fakePrisma.account = { findMany: vi.fn(async () => [{ id: "admin-1" }]) };
    const { sendCancellationForApproval } = await import("../cancellation");
    await sendCancellationForApproval({ quoteId: "quote-charged", segmentIds: ["seg-1"] });
    expect(notificationsCreated.map((n) => n.accountId)).toEqual(["admin-1"]);
    expect(notificationsCreated[0].type).toBe("CANCELLATION_PENDING_APPROVAL");
  });
});

describe("confirmCancellation (approval-only) / disregardCancellation — Admin/Manager only", () => {
  function seedPendingRequest() {
    quotes.get("quote-charged")!.status = "PENDING_CANCELLATION_APPROVAL";
    requests.set("req-pending", { id: "req-pending", quoteId: "quote-charged", segmentIds: ["seg-1"], status: "PENDING" });
  }

  it("confirmCancellation rejects a Travel Agent", async () => {
    seedPendingRequest();
    const { confirmCancellation } = await import("../cancellation");
    await expect(confirmCancellation("req-pending")).rejects.toThrow(/admin or manager/i);
  });

  it("disregardCancellation rejects a Travel Agent", async () => {
    seedPendingRequest();
    const { disregardCancellation } = await import("../cancellation");
    await expect(disregardCancellation("req-pending")).rejects.toThrow(/admin or manager/i);
  });

  it("confirmCancellation succeeds for an Admin — request CONFIRMED + quote CANCELLATION_APPROVED, but NO customer email yet (Part 7's explicit distinction: approving does not mean the flight has already been cancelled)", async () => {
    seedPendingRequest();
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
    const { confirmCancellation } = await import("../cancellation");
    await confirmCancellation("req-pending");

    expect(requests.get("req-pending")!.status).toBe("CONFIRMED");
    expect(quotes.get("quote-charged")!.status).toBe("CANCELLATION_APPROVED");
    expect(emailsSent).toHaveLength(0);
  });

  it("disregardCancellation succeeds for a Manager — DISREGARDED + quote reverts to CHARGED + no customer email", async () => {
    seedPendingRequest();
    currentActor = { id: "manager-1", role: "MANAGER", companyId: "company-1", fullName: "Manager One" };
    const { disregardCancellation } = await import("../cancellation");
    await disregardCancellation("req-pending");

    expect(requests.get("req-pending")!.status).toBe("DISREGARDED");
    expect(quotes.get("quote-charged")!.status).toBe("CHARGED");
    expect(emailsSent).toHaveLength(0);
  });

  it("disregardCancellation also succeeds from CANCELLATION_APPROVED (approved, form not yet sent, Admin changes their mind)", async () => {
    seedPendingRequest();
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
    const { confirmCancellation, disregardCancellation } = await import("../cancellation");
    await confirmCancellation("req-pending");
    await disregardCancellation("req-pending");

    expect(requests.get("req-pending")!.status).toBe("DISREGARDED");
    expect(quotes.get("quote-charged")!.status).toBe("CHARGED");
  });

  it("rejects confirming a request that has already been reviewed", async () => {
    seedPendingRequest();
    requests.get("req-pending")!.status = "CONFIRMED";
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
    const { confirmCancellation } = await import("../cancellation");
    await expect(confirmCancellation("req-pending")).rejects.toThrow(/already been reviewed/i);
  });

  it("rejects when the request's parent quote isn't visible to the reviewing actor (cross-company IDOR)", async () => {
    quotes.get("quote-charged")!.companyId = "company-2";
    seedPendingRequest();
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
    const { confirmCancellation } = await import("../cancellation");
    await expect(confirmCancellation("req-pending")).rejects.toThrow(/not found/i);
  });
});

describe("sendCancellationForm — the separate, deliberate customer-notification step (Part 8)", () => {
  function seedApprovedRequest() {
    quotes.get("quote-charged")!.status = "CANCELLATION_APPROVED";
    requests.set("req-approved", { id: "req-approved", quoteId: "quote-charged", segmentIds: ["seg-1"], status: "CONFIRMED" });
  }

  it("allows the quote's own responsible agent (a Travel Agent, not Admin/Manager) to send the form", async () => {
    seedApprovedRequest();
    // beforeEach's default currentActor is agent-1 (TRAVEL_AGENT), which
    // is exactly this quote's agentId — the responsible agent.
    const { sendCancellationForm } = await import("../cancellation");
    const result = await sendCancellationForm("req-approved");
    expect(result.emailSent).toBe(true);
  });

  // Pass 13 §12/§30 — the CURRENT quote owner (agentId) is not necessarily
  // "the responsible agent" once ownership has moved on: sentByAgentId (the
  // original sender) takes precedence over agentId when both are known, so
  // a later reassignment can never silently redirect who's authorized to
  // send this customer-facing form. Uses ADMIN visibility for the raw quote
  // fetch to isolate this from the separate visibility layer, then swaps to
  // the (visible, since they own the quote today) but non-responsible agent
  // to prove canSendCancellationForm's own check is what's actually doing
  // the rejecting here.
  it("rejects the current quote owner when a DIFFERENT agent actually sent the quote (sentByAgentId takes precedence over agentId)", async () => {
    seedApprovedRequest();
    quotes.get("quote-charged")!.agentId = "agent-1"; // current owner — has visibility
    const cancellationRequestMock = fakePrisma.quoteCancellationRequest as Record<string, unknown>;
    const originalFindUnique = cancellationRequestMock.findUnique;
    cancellationRequestMock.findUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
      const r = requests.get(where.id);
      if (!r) return null;
      const q = quotes.get(r.quoteId)!;
      return {
        ...r,
        quote: {
          id: q.id, status: q.status, secureToken: q.secureToken, currency: "USD", leadId: "lead-1",
          contactId: q.contactId, companyId: q.companyId, quoteNumber: q.quoteNumber,
          agentId: "agent-1", sentByAgentId: "agent-2", // sent by a DIFFERENT agent than the current owner
          agent: { id: "agent-1", fullName: "Agent One", email: "agent@example.com", phone: "+10000000000" },
          contact: { firstName: "Jane", emails: [{ email: "jane@example.com", isPrimary: true }], primaryEmail: "jane@example.com" },
          itinerary: { segments: segmentsFor(q.id) },
        },
      };
    });
    try {
      currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1", fullName: "Agent One" };
      const { sendCancellationForm } = await import("../cancellation");
      await expect(sendCancellationForm("req-approved")).rejects.toThrow(/responsible agent/i);
    } finally {
      // This mock module is imported once and its object mutated directly
      // (see the module-scope `fakePrisma` above) — later tests in this
      // file share the SAME quoteCancellationRequest.findUnique reference,
      // so an override here must be restored, or it silently leaks into
      // every subsequent test (exactly the kind of test-pollution bug that
      // hid this pass's real notification-subject bug in the first place).
      cancellationRequestMock.findUnique = originalFindUnique;
    }
  });

  it("rejects a request that hasn't been approved yet (still PENDING)", async () => {
    quotes.get("quote-charged")!.status = "PENDING_CANCELLATION_APPROVAL";
    requests.set("req-approved", { id: "req-approved", quoteId: "quote-charged", segmentIds: ["seg-1"], status: "PENDING" });
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
    const { sendCancellationForm } = await import("../cancellation");
    await expect(sendCancellationForm("req-approved")).rejects.toThrow(/must be approved/i);
  });

  it("succeeds for an Admin — sends the customer email (never claiming the flight is already cancelled) and moves the quote to CANCELLATION_FORM_SENT", async () => {
    seedApprovedRequest();
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
    const { sendCancellationForm } = await import("../cancellation");
    const result = await sendCancellationForm("req-approved");

    expect(result.emailSent).toBe(true);
    expect(quotes.get("quote-charged")!.status).toBe("CANCELLATION_FORM_SENT");
    expect(emailsSent).toHaveLength(1);
    expect(emailsSent[0].accountId).toBe("agent-1");
    expect(emailsSent[0].to).toBe("jane@example.com");
    const subject = emailsSent[0].subject as string;
    expect(subject.toLowerCase()).not.toContain("confirmed");
    const html = emailsSent[0].html as string;
    expect(html).not.toMatch(/has been cancelled/i);
  });

  it("Pass 22 — a second call for the same request, after the first already succeeded, is rejected before sending a duplicate customer email", async () => {
    // Note on scope: this in-memory fake executes synchronously, so it
    // can't reproduce the exact "both requests' initial read already saw
    // CANCELLATION_APPROVED before either write landed" interleaving a
    // real concurrent Postgres race would hit — same acknowledged
    // limitation as booking-retry.test.ts's own comment on this. What IS
    // honestly provable here, and matters just as much in practice (a
    // double-click, a retried request, a slow first send overlapping a
    // second click): a second call can never re-send once the first has
    // gone through. The new atomic `quote.updateMany` claim inside
    // sendCancellationForm is what makes the underlying WHERE clause the
    // actual single-use gate against a real database, exactly like
    // Booking.quoteId's own unique constraint already does for
    // submitBooking (see booking-retry.test.ts).
    seedApprovedRequest();
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
    const { sendCancellationForm } = await import("../cancellation");
    await sendCancellationForm("req-approved");
    emailsSent = [];

    await expect(sendCancellationForm("req-approved")).rejects.toThrow(/must be approved/i);
    expect(emailsSent).toHaveLength(0);
  });

  it("Pass 24 — a genuine race: two truly concurrent sendCancellationForm calls (real Promise.allSettled) result in exactly ONE customer email, never two", async () => {
    // This fake's quote.updateMany (above) is a single, synchronous
    // (no internal await) read-check-write against the shared Map — the
    // exact same idiom send-airline-confirmation-email.test.ts's own
    // genuine-race test relies on to make two real concurrent Promise.all
    // callers faithfully exercise "only one can match". The Pass 22 note
    // above undersold what this fake can prove: it's the same mechanism,
    // just never exercised concurrently until now.
    seedApprovedRequest();
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
    const { sendCancellationForm } = await import("../cancellation");

    const [first, second] = await Promise.allSettled([sendCancellationForm("req-approved"), sendCancellationForm("req-approved")]);
    const results = [first, second];
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason.message).toMatch(/already been sent|must be approved/i);
    expect(emailsSent).toHaveLength(1);
    expect(quotes.get("quote-charged")!.status).toBe("CANCELLATION_FORM_SENT");
  });

  describe("resendCancellationForm — Pass 13 §31", () => {
    function seedSentRequest() {
      quotes.get("quote-charged")!.status = "CANCELLATION_FORM_SENT";
      requests.set("req-approved", { id: "req-approved", quoteId: "quote-charged", segmentIds: ["seg-1"], status: "CONFIRMED" });
    }

    it("resends the same email once the form has already been sent, without changing Quote.status again", async () => {
      seedSentRequest();
      currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
      const { resendCancellationForm } = await import("../cancellation");
      const result = await resendCancellationForm("req-approved");

      expect(result.emailSent).toBe(true);
      expect(emailsSent).toHaveLength(1);
      expect(emailsSent[0].to).toBe("jane@example.com");
      // Still CANCELLATION_FORM_SENT — a resend never re-transitions status
      // or marks the cancellation as completed.
      expect(quotes.get("quote-charged")!.status).toBe("CANCELLATION_FORM_SENT");
    });

    it("the quote's own responsible agent can resend, not just Admin/Manager", async () => {
      seedSentRequest();
      // beforeEach's default currentActor (agent-1) is this quote's agentId.
      const { resendCancellationForm } = await import("../cancellation");
      const result = await resendCancellationForm("req-approved");
      expect(result.emailSent).toBe(true);
    });

    it("rejects resend before the form has ever been sent (still only CANCELLATION_APPROVED)", async () => {
      seedApprovedRequest();
      currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
      const { resendCancellationForm } = await import("../cancellation");
      await expect(resendCancellationForm("req-approved")).rejects.toThrow(/resent/i);
    });

    it("rejects resend once the customer has already submitted (CANCELLATION_SUBMITTED) — past the point a resend makes sense", async () => {
      seedSentRequest();
      quotes.get("quote-charged")!.status = "CANCELLATION_SUBMITTED";
      currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
      const { resendCancellationForm } = await import("../cancellation");
      await expect(resendCancellationForm("req-approved")).rejects.toThrow(/resent/i);
    });

    it("does not create a duplicate booking/record — no booking-related Prisma call is made by a resend", async () => {
      seedSentRequest();
      currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
      const { resendCancellationForm } = await import("../cancellation");
      await resendCancellationForm("req-approved");
      // The fake Prisma has no `booking` model at all — if resendCancellationForm
      // tried to touch one, this test file's mock would throw synchronously
      // (undefined.create/update), so success here already proves no booking
      // write was attempted.
      expect(emailsSent).toHaveLength(1);
    });
  });

  it("rejects when the request's parent quote isn't visible to the actor (cross-company IDOR)", async () => {
    quotes.get("quote-charged")!.companyId = "company-2";
    seedApprovedRequest();
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin One" };
    const { sendCancellationForm } = await import("../cancellation");
    await expect(sendCancellationForm("req-approved")).rejects.toThrow(/not found/i);
  });
});

describe("confirmCancellationByCustomer — public, token-based, idempotent (Part 12/13)", () => {
  it("moves the quote from CANCELLATION_FORM_SENT to CANCELLATION_SUBMITTED", async () => {
    quotes.get("quote-charged")!.status = "CANCELLATION_FORM_SENT";
    const { confirmCancellationByCustomer } = await import("../cancellation");
    const result = await confirmCancellationByCustomer("token-charged");

    expect(result.alreadyConfirmed).toBe(false);
    expect(quotes.get("quote-charged")!.status).toBe("CANCELLATION_SUBMITTED");
  });

  it("captures an IP vault entry for this signing event — a genuine, previously-missing gap (this event used to capture no IP at all)", async () => {
    quotes.get("quote-charged")!.status = "CANCELLATION_FORM_SENT";
    const { confirmCancellationByCustomer } = await import("../cancellation");
    await confirmCancellationByCustomer("token-charged");

    expect(capturedIpCalls).toHaveLength(1);
    expect(capturedIpCalls[0].formType).toBe("CANCELLATION_CONFIRMATION");
    expect(capturedIpCalls[0].bookingId).toBe("booking-charged");
    expect(capturedIpCalls[0].signerEmail).toBe("jane@example.com");
    expect(capturedIpCalls[0].signerName).toBe("Jane Doe");
  });

  it("does NOT capture a second IP vault entry on an idempotent no-op re-confirmation", async () => {
    quotes.get("quote-charged")!.status = "CANCELLATION_SUBMITTED";
    const { confirmCancellationByCustomer } = await import("../cancellation");
    await confirmCancellationByCustomer("token-charged");
    expect(capturedIpCalls).toHaveLength(0);
  });

  it("is idempotent — a second click (already CANCELLATION_SUBMITTED) succeeds as a no-op rather than erroring", async () => {
    quotes.get("quote-charged")!.status = "CANCELLATION_SUBMITTED";
    const { confirmCancellationByCustomer } = await import("../cancellation");
    const result = await confirmCancellationByCustomer("token-charged");

    expect(result.alreadyConfirmed).toBe(true);
    expect(quotes.get("quote-charged")!.status).toBe("CANCELLATION_SUBMITTED");
  });

  it("rejects a quote that isn't actually at the form-sent stage (e.g. still just approved)", async () => {
    quotes.get("quote-charged")!.status = "CANCELLATION_APPROVED";
    const { confirmCancellationByCustomer } = await import("../cancellation");
    await expect(confirmCancellationByCustomer("token-charged")).rejects.toThrow(/isn't ready/i);
  });

  it("rejects an unknown/invalid token without leaking anything about why", async () => {
    const { confirmCancellationByCustomer } = await import("../cancellation");
    await expect(confirmCancellationByCustomer("not-a-real-token")).rejects.toThrow(/no longer valid/i);
  });

  it("requires no session — genuinely public/unauthenticated", async () => {
    currentActor = null;
    quotes.get("quote-charged")!.status = "CANCELLATION_FORM_SENT";
    const { confirmCancellationByCustomer } = await import("../cancellation");
    const result = await confirmCancellationByCustomer("token-charged");
    expect(result.alreadyConfirmed).toBe(false);
  });

  // Pass 13 §33/§34/§37 — the customer-edited passenger data submitted
  // alongside confirmation is what actually gets persisted, and only ever
  // to passengers that genuinely belong to THIS quote's own booking.
  describe("passenger data persistence (Pass 13 §33/§34/§37)", () => {
    it("persists the customer's edited passenger fields to the existing Passenger row", async () => {
      quotes.get("quote-charged")!.status = "CANCELLATION_FORM_SENT";
      const { confirmCancellationByCustomer } = await import("../cancellation");
      await confirmCancellationByCustomer("token-charged", [
        { id: "passenger-1", firstName: "Janet", lastName: "Doe-Smith", dateOfBirth: "1990-05-20", gender: "FEMALE", tsaKnownTravelerNumber: "12345678" },
      ]);

      const updated = passengers.get("passenger-1")!;
      expect(updated.firstName).toBe("Janet");
      expect(updated.lastName).toBe("Doe-Smith");
      expect(updated.tsaKnownTravelerNumber).toBe("12345678");
    });

    it("SECURITY — rejects a submitted passenger id that does not belong to this quote's own booking (cross-customer isolation)", async () => {
      quotes.get("quote-charged")!.status = "CANCELLATION_FORM_SENT";
      const { confirmCancellationByCustomer } = await import("../cancellation");
      await expect(
        confirmCancellationByCustomer("token-charged", [
          { id: "passenger-other", firstName: "Hacked", lastName: "Name" },
        ])
      ).rejects.toThrow();

      // The other customer's passenger record must be completely untouched.
      expect(passengers.get("passenger-other")!.firstName).toBe("OtherCustomer");
      // And the legitimate confirmation must not have gone through either
      // — a rejected passenger id fails the whole request, not a partial
      // silent skip.
      expect(quotes.get("quote-charged")!.status).toBe("CANCELLATION_FORM_SENT");
    });

    it("omitting passengers entirely still confirms normally — passenger review is additive, never required to complete cancellation", async () => {
      quotes.get("quote-charged")!.status = "CANCELLATION_FORM_SENT";
      const { confirmCancellationByCustomer } = await import("../cancellation");
      const result = await confirmCancellationByCustomer("token-charged");
      expect(result.alreadyConfirmed).toBe(false);
      expect(quotes.get("quote-charged")!.status).toBe("CANCELLATION_SUBMITTED");
    });

    it("an empty passengers array behaves the same as omitting it entirely", async () => {
      quotes.get("quote-charged")!.status = "CANCELLATION_FORM_SENT";
      const { confirmCancellationByCustomer } = await import("../cancellation");
      const result = await confirmCancellationByCustomer("token-charged", []);
      expect(result.alreadyConfirmed).toBe(false);
    });
  });
});
