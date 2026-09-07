import { describe, it, expect, vi, beforeEach } from "vitest";

// sendEmail() is now a thin delegation to sendViaGmail() — the actual
// Gmail-API sending logic has its own dedicated test file
// (gmail-send.test.ts). This just locks in the delegation contract: every
// field sendEmail() receives reaches sendViaGmail() unchanged, and the
// result comes straight back.

const sendViaGmail = vi.fn();
vi.mock("@/server/email/gmail-send", () => ({
  sendViaGmail: (...args: [unknown]) => sendViaGmail(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendEmail — delegates to sendViaGmail", () => {
  it("passes every field through unchanged and returns the result as-is on success", async () => {
    sendViaGmail.mockResolvedValue({ ok: true, messageId: "gmail-msg-1" });
    const { sendEmail } = await import("../service");

    const input = {
      accountId: "acct-1",
      to: "customer@example.com",
      subject: "Your quote",
      html: "<p>hi</p>",
      senderName: "David Chen",
      replyTo: "david.chen@compasstools.dev",
    };
    const result = await sendEmail(input);

    expect(sendViaGmail).toHaveBeenCalledWith(input);
    expect(result).toEqual({ ok: true, messageId: "gmail-msg-1" });
  });

  it("returns a failure result as-is, including its error code", async () => {
    sendViaGmail.mockResolvedValue({ ok: false, code: "NOT_CONNECTED", error: "Gmail is not connected. Connect Gmail to send emails from your account." });
    const { sendEmail } = await import("../service");

    const result = await sendEmail({ accountId: "acct-1", to: "a@example.com", subject: "s", html: "h" });

    expect(result).toEqual({ ok: false, code: "NOT_CONNECTED", error: expect.stringContaining("Connect Gmail") });
  });
});
