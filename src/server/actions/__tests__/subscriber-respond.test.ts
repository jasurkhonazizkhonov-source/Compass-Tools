import { describe, it, expect, vi, beforeEach } from "vitest";

// "Respond" to a customer who unsubscribed: a personal one-to-one email through the same Gmail core
// the Lead/Contact composers use — and never a change to the subscription.

type FakeSubscriber = { id: string; companyId: string; email: string; status: "SUBSCRIBED" | "UNSUBSCRIBED"; unsubscribeReason: string | null; unsubscribeRespondedAt: Date | null; unsubscribeRespondedById: string | null; unsubscribedAt: Date | null };
let subscribers: Map<string, FakeSubscriber>;
let currentActor: { id: string; role: string; companyId: string; fullName: string; email: string; phone: string | null } | null;
let gmailState: "CONNECTED" | "REVOKED" | "NOT_CONNECTED";
const sendEmail = vi.fn();
/* eslint-disable @typescript-eslint/no-unused-vars */
const emailLogCreate = vi.fn(async (_args: unknown) => ({}));
const logActivity = vi.fn(async (_args: unknown) => undefined);
/* eslint-enable @typescript-eslint/no-unused-vars */

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/email/service", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@/server/activity-log", () => ({ logActivity: (a: unknown) => logActivity(a) }));
vi.mock("@/server/queries/gmail-connection", () => ({ getGmailConnectionState: vi.fn(async () => gmailState) }));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({
    id: "co-1",
    name: "Meridian Air Charter",
    website: "https://meridian.example.com",
    phone: "+1 555 010 0100",
    brandColor: "#1c3a5e",
    logoEmailUrl: null,
    logoWebUrl: "",
    logoIconUrl: "",
    signatureTemplate: "Kind regards,\n{{first_name}} {{last_name}}",
  })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscriber: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; companyId: string } }) => {
        const s = subscribers.get(where.id);
        return s && s.companyId === where.companyId ? s : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; companyId: string; status: string }; data: Record<string, unknown> }) => {
        const s = subscribers.get(where.id);
        if (s && s.companyId === where.companyId && s.status === where.status) {
          Object.assign(s, data);
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    emailLog: { create: (a: unknown) => emailLogCreate(a) },
  },
}));

const MARKETING = { id: "mkt-1", role: "MARKETING_AGENT", companyId: "company-1", fullName: "Mia Marketer", email: "mia@meridian.example.com", phone: "555-0100" };
const INPUT = { subject: "Regarding your email preferences", body: "Hello,\n\nThank you for letting us know.\n\nKind regards" };

beforeEach(() => {
  gmailState = "CONNECTED";
  currentActor = { ...MARKETING };
  sendEmail.mockReset().mockResolvedValue({ ok: true, messageId: "gmail-1" });
  emailLogCreate.mockClear();
  logActivity.mockClear();
  subscribers = new Map([
    ["sub-un", { id: "sub-un", companyId: "company-1", email: "jane@example.com", status: "UNSUBSCRIBED", unsubscribeReason: "I receive too many emails.", unsubscribeRespondedAt: null, unsubscribeRespondedById: null, unsubscribedAt: new Date("2026-10-01") }],
    ["sub-active", { id: "sub-active", companyId: "company-1", email: "active@example.com", status: "SUBSCRIBED", unsubscribeReason: null, unsubscribeRespondedAt: null, unsubscribeRespondedById: null, unsubscribedAt: null }],
    ["sub-other-co", { id: "sub-other-co", companyId: "company-2", email: "x@example.com", status: "UNSUBSCRIBED", unsubscribeReason: "secret", unsubscribeRespondedAt: null, unsubscribeRespondedById: null, unsubscribedAt: new Date() }],
  ]);
});

