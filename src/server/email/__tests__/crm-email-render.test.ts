import { describe, it, expect, vi, beforeEach } from "vitest";

// The one-to-one Lead/Contact send path rendered through the REAL templates
// (the other suites mock them): the premium personal layout must reach Gmail
// with every pre-existing guarantee intact — recipient allow-list, the agent as
// sender and reply-to, an EmailLog row, an Activity entry, and no unsubscribe
// line on a deliberate human message.

const sendEmail = vi.fn();
const emailLogCreate = vi.fn(async () => ({}));
const logActivity = vi.fn(async () => undefined);
let gmailState: "CONNECTED" | "REVOKED" | "NOT_CONNECTED" = "CONNECTED";

vi.mock("@/lib/prisma", () => ({ prisma: { emailLog: { create: (...a: unknown[]) => emailLogCreate(...(a as [])) } } }));
vi.mock("@/server/email/service", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@/server/activity-log", () => ({ logActivity: (...a: unknown[]) => logActivity(...(a as [])) }));
vi.mock("@/server/queries/gmail-connection", () => ({ getGmailConnectionState: vi.fn(async () => gmailState) }));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({
    id: "co-1",
    name: "Meridian Air Charter",
    website: "https://meridian.example.com",
    phone: "+1 555 010 0100",
    brandColor: "#1c3a5e",
    logoEmailUrl: "https://meridian.example.com/logo.png",
    logoWebUrl: "",
    logoIconUrl: "",
    signatureTemplate: "Kind regards,\n{{first_name}} {{last_name}}\n{{phone_number}}",
  })),
}));

import { sendCrmEmail, RecipientNotAllowedError } from "../crm-email";

const ACTOR = { id: "agent-1", fullName: "Jane Doe", email: "jane@meridian.example.com", phone: "555-1212" };
const ALLOWED = new Set(["customer@example.com", "Second@Example.com"]);

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue({ ok: true, messageId: "gmail-msg-1" });
  emailLogCreate.mockClear();
  logActivity.mockClear();
  gmailState = "CONNECTED";
});

describe("sendCrmEmail through the real premium templates", () => {
  it("sends the personal layout from the agent's own Gmail, replies to the agent, and logs it", async () => {
    await sendCrmEmail({ actor: ACTOR, to: "customer@example.com", subject: "Your Lisbon itinerary", body: "Hello Jordan,\n\nHere it is.", allowedRecipients: ALLOWED, leadId: "lead-1", emailLogType: "LEAD_EMAIL" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const args = sendEmail.mock.calls[0][0];
    expect(args).toMatchObject({ accountId: "agent-1", to: "customer@example.com", subject: "Your Lisbon itinerary", senderName: "Jane Doe", replyTo: "jane@meridian.example.com" });
    expect(args.bcc).toBeUndefined();
    // premium personal variant: logo header, the agent's words, refined signature, no hero, no unsubscribe
    expect(args.html).toContain("https://meridian.example.com/logo.png");
    expect(args.html).toContain("Hello Jordan,");
    expect(args.html).toContain("Kind regards,");
    expect(args.html).toContain('href="mailto:jane@meridian.example.com"');
    expect(args.html).not.toContain('class="ct-hero-title"');
    expect(args.html).not.toContain("Unsubscribe");
    expect(args.html).not.toMatch(/Compass Tools|CRM|Business Flights/i);
    expect(emailLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "LEAD_EMAIL", status: "SENT", fromEmail: "jane@meridian.example.com", toEmail: "customer@example.com", messageId: "gmail-msg-1", leadId: "lead-1" }) });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ leadId: "lead-1", actorId: "agent-1", type: "EMAIL_SENT" }));
  });

  it("a Contact email uses the identical layout and logs against the contact", async () => {
    await sendCrmEmail({ actor: ACTOR, to: "customer@example.com", subject: "Hello", body: "Hi there", allowedRecipients: ALLOWED, contactId: "contact-1", emailLogType: "CONTACT_EMAIL" });
    const lead = (await import("../templates")).buildSequenceEmail({ subject: "Hello", bodyText: "Hi there", agent: ACTOR, company: { id: "co-1", name: "Meridian Air Charter", website: "https://meridian.example.com", phone: "+1 555 010 0100", brandColor: "#1c3a5e", logoEmailUrl: "https://meridian.example.com/logo.png", logoWebUrl: "", logoIconUrl: "", signatureTemplate: "Kind regards,\n{{first_name}} {{last_name}}\n{{phone_number}}" } });
    expect(sendEmail.mock.calls[0][0].html).toBe(lead.html);
    expect(emailLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "CONTACT_EMAIL", contactId: "contact-1" }) });
  });

  it("still rejects a recipient that is not on file (case-insensitive match allowed), before anything is rendered or sent", async () => {
    await expect(sendCrmEmail({ actor: ACTOR, to: "attacker@evil.example", subject: "x", body: "y", allowedRecipients: ALLOWED, leadId: "lead-1", emailLogType: "LEAD_EMAIL" })).rejects.toBeInstanceOf(RecipientNotAllowedError);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(emailLogCreate).not.toHaveBeenCalled();
    await expect(sendCrmEmail({ actor: ACTOR, to: "SECOND@example.com", subject: "x", body: "y", allowedRecipients: ALLOWED, leadId: "lead-1", emailLogType: "LEAD_EMAIL" })).resolves.toEqual({ ok: true });
  });

  it("still refuses to send when Gmail is not connected or needs reconnecting", async () => {
    gmailState = "NOT_CONNECTED";
    await expect(sendCrmEmail({ actor: ACTOR, to: "customer@example.com", subject: "x", body: "y", allowedRecipients: ALLOWED, leadId: "l", emailLogType: "LEAD_EMAIL" })).rejects.toThrow(/Connect your Gmail/);
    gmailState = "REVOKED";
    await expect(sendCrmEmail({ actor: ACTOR, to: "customer@example.com", subject: "x", body: "y", allowedRecipients: ALLOWED, leadId: "l", emailLogType: "LEAD_EMAIL" })).rejects.toThrow(/reconnected/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a failed Gmail send is logged as FAILED, throws, and records no Activity entry", async () => {
    sendEmail.mockResolvedValue({ ok: false, error: "quota exceeded" });
    await expect(sendCrmEmail({ actor: ACTOR, to: "customer@example.com", subject: "x", body: "y", allowedRecipients: ALLOWED, leadId: "l", emailLogType: "LEAD_EMAIL" })).rejects.toThrow("quota exceeded");
    expect(emailLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "FAILED", errorMessage: "quota exceeded" }) });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("a very long, hostile body renders without throwing and without injecting markup", async () => {
    await sendCrmEmail({ actor: ACTOR, to: "customer@example.com", subject: "x", body: `<script>alert(1)</script>\n\n${"Ulaanbaatar ".repeat(500)}`, allowedRecipients: ALLOWED, leadId: "l", emailLogType: "LEAD_EMAIL" });
    const html = sendEmail.mock.calls[0][0].html as string;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
