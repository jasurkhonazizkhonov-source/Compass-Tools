import { describe, it, expect, vi, beforeEach } from "vitest";
import { hasCachedCvv, claimCvvForAuthorization, __resetCvvCacheForTests } from "@/server/security/cvv-cache";

// Same in-memory-fake mocking convention as cvv-authorization.test.ts.
// cvv-cache.ts is deliberately NOT mocked — submitRecollectedCvv's whole
// point is that it flows into the exact same real cache every other CVV
// in this app uses, so these tests prove that against the real module.

type FakeAccount = { id: string; role: string; status: string; fullName: string; email: string; phone: string | null; paymentPermissions: string[] };
type FakeBooking = { id: string; quoteAgentId?: string; leadAssignedAgentId?: string; contactOwnerId?: string };
type FakePaymentMethod = { id: string; bookingId: string; contactId: string; cardBrand: string | null; last4: string };
type FakeContact = { firstName: string; primaryEmail: string | null };
type FakeRequest = { id: string; paymentMethodId: string; requestedById: string | null; token: string; expiresAt: Date; usedAt: Date | null; failedAttempts: number };

let currentActor: FakeAccount | null;
let bookings: Map<string, FakeBooking>;
let paymentMethods: Map<string, FakePaymentMethod>;
let contacts: Map<string, FakeContact>;
let requests: Map<string, FakeRequest>;
let auditLogs: Array<{ actorId: string | undefined; action: string; metadata: Record<string, unknown> }>;
let emailLogs: Array<Record<string, unknown>>;
let sendEmailCalls: Array<{ to: string }>;
let nextId = 1;

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("@/lib/company-config", () => ({ resolveBaseUrl: vi.fn(() => "https://example.com") }));
vi.mock("@/server/queries/company", () => ({
  getCompanyForContactId: vi.fn(async () => ({ id: "company-1", name: "Test Travel Co", brandColor: "#1c3a5e", logoEmailUrl: null, logoWebUrl: "", logoIconUrl: "", website: null, phone: null, signatureTemplate: "" })),
}));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (args: { to: string }) => {
    sendEmailCalls.push({ to: args.to });
    return { ok: true as const, messageId: `msg-${sendEmailCalls.length}` };
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(async ({ data }: { data: { actorId: string | undefined; action: string; metadata: Record<string, unknown> } }) => {
        auditLogs.push(data);
        return data;
      }),
    },
    emailLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        emailLogs.push(data);
        return data;
      }),
    },
    paymentMethod: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => paymentMethods.get(id) ?? null),
    },
    contact: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => contacts.get(id) ?? null),
      // canAccessPaymentMethod ALSO checks contactVisibilityWhere
      // independently of the booking check (a card can be attached to
      // both) — {ownerId: X} for a restricted role, {companyId: X} for a
      // broad-visibility role. This fixture's contacts are never
      // owner-restricted (no ownerId concept tracked here), so a
      // {companyId} query always matches and an {ownerId} query never
      // does — sufficient for these tests, which only need the booking
      // side of the check to actually exercise ownership restriction.
      findFirst: vi.fn(async ({ where }: { where: { id: string; companyId?: string; ownerId?: string } }) => {
        if (!contacts.has(where.id)) return null;
        if (where.ownerId !== undefined) return null;
        return { id: where.id };
      }),
    },
    booking: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = bookings.get(where.id as string);
        if (!row) return null;
        const or = where.OR as Array<Record<string, Record<string, string>>> | undefined;
        if (or) {
          const matches = or.some((cond) => {
            if (cond.quote?.agentId) return row.quoteAgentId === cond.quote.agentId;
            if (cond.lead?.assignedAgentId) return row.leadAssignedAgentId === cond.lead.assignedAgentId;
            if (cond.contact?.ownerId) return row.contactOwnerId === cond.contact.ownerId;
            return false;
          });
          if (!matches) return null;
        }
        return { id: row.id };
      }),
    },
    cvvRecollectionRequest: {
      create: vi.fn(async ({ data }: { data: { paymentMethodId: string; requestedById?: string; expiresAt: Date } }) => {
        const id = `req-${nextId++}`;
        const row: FakeRequest = { id, paymentMethodId: data.paymentMethodId, requestedById: data.requestedById ?? null, token: `token-${id}`, expiresAt: data.expiresAt, usedAt: null, failedAttempts: 0 };
        requests.set(id, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { token?: string; id?: string } }) => {
        const row = where.token ? [...requests.values()].find((r) => r.token === where.token) : requests.get(where.id!);
        if (!row) return null;
        return { ...row, paymentMethod: paymentMethods.get(row.paymentMethodId) };
      }),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: { failedAttempts?: { increment: number } } }) => {
        const row = requests.get(id)!;
        if (data.failedAttempts) row.failedAttempts += data.failedAttempts.increment;
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; usedAt: null }; data: { usedAt: Date } }) => {
        const row = requests.get(where.id);
        if (!row || row.usedAt !== where.usedAt) return { count: 0 };
        row.usedAt = data.usedAt;
        return { count: 1 };
      }),
    },
  },
}));