describe("respondToUnsubscribedSubscriber", () => {
  it("sends a PERSONAL email from the staff member's own Gmail to the stored address, replies to them, and logs it", async () => {
    const { respondToUnsubscribedSubscriber } = await import("../subscribers");
    const result = await respondToUnsubscribedSubscriber("sub-un", INPUT);
    expect(result).toEqual({ ok: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const args = sendEmail.mock.calls[0][0];
    expect(args).toMatchObject({ accountId: "mkt-1", to: "jane@example.com", subject: "Regarding your email preferences", senderName: "Mia Marketer", replyTo: "mia@meridian.example.com" });
    expect(args.bcc).toBeUndefined();
    expect(emailLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "SUBSCRIBER_EMAIL", status: "SENT", fromEmail: "mia@meridian.example.com", toEmail: "jane@example.com", messageId: "gmail-1" }) });
    expect(logActivity).not.toHaveBeenCalled(); // not tied to a lead or contact
  });

  it("uses the premium ONE-TO-ONE layout: the agent's words and signature, NO unsubscribe footer, NO marketing hero", async () => {
    const { respondToUnsubscribedSubscriber } = await import("../subscribers");
    await respondToUnsubscribedSubscriber("sub-un", INPUT);
    const html = sendEmail.mock.calls[0][0].html as string;
    expect(html).toContain("Thank you for letting us know.");
    expect(html).toContain("Kind regards,");
    expect(html).toContain("Mia Marketer");
    expect(html).not.toContain("Unsubscribe");
    expect(html).not.toContain("api/public/unsubscribe");
    expect(html).not.toContain('class="ct-hero-title"');
    expect(html).not.toMatch(/Compass Tools|CRM|Business Flights/i);
  });

  it("never copies the customer's private reason into the message", async () => {
    const { respondToUnsubscribedSubscriber } = await import("../subscribers");
    await respondToUnsubscribedSubscriber("sub-un", INPUT);
    expect(sendEmail.mock.calls[0][0].html).not.toContain("I receive too many emails");
  });

  it("does NOT touch the subscription: still UNSUBSCRIBED, reason and date intact — only the follow-up marker is set", async () => {
    const { respondToUnsubscribedSubscriber } = await import("../subscribers");
    await respondToUnsubscribedSubscriber("sub-un", INPUT);
    const s = subscribers.get("sub-un")!;
    expect(s.status).toBe("UNSUBSCRIBED");
    expect(s.unsubscribeReason).toBe("I receive too many emails.");
    expect(s.unsubscribedAt).toEqual(new Date("2026-10-01"));
    expect(s.unsubscribeRespondedAt).toBeInstanceOf(Date);
    expect(s.unsubscribeRespondedById).toBe("mkt-1");
  });

  it("a failed send is RETURNED (not thrown), logged as FAILED, and does not mark the customer as responded", async () => {
    sendEmail.mockResolvedValue({ ok: false, error: "quota exceeded" });
    const { respondToUnsubscribedSubscriber } = await import("../subscribers");
    expect(await respondToUnsubscribedSubscriber("sub-un", INPUT)).toEqual({ ok: false, error: "quota exceeded" });
    expect(emailLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "FAILED", errorMessage: "quota exceeded" }) });
    expect(subscribers.get("sub-un")!.unsubscribeRespondedAt).toBeNull();
  });

  it("Gmail not connected / needs reconnecting → an actionable returned error and nothing is sent", async () => {
    const { respondToUnsubscribedSubscriber } = await import("../subscribers");
    gmailState = "NOT_CONNECTED";
    expect(await respondToUnsubscribedSubscriber("sub-un", INPUT)).toMatchObject({ ok: false, error: expect.stringMatching(/Connect your Gmail/) });
    gmailState = "REVOKED";
    expect(await respondToUnsubscribedSubscriber("sub-un", INPUT)).toMatchObject({ ok: false, error: expect.stringMatching(/reconnected/) });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("only Admin and Marketing Agent may respond — every other role, and no session, is refused before anything is read or sent", async () => {
    const { respondToUnsubscribedSubscriber } = await import("../subscribers");
    for (const role of ["TRAVEL_AGENT", "MANAGER", "TICKETING_AGENT", "FLIGHT_EXPERT"]) {
      currentActor = { ...MARKETING, role };
      await expect(respondToUnsubscribedSubscriber("sub-un", INPUT), role).rejects.toThrow(/not authorized/i);
    }
    currentActor = null;
    await expect(respondToUnsubscribedSubscriber("sub-un", INPUT)).rejects.toThrow(/not authorized/i);
    expect(sendEmail).not.toHaveBeenCalled();
    currentActor = { ...MARKETING, role: "ADMIN" };
    expect(await respondToUnsubscribedSubscriber("sub-un", INPUT)).toEqual({ ok: true });
  });

  it("IDOR: another company's subscriber id is 'not found' — nothing is sent, and the reason is not disclosed", async () => {
    const { respondToUnsubscribedSubscriber } = await import("../subscribers");
    const result = await respondToUnsubscribedSubscriber("sub-other-co", INPUT);
    expect(result).toEqual({ ok: false, error: "Subscriber not found" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await respondToUnsubscribedSubscriber("no-such-id", INPUT)).toEqual({ ok: false, error: "Subscriber not found" });
  });

  it("a still-subscribed customer cannot be 'responded' to here (no stray mail), and an empty subject or message is rejected", async () => {
    const { respondToUnsubscribedSubscriber } = await import("../subscribers");
    expect(await respondToUnsubscribedSubscriber("sub-active", INPUT)).toMatchObject({ ok: false });
    expect(await respondToUnsubscribedSubscriber("sub-un", { subject: "  ", body: "x" })).toMatchObject({ ok: false });
    expect(await respondToUnsubscribedSubscriber("sub-un", { subject: "x", body: "" })).toMatchObject({ ok: false });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("the recipient comes from the stored record — a client cannot redirect the reply to another address", async () => {
    const { respondToUnsubscribedSubscriber } = await import("../subscribers");
    await respondToUnsubscribedSubscriber("sub-un", { ...INPUT, to: "attacker@evil.example" } as typeof INPUT);
    expect(sendEmail.mock.calls[0][0].to).toBe("jane@example.com");
  });

  it("a hostile message body is escaped, not interpreted", async () => {
    const { respondToUnsubscribedSubscriber } = await import("../subscribers");
    await respondToUnsubscribedSubscriber("sub-un", { subject: "Hi", body: "<script>alert(1)</script>" });
    const html = sendEmail.mock.calls[0][0].html as string;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
