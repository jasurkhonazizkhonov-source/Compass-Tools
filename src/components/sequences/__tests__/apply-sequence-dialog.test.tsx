// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// The lead's "Apply Sequence" flow: choose -> review -> Approve and start (one action) | Cancel (nothing happens). The server action is mocked; what it does
// is tested in server/actions/__tests__/sequences.test.ts (startSequenceForLead).

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
const toastSuccess = vi.fn();
const toastWarning = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), warning: (...a: unknown[]) => toastWarning(...a), error: (...a: unknown[]) => toastError(...a) } }));
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

async function openAndContinue(emails: string[] = ["ada@example.com"], pickSecond = false) {
  const user = userEvent.setup();
  render(<ApplySequenceDialog leadId="lead-1" sequences={SEQS} contactEmails={emails} />);
  await user.click(screen.getByRole("button", { name: /Apply Sequence/ }));
  const dialog = await screen.findByRole("dialog");
  if (pickSecond) await user.click(within(dialog).getByRole("radio", { name: /Slow Burn/ }));
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  return { user, dialog };
}

beforeEach(() => {
  vi.clearAllMocks();
  readiness.mockResolvedValue({ ok: true, sequenceName: "Welcome Series", senderName: "Jane Doe", senderIsViewer: true });
  start.mockResolvedValue({ ok: true, sequenceName: "Welcome Series", firstStep: "sent", nextSendAt: new Date(2026, 10, 17, 9).toISOString() });
});

describe("Apply Sequence - confirmation", () => {
  it("choosing a sequence shows a confirmation that states what will happen, and sends nothing yet", async () => {
    const { dialog } = await openAndContinue();
    const box = within(dialog).getByTestId("sequence-approval");
    expect(box).toHaveTextContent(/Welcome Series/);
    expect(box).toHaveTextContent(/first eligible email will be sent immediately/);
    expect(box).toHaveTextContent(/Sent from your Gmail to ada@example.com/);
    expect(box).toHaveTextContent(/remaining steps will be sent automatically/);
    expect(box).toHaveTextContent(/unenroll the lead at any time/);
    expect(within(dialog).getByRole("button", { name: "Approve and Start" })).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
  });

  it("a sequence whose first step has a delay says so", async () => {
    const { dialog } = await openAndContinue(["ada@example.com"], true);
    expect(within(dialog).getByTestId("sequence-approval")).toHaveTextContent(/first eligible email will be sent in 2 hours/);
  });

  it("Cancel on the confirmation enrolls nothing and closes the dialog", async () => {
    const { user, dialog } = await openAndContinue();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(start).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("Approve calls the single action once with the lead and sequence, reports success, closes and refreshes the lead", async () => {
    const { user, dialog } = await openAndContinue();
    await user.click(within(dialog).getByRole("button", { name: "Approve and Start" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("seq-1", "lead-1", undefined);
    expect(toastSuccess.mock.calls[0][0]).toMatch(/Welcome Series.*started.*first email was sent/);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  it("a second click while the first is still running does not call the action again", async () => {
    let finish: (v: unknown) => void = () => {};
    start.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const { user, dialog } = await openAndContinue();
    const approve = within(dialog).getByRole("button", { name: "Approve and Start" });
    await user.click(approve);
    await user.click(approve);
    await user.click(approve);
    expect(start).toHaveBeenCalledTimes(1);
    finish({ ok: true, sequenceName: "Welcome Series", firstStep: "sent", nextSendAt: null });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
  });

  it("a refusal stays in the dialog with the reason, and nothing is claimed as started", async () => {
    start.mockResolvedValueOnce({ ok: false, code: "SEND_FAILED", error: "The sequence was not started: Gmail is not connected." });
    const { user, dialog } = await openAndContinue();
    await user.click(within(dialog).getByRole("button", { name: "Approve and Start" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/not started: Gmail is not connected/);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("a first email that could not be sent yet is reported as a warning with the retry, not as plain success", async () => {
    start.mockResolvedValueOnce({ ok: true, sequenceName: "Welcome Series", firstStep: "retrying", nextSendAt: new Date(2026, 10, 15, 10).toISOString(), note: "rate limited" });
    const { user, dialog } = await openAndContinue();
    await user.click(within(dialog).getByRole("button", { name: "Approve and Start" }));
    await waitFor(() => expect(toastWarning).toHaveBeenCalled());
    expect(toastWarning.mock.calls[0][0]).toMatch(/could not be sent yet \(rate limited\).*retried automatically/);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("a thrown action (session expired, connection dropped) does not claim success: it says the result is unknown and refreshes", async () => {
    start.mockRejectedValueOnce(new Error("network"));
    const { user, dialog } = await openAndContinue();
    await user.click(within(dialog).getByRole("button", { name: "Approve and Start" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/result is not known/i);
    expect(refresh).toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("with several emails on file, the chosen recipients are shown in the confirmation and sent with the request", async () => {
    const { user, dialog } = await openAndContinue(["a@example.com", "b@example.com"]);
    expect(within(dialog).getByTestId("sequence-approval")).toHaveTextContent(/to a@example.com\./);
    await user.click(within(dialog).getByRole("button", { name: "Approve and Start" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("seq-1", "lead-1", "a@example.com"));
  });
});