beforeEach(() => {
  bookings = new Map();
  paymentMethods = new Map();
  contacts = new Map();
  requests = new Map();
  auditLogs = [];
  emailLogs = [];
  sendEmailCalls = [];
  nextId = 1;
  __resetCvvCacheForTests();
  currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", fullName: "Admin User", email: "admin@example.com", phone: null, paymentPermissions: [] };
  vi.clearAllMocks();
});

function seedBookingAndCard(overrides: Partial<FakeBooking> = {}) {
  bookings.set("booking-1", { id: "booking-1", ...overrides });
  paymentMethods.set("pm-1", { id: "pm-1", bookingId: "booking-1", contactId: "contact-1", cardBrand: "Visa", last4: "1111" });
  contacts.set("contact-1", { firstName: "Andrew", primaryEmail: "andrew@example.com" });
}

describe("requestCvvRecollection — authorization", () => {
  it("denies a role without canAuthorizeSupplierPayment", async () => {
    seedBookingAndCard();
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", fullName: "Agent", email: "agent@example.com", phone: null, paymentPermissions: ["payments.manual_supplier_payment"] };
    const { requestCvvRecollection } = await import("../cvv-recollection");
    const result = await requestCvvRecollection("pm-1");
    expect(result.ok).toBe(false);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("denies access when the payment method resolves to neither an accessible booking nor an accessible contact (IDOR/BOLA, fail-closed)", async () => {
    // Every role eligible for canAuthorizeSupplierPayment (Admin/Manager/
    // Ticketing Agent) already has company-wide booking/contact visibility
    // by design (see canViewAllRecords) — so the realistic IDOR boundary
    // here isn't "a different owner within the same company" (every
    // eligible role already sees those), it's canAccessPaymentMethod's own
    // fail-closed behavior when NEITHER relation resolves at all, e.g. a
    // stale/dangling reference. Proven directly by seeding a payment
    // method whose bookingId/contactId don't exist in this fixture.
    paymentMethods.set("pm-orphan", { id: "pm-orphan", bookingId: "booking-does-not-exist", contactId: "contact-does-not-exist", cardBrand: "Visa", last4: "9999" });
    const { requestCvvRecollection } = await import("../cvv-recollection");
    const result = await requestCvvRecollection("pm-orphan");
    expect(result.ok).toBe(false);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("an Admin succeeds: creates a request row, emails the customer, and audits success", async () => {
    seedBookingAndCard();
    const { requestCvvRecollection } = await import("../cvv-recollection");
    const result = await requestCvvRecollection("pm-1");
    expect(result.ok).toBe(true);
    expect(sendEmailCalls).toHaveLength(1);
    expect(sendEmailCalls[0].to).toBe("andrew@example.com");
    expect(requests.size).toBe(1);
    expect(auditLogs.some((a) => a.action === "CVV_RECOLLECTION_REQUESTED")).toBe(true);
  });

  it("never includes a CVV or PAN in the audit log or email log metadata", async () => {
    seedBookingAndCard();
    const { requestCvvRecollection } = await import("../cvv-recollection");
    await requestCvvRecollection("pm-1");
    const serialized = JSON.stringify([...auditLogs, ...emailLogs]);
    expect(serialized).not.toContain("4111111111111111");
  });

  it("fails cleanly (no request row created) when the contact has no email on file", async () => {
    seedBookingAndCard();
    contacts.set("contact-1", { firstName: "Andrew", primaryEmail: null });
    const { requestCvvRecollection } = await import("../cvv-recollection");
    const result = await requestCvvRecollection("pm-1");
    expect(result.ok).toBe(false);
    expect(requests.size).toBe(0);
  });
});

describe("submitRecollectedCvv — the customer's own public submission", () => {
  async function seedRequest(overrides: Partial<FakeRequest> = {}) {
    seedBookingAndCard();
    const { requestCvvRecollection } = await import("../cvv-recollection");
    await requestCvvRecollection("pm-1");
    const request = [...requests.values()][0];
    Object.assign(request, overrides);
    return request;
  }

  it("an unknown token is rejected with a generic message", async () => {
    const { submitRecollectedCvv } = await import("../cvv-recollection");
    const result = await submitRecollectedCvv("does-not-exist", "123");
    expect(result.ok).toBe(false);
  });

  it("a valid CVV caches it via the SAME real cache every other CVV flow uses", async () => {
    const request = await seedRequest();
    const { submitRecollectedCvv } = await import("../cvv-recollection");
    const result = await submitRecollectedCvv(request.token, "123");
    expect(result.ok).toBe(true);
    expect(hasCachedCvv("pm-1")).toBe(true);
    expect(claimCvvForAuthorization("pm-1", "admin-1")).toBe("123");
  });

  it("is single-use — a second submission with the same token is rejected, even with a correct CVV", async () => {
    const request = await seedRequest();
    const { submitRecollectedCvv } = await import("../cvv-recollection");
    await submitRecollectedCvv(request.token, "123");
    __resetCvvCacheForTests(); // isolate: prove the SECOND submit is rejected by the request's own usedAt guard, not just because the cache already had a value
    const second = await submitRecollectedCvv(request.token, "456");
    expect(second.ok).toBe(false);
    expect(hasCachedCvv("pm-1")).toBe(false);
  });

  it("an expired request is rejected even with a correct-format CVV", async () => {
    const request = await seedRequest({ expiresAt: new Date(Date.now() - 1000) });
    const { submitRecollectedCvv } = await import("../cvv-recollection");
    const result = await submitRecollectedCvv(request.token, "123");
    expect(result.ok).toBe(false);
    expect(hasCachedCvv("pm-1")).toBe(false);
  });

  it("an invalid CVV format is rejected and increments the failed-attempt counter", async () => {
    const request = await seedRequest();
    const { submitRecollectedCvv } = await import("../cvv-recollection");
    const result = await submitRecollectedCvv(request.token, "12"); // too short for Visa
    expect(result.ok).toBe(false);
    expect(requests.get(request.id)!.failedAttempts).toBe(1);
    expect(hasCachedCvv("pm-1")).toBe(false);
  });

  it("locks the request out permanently after the max failed attempts — never unlimited guessing against a leaked link", async () => {
    const request = await seedRequest();
    const { submitRecollectedCvv } = await import("../cvv-recollection");
    for (let i = 0; i < 5; i++) {
      await submitRecollectedCvv(request.token, "99"); // wrong format each time
    }
    // Even a CORRECT CVV is now rejected — the request itself is dead, not just rate-limited.
    const afterLockout = await submitRecollectedCvv(request.token, "123");
    expect(afterLockout.ok).toBe(false);
    expect(hasCachedCvv("pm-1")).toBe(false);
  });
});

// Job 3 — the /cvv-recollection/[token] page's state comes entirely from
// getCvvRecollectionRequestSummary. These prove the page gets the right
// signal for each real-world visit: a first, still-open link; the SAME
// link re-opened after a successful confirmation (previously
// indistinguishable from a broken link — this is what fixes the
// repeated-link 404); a token that never existed at all (must still 404,
// no authorization weakened); and an expired/locked-out token (its own
// distinct non-404 state).
describe("getCvvRecollectionRequestSummary — page-state resolution", () => {
  async function seedRequest(overrides: Partial<FakeRequest> = {}) {
    seedBookingAndCard();
    const { requestCvvRecollection } = await import("../cvv-recollection");
    await requestCvvRecollection("pm-1");
    const request = [...requests.values()][0];
    Object.assign(request, overrides);
    return request;
  }

  it("returns AVAILABLE for a fresh, unused, unexpired token — the form should render", async () => {
    const request = await seedRequest();
    const { getCvvRecollectionRequestSummary } = await import("../cvv-recollection");
    const summary = await getCvvRecollectionRequestSummary(request.token);
    expect(summary).toEqual({ status: "AVAILABLE", cardBrand: "Visa", last4: "1111", companyName: "Test Travel Co" });
  });

  it("returns USED (not null) for the same link reopened after a successful confirmation — no more 404 for an already-confirmed token", async () => {
    const request = await seedRequest();
    const { submitRecollectedCvv, getCvvRecollectionRequestSummary } = await import("../cvv-recollection");
    const submitResult = await submitRecollectedCvv(request.token, "123");
    expect(submitResult.ok).toBe(true);

    const summary = await getCvvRecollectionRequestSummary(request.token);
    expect(summary).toEqual({ status: "USED", last4: "1111", companyName: "Test Travel Co" });
  });

  it("returns null for a token that never existed — still a plain 404, no state leaked", async () => {
    const { getCvvRecollectionRequestSummary } = await import("../cvv-recollection");
    const summary = await getCvvRecollectionRequestSummary("does-not-exist");
    expect(summary).toBeNull();
  });

  it("returns EXPIRED (not null) for a token past its TTL — its own state, distinct from both AVAILABLE and USED", async () => {
    const request = await seedRequest({ expiresAt: new Date(Date.now() - 1000) });
    const { getCvvRecollectionRequestSummary } = await import("../cvv-recollection");
    const summary = await getCvvRecollectionRequestSummary(request.token);
    expect(summary).toEqual({ status: "EXPIRED", companyName: "Test Travel Co" });
  });

  it("returns EXPIRED for a token locked out after too many failed attempts, even before its TTL passes", async () => {
    const request = await seedRequest({ failedAttempts: 5 });
    const { getCvvRecollectionRequestSummary } = await import("../cvv-recollection");
    const summary = await getCvvRecollectionRequestSummary(request.token);
    expect(summary).toEqual({ status: "EXPIRED", companyName: "Test Travel Co" });
  });
});
