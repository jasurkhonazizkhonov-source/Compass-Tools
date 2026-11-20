// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// Lead -> Apply Sequence when the Gmail account that sends the lead's emails is not usable. Scenarios A and B of the task, at the UI level:
//   A: Gmail disconnected -> a clear notification, no confirmation, nothing enrolled/sent;
//   B: Gmail connected again -> the same choice is made again, Gmail is re-checked, the confirmation appears, Approve starts it.
// Server actions are mocked (their rules are tested in server/actions/__tests__/sequences.test.ts and gmail-readiness.test.ts); no email, no Google.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
const start = vi.fn();
const readiness = vi.fn();
vi.mock("@/server/actions/sequences", () => ({
  startSequenceForLead: (...a: unknown[]) => start(...a),
  getSequenceStartReadiness: (...a: unknown[]) => readiness(...a),
}));
const connect = vi.fn();
vi.mock("@/server/actions/gmail-connect", () => ({ startGmailConnect: (...a: unknown[]) => connect(...a) }));

const { ApplySequenceDialog } = await import("../apply-sequence-dialog");

const SEQS = [
  { id: "seq-1", name: "Welcome Series", description: null, stepCount: 3, firstStepDelayMinutes: 0 },
  { id: "seq-2", name: "Slow Burn", description: null, stepCount: 2, firstStepDelayMinutes: 120 },
];
const ok = { ok: true, sequenceName: "Welcome Series", senderName: "Jane Doe", senderIsViewer: true };
const blocked = (problem: string, over: Record<string, unknown> = {}, text = "Gmail is not connected. Your Gmail is not connected. No emails have been sent and this lead has not been enrolled.") => ({
  ok: false,
  code: "GMAIL_UNAVAILABLE",
  error: text,
  gmail: { problem, needsReconnect: problem !== "TEMPORARILY_UNAVAILABLE", senderName: "Jane Doe", senderIsViewer: true, ...over },
});

