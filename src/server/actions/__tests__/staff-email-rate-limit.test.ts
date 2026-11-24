import { describe, it, expect, vi, beforeEach } from "vitest";

// A staff member sending an email to a customer by hand (quote, airline confirmation, cancellation confirmation, reply to an inquiry) is limited per account. Each of the four
// actions asks the limiter FIRST (before any lookup and before anything can be sent), refuses with a wait time in plain words, and never reaches the mailer. The limiter itself
// (the counter, the window, the shared PostgreSQL row) is tested in src/server/security/__tests__/rate-limit*.test.ts.

const h = vi.hoisted(() => ({
  actor: { id: "acct-1", role: "ADMIN", status: "ACTIVE", companyId: "c1" } as Record<string, unknown> | null,
  limit: vi.fn(),
  reached: vi.fn(),
  sendEmail: vi.fn(),
}));

// Any database call reaching this proxy after the limiter said no is a failure of the guard. The ONE call that legitimately precedes the limiter (the booking-access check of the
// airline-confirmation action, which has to know who is acting and on what) is let through; everything else rejects and is recorded.
const allowedBefore: Record<string, Record<string, unknown>> = { booking: { findFirst: async () => ({ id: "b1" }) } };
const prismaGuard: unknown = new Proxy(
  {},
  {
    get: (_t, model: string) =>
      new Proxy(
        {},
        {
          get: (_t2, method: string) =>
            allowedBefore[model]?.[method] ??
            ((...args: unknown[]) => {
              h.reached(model, method, ...args);
              return Promise.reject(new Error("database reached after the limiter refused"));
            }),
        }
      ),
  }
);

vi.mock("@/lib/prisma", () => ({ prisma: prismaGuard }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => h.actor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/email/service", () => ({ sendEmail: (...a: unknown[]) => h.sendEmail(...a) }));
vi.mock("@/server/security/rate-limit", () => ({
  checkAccountRateLimit: (...a: unknown[]) => h.limit(...a),
  describeWait: (s: number) => `${Math.ceil(s / 60)} minutes`,
  RATE_LIMITS: { STAFF_EMAIL_SEND: { windowMs: 900_000, maxAttempts: 100 } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.actor = { id: "acct-1", role: "ADMIN", status: "ACTIVE", companyId: "c1" };
  h.limit.mockResolvedValue({ allowed: false, retryAfterSeconds: 420 });
});

const WAIT = /Too many emails sent in a short time\. Please try again in 7 minutes\./;

describe("the four staff-triggered customer emails ask the limiter first", () => {
  it("sendQuote: a returned refusal, no quote lookup, nothing sent", async () => {
    const { sendQuote } = await import("../quotes");
    const result = await sendQuote("q1");
    expect(result).toEqual({ ok: false, error: expect.stringMatching(WAIT) });
    expect(h.limit).toHaveBeenCalledWith("acct-1", "STAFF_EMAIL_SEND", expect.objectContaining({ maxAttempts: 100 }));
    expect(h.reached).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("sendQuote when nobody is signed in: the limiter is skipped (there is no account to count) and the existing sign-in check decides", async () => {
    h.actor = null;
    const { sendQuote } = await import("../quotes");
    await sendQuote("q1").catch(() => undefined);
    expect(h.limit).not.toHaveBeenCalled();
  });

  it("sendInquiryEmail: refused with the wait time before the inquiry is even looked up", async () => {
    const { sendInquiryEmail } = await import("../contact-inquiries");
    await expect(sendInquiryEmail("i1", { subject: "Hello", body: "Hello there" }, "CRM_WEBSITE")).rejects.toThrow(WAIT);
    expect(h.reached).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("sendAirlineConfirmationEmail: a returned refusal (never a thrown, masked error), the booking is not loaded, nothing sent", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    const result = await sendAirlineConfirmationEmail("b1");
    expect(result).toEqual({ ok: false, error: expect.stringMatching(WAIT) });
    expect(h.reached).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("sendCancellationConfirmationEmail: refused before the booking is loaded, nothing sent", async () => {
    h.actor = { id: "acct-1", role: "TICKETING_AGENT", status: "ACTIVE", companyId: "c1" };
    const { sendCancellationConfirmationEmail } = await import("../bookings");
    await expect(sendCancellationConfirmationEmail("b1")).rejects.toThrow(WAIT);
    expect(h.reached).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});
