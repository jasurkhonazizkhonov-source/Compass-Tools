import { describe, it, expect, vi, beforeEach } from "vitest";

// The airline-confirmation dialog for a viewer who may NOT see complete customer addresses: masked labels + opaque ids in, ids resolved on the server, a raw address
// refused, and the "sent to" confirmation masked. For viewers with full access the established shape is covered by send-airline-confirmation-email.test.ts.

let actor: { id: string; role: string; companyId: string; status: string; fullName: string; email: string };
let unlimited: boolean;
let revealed: boolean;
const sendEmailCalls: Array<Record<string, unknown>> = [];

// The per-account email limiter reads and writes a PostgreSQL counter; these tests are not about it (see src/server/actions/__tests__/staff-email-rate-limit.test.ts), so it always allows here.
vi.mock("@/server/security/rate-limit", () => ({ checkAccountRateLimit: vi.fn(async () => ({ allowed: true })), describeWait: (s: number) => `${s} seconds`, RATE_LIMITS: new Proxy({}, { get: () => ({ windowMs: 1000, maxAttempts: 1 }) }) }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/quote-status", () => ({ reconcileQuoteStatus: vi.fn(async () => ({ fireSideEffects: async () => {} })) }));
vi.mock("@/server/booking-notification", () => ({ sendBookingProfitNotification: vi.fn(async () => {}) }));
vi.mock("@/server/queries/company", () => ({ getCompanyForAccountId: vi.fn(async () => ({})), getCompanyForContactId: vi.fn(async () => ({})) }));
vi.mock("@/server/queries/reference-data", () => ({ resolveAirlineCodes: vi.fn(async () => ({})) }));
vi.mock("@/server/email/segment-mapper", () => ({ toEmailSegments: vi.fn(() => []) }));
vi.mock("@/server/email/templates", () => ({ buildBookingConfirmationEmail: vi.fn(() => ({ subject: "s", html: "h" })), buildCancellationConfirmedEmail: vi.fn(() => ({ subject: "s", html: "h" })) }));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (a: Record<string, unknown>) => {
    sendEmailCalls.push(a);
    return { ok: true, messageId: "m1" };
  }),
}));

const BOOKING = {
  id: "b1",
  contactId: "c1",
  status: "TICKETED",
  contactEmail: "jane.doe@example.com",
  airlineConfirmationNumber: "AA123",
  airlineConfirmations: null,
  ticketNumbers: null,
  airlineConfirmationFirstSentAt: null,
  contact: { primaryEmail: "jane.doe@example.com", emails: [{ email: "jane.doe@example.com", isPrimary: true }, { email: "alt.person@example.com", isPrimary: false }] },
  quote: { sentByAgent: { fullName: "Sender", email: "sender@crm.test" } },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: { findUnique: vi.fn(async () => ({ unlimitedCustomerEmailAccess: unlimited })), findMany: vi.fn(async () => []) },
    booking: {
      findFirst: vi.fn(async () => ({ id: "b1" })),
      findUniqueOrThrow: vi.fn(async () => ({ ...BOOKING, passengers: [], paymentMethods: [], quote: { ...BOOKING.quote, agent: null, itinerary: { segments: [] }, adultPrice: 0, childPrice: 0, infantPrice: 0, taxes: 0, serviceFee: 0, adults: 1, children: 0, infants: 0, currency: "USD", exchangeRate: null }, gratuityAmount: 0, totalAmount: 0 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    customerEmailRevealEvent: { findMany: vi.fn(async () => (revealed ? [{ contactId: "c1" }] : [])) },
    emailLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    activity: { create: vi.fn(async () => ({})) },
    paymentCharge: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

beforeEach(() => {
  actor = { id: "agent-1", role: "TICKETING_AGENT", companyId: "co-1", status: "ACTIVE", fullName: "Agent", email: "agent@crm.test" };
  unlimited = false;
  revealed = false;
  sendEmailCalls.length = 0;
});

describe("getAirlineConfirmationRecipients for a restricted viewer", () => {
  it("returns masked labels and opaque ids - the complete addresses are absent from the whole response", async () => {
    const { getAirlineConfirmationRecipients } = await import("../bookings");
    const res = await getAirlineConfirmationRecipients("b1");
    expect(res.recipients.map((r) => ({ id: (r as { id?: string }).id, email: r.email }))).toEqual([
      { id: "r0", email: "j******e@example.com" },
      { id: "r1", email: "a********n@example.com" },
    ]);
    expect(res.defaultSelected).toEqual(["r0"]);
    expect(JSON.stringify(res)).not.toMatch(/jane\.doe@|alt\.person@/);
  });

  it("after the customer was revealed today the labels are complete, but recipients are still addressed by id", async () => {
    revealed = true;
    const { getAirlineConfirmationRecipients } = await import("../bookings");
    const res = await getAirlineConfirmationRecipients("b1");
    expect(res.recipients[0]).toMatchObject({ id: "r0", email: "jane.doe@example.com" });
  });

  it("a viewer with full access keeps the established shape (the address is the key)", async () => {
    unlimited = true;
    const { getAirlineConfirmationRecipients } = await import("../bookings");
    const res = await getAirlineConfirmationRecipients("b1");
    expect(res.recipients.map((r) => r.email)).toEqual(["jane.doe@example.com", "alt.person@example.com"]);
    expect((res.recipients[0] as { id?: string }).id).toBeUndefined();
    expect(res.defaultSelected).toEqual(["jane.doe@example.com"]);
  });
});

describe("sendAirlineConfirmationEmail for a restricted viewer", () => {
  it("sends to the address behind the chosen id, and the confirmation it returns is masked", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    const r = await sendAirlineConfirmationEmail("b1", { recipientIds: ["r1"] });
    expect(r).toEqual({ ok: true, sentTo: ["a********n@example.com"] });
    expect(sendEmailCalls[0].to).toBe("alt.person@example.com");
  });

  it("refuses a raw address (it would be a probe for 'is this address on file?'), an unknown id, and an empty selection - nothing is sent", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    expect(await sendAirlineConfirmationEmail("b1", { recipients: ["jane.doe@example.com"] })).toMatchObject({ ok: false, error: expect.stringMatching(/Choose the recipients/) });
    expect(await sendAirlineConfirmationEmail("b1", { recipientIds: ["r9"] })).toMatchObject({ ok: false });
    expect(await sendAirlineConfirmationEmail("b1", { recipientIds: ["../x"] })).toMatchObject({ ok: false });
    expect(await sendAirlineConfirmationEmail("b1", { recipientIds: [] })).toMatchObject({ ok: false });
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("a viewer with full access can still send by address and sees the complete addresses in the result", async () => {
    unlimited = true;
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    expect(await sendAirlineConfirmationEmail("b1", { recipients: ["jane.doe@example.com"] })).toEqual({ ok: true, sentTo: ["jane.doe@example.com"] });
  });
});