async function openAndContinue() {
  const user = userEvent.setup();
  render(<ApplySequenceDialog leadId="lead-1" sequences={SEQS} contactEmails={["ada@example.com"]} />);
  await user.click(screen.getByRole("button", { name: /Apply Sequence/ }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  return { user, dialog };
}

beforeEach(() => {
  vi.clearAllMocks();
  readiness.mockResolvedValue(ok);
  start.mockResolvedValue({ ok: true, sequenceName: "Welcome Series", firstStep: "sent", nextSendAt: null });
});

describe("Scenario A - Gmail not connected", () => {
  it("shows a clear notification instead of the confirmation, and creates nothing", async () => {
    readiness.mockResolvedValue(blocked("NOT_CONNECTED"));
    const { dialog } = await openAndContinue();
    const notice = await within(dialog).findByTestId("gmail-problem");
    expect(notice).toHaveAttribute("data-problem", "NOT_CONNECTED");
    expect(notice).toHaveTextContent("Gmail is not connected");
    expect(notice).toHaveTextContent(/No emails have been sent and this lead has not been enrolled/);
    expect(within(dialog).queryByTestId("sequence-approval")).toBeNull(); // no confirmation: there is nothing to approve
    expect(within(dialog).queryByRole("button", { name: "Approve and Start" })).toBeNull();
    expect(start).not.toHaveBeenCalled(); // nothing enrolled, nothing scheduled, nothing sent
    expect(refresh).not.toHaveBeenCalled();
  });

  it("offers to connect Gmail from this lead (and only that): the connect action is told to come back to THIS lead", async () => {
    readiness.mockResolvedValue(blocked("NOT_CONNECTED"));
    const { user, dialog } = await openAndContinue();
    await user.click(await within(dialog).findByRole("button", { name: "Connect Gmail" }));
    await waitFor(() => expect(connect).toHaveBeenCalledWith("/leads/lead-1"));
  });

  it("expired or revoked authorization says 'reconnect', with a Reconnect button", async () => {
    readiness.mockResolvedValue(blocked("REAUTH_REQUIRED", {}, "Gmail needs to be reconnected. Your Gmail authorization has expired or been revoked. No emails have been sent and this lead has not been enrolled."));
    const { dialog } = await openAndContinue();
    const notice = await within(dialog).findByTestId("gmail-problem");
    expect(notice).toHaveAttribute("data-problem", "REAUTH_REQUIRED");
    expect(notice).toHaveTextContent("Gmail needs to be reconnected");
    expect(within(notice).getByRole("button", { name: "Reconnect Gmail" })).toBeInTheDocument();
  });

  it("a missing send permission is its own message", async () => {
    readiness.mockResolvedValue(blocked("MISSING_PERMISSION", {}, "Gmail cannot send email. Your Gmail is connected, but the permission to send email was not granted."));
    const { dialog } = await openAndContinue();
    const notice = await within(dialog).findByTestId("gmail-problem");
    expect(notice).toHaveTextContent("Gmail cannot send email");
    expect(within(notice).getByRole("button", { name: "Reconnect Gmail" })).toBeInTheDocument();
  });

  it("a TEMPORARY Gmail problem never tells the user to connect Gmail: no Connect button, just 'Check again'", async () => {
    readiness.mockResolvedValue(blocked("TEMPORARILY_UNAVAILABLE", {}, "Gmail could not be checked right now. Nothing needs to be reconnected - try again in a moment."));
    const { dialog } = await openAndContinue();
    const notice = await within(dialog).findByTestId("gmail-problem");
    expect(notice).toHaveAttribute("data-problem", "TEMPORARILY_UNAVAILABLE");
    expect(within(notice).queryByRole("button", { name: /connect gmail|reconnect gmail/i })).toBeNull();
    expect(within(notice).getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });

  it("when someone else's Gmail is the problem (an administrator looking at an agent's lead) there is no connect button - it can only be connected from that person's own account", async () => {
    readiness.mockResolvedValue(blocked("NOT_CONNECTED", { senderIsViewer: false, senderName: "Jane Doe" }, "Gmail is not connected. Jane Doe's Gmail is not connected. Ask Jane Doe to connect Gmail from their account menu, then try again."));
    const { dialog } = await openAndContinue();
    const notice = await within(dialog).findByTestId("gmail-problem");
    expect(notice).toHaveTextContent("Ask Jane Doe to connect Gmail");
    expect(within(notice).queryByRole("button", { name: /connect gmail/i })).toBeNull();
  });
});

describe("Scenario B - Gmail connected, choose the same sequence again", () => {
  it("'Check again' re-checks Gmail for real, and when it is ready the confirmation appears; Approve and Start then starts the sequence", async () => {
    readiness.mockResolvedValueOnce(blocked("TEMPORARILY_UNAVAILABLE", {}, "Gmail could not be checked right now."));
    const { user, dialog } = await openAndContinue();
    // The button is disabled while the first check's transition is still settling; under a heavily loaded full run the click used to land on the disabled button and be
    // ignored (the cause of the intermittent failure - not the timeout). Wait until it is enabled, then click.
    const checkAgain = await within(dialog).findByRole("button", { name: "Check again" });
    await waitFor(() => expect(checkAgain).toBeEnabled(), { timeout: 15000 });
    await user.click(checkAgain);
    await waitFor(() => expect(readiness).toHaveBeenCalledTimes(2), { timeout: 15000 }); // generous: a 12-minute full run on a shared 8 GB machine starves jsdom tests (passes 3/3 alone; failed once at 5 s)
    const box = await within(dialog).findByTestId("sequence-approval");
    expect(box).toHaveTextContent("Welcome Series");
    expect(within(dialog).queryByTestId("gmail-problem")).toBeNull();
    expect(start).not.toHaveBeenCalled(); // approval is still the user's decision
    await user.click(within(dialog).getByRole("button", { name: "Approve and Start" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(start).toHaveBeenCalledWith("seq-1", "lead-1", undefined);
  });

  it("coming back after connecting (a fresh dialog): the choice is checked again from scratch, with no stale notice", async () => {
    readiness.mockResolvedValueOnce(blocked("NOT_CONNECTED"));
    const first = await openAndContinue();
    await within(first.dialog).findByTestId("gmail-problem");
    first.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await first.user.click(screen.getByRole("button", { name: /Apply Sequence/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByTestId("gmail-problem")).toBeNull();
    await first.user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(await within(dialog).findByTestId("sequence-approval")).toBeInTheDocument();
  });

  it("while Gmail is being checked the button says so and cannot be pressed twice", async () => {
    let release: (v: unknown) => void = () => {};
    readiness.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const user = userEvent.setup();
    render(<ApplySequenceDialog leadId="lead-1" sequences={SEQS} contactEmails={["ada@example.com"]} />);
    await user.click(screen.getByRole("button", { name: /Apply Sequence/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    const busy = await within(dialog).findByRole("button", { name: /Checking Gmail/ });
    expect(busy).toBeDisabled();
    release(ok);
    expect(await within(dialog).findByTestId("sequence-approval")).toBeInTheDocument();
    expect(readiness).toHaveBeenCalledTimes(1);
  });

  it("choosing a different sequence clears an earlier notice", async () => {
    readiness.mockResolvedValueOnce(blocked("NOT_CONNECTED"));
    const { user, dialog } = await openAndContinue();
    await within(dialog).findByTestId("gmail-problem");
    await user.click(within(dialog).getByRole("radio", { name: /Slow Burn/ }));
    expect(within(dialog).queryByTestId("gmail-problem")).toBeNull();
  });
});

describe("Gmail stops working between the check and the approval", () => {
  it("the approval's own (server) check wins: back to the chooser with the notification, nothing claimed as started", async () => {
    start.mockResolvedValueOnce({
      ok: false,
      code: "GMAIL_UNAVAILABLE",
      error: "Gmail needs to be reconnected. Your Gmail authorization has expired or been revoked. No emails have been sent and this lead has not been enrolled.",
      gmail: { problem: "REAUTH_REQUIRED", needsReconnect: true, senderName: "Jane Doe", senderIsViewer: true },
    });
    const { user, dialog } = await openAndContinue();
    await user.click(await within(dialog).findByRole("button", { name: "Approve and Start" }));
    const notice = await within(dialog).findByTestId("gmail-problem");
    expect(notice).toHaveAttribute("data-problem", "REAUTH_REQUIRED");
    expect(within(dialog).queryByTestId("sequence-approval")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("a non-Gmail reason is shown as a plain message", () => {
  it("already enrolled / no email / inactive come back from the readiness check and block the confirmation", async () => {
    readiness.mockResolvedValue({ ok: false, code: "SEQUENCE_INACTIVE", error: "This sequence is inactive. Switch it to Active before enrolling leads." });
    const { dialog } = await openAndContinue();
    expect(await within(dialog).findByTestId("start-blocked")).toHaveTextContent(/inactive/i);
    expect(within(dialog).queryByTestId("sequence-approval")).toBeNull();
    expect(within(dialog).queryByTestId("gmail-problem")).toBeNull();
  });

  it("a readiness check that itself fails (network) says nothing was changed and offers no false 'connect Gmail' advice", async () => {
    readiness.mockRejectedValueOnce(new Error("network"));
    const { dialog } = await openAndContinue();
    expect(await within(dialog).findByTestId("start-blocked")).toHaveTextContent(/Nothing was changed/);
    expect(within(dialog).queryByRole("button", { name: /connect gmail/i })).toBeNull();
  });
});
