// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// The Lead page and the Sequence page must show the SAME status for the same enrollment (the reported defect: a failed attempt looked "enrolled" on the lead
// while the sequence said failed), a failed attempt must never look like a successful active enrollment, and the recovery actions must do what they say.
// Server actions are mocked; the rules behind them are tested in server/actions/__tests__/sequences.test.ts.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
const toast = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast }));
const retry = vi.fn();
const resolve = vi.fn();
vi.mock("@/server/actions/sequences", () => ({
  startSequenceForLead: vi.fn(),
  getSequenceStartReadiness: vi.fn(),
  unenrollLead: vi.fn(async () => ({ ok: true })),
  retryEnrollmentNow: (...a: unknown[]) => retry(...a),
  resolveUncertainDelivery: (...a: unknown[]) => resolve(...a),
}));
const connect = vi.fn();
vi.mock("@/server/actions/gmail-connect", () => ({ startGmailConnect: (...a: unknown[]) => connect(...a) }));

const { LeadSequencesPanel } = await import("@/components/leads/lead-sequences-panel");
const { SequenceEnrollmentsTable } = await import("../sequence-enrollments-table");

const STEPS = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
const D = (day: number, h = 9) => new Date(2026, 10, day, h);
const SENT = (stepId: string, day: number) => ({ stepId, status: "SENT" as const, sentAt: D(day), createdAt: D(day), error: null });
const FAIL = (stepId: string, error: string, day = 14) => ({ stepId, status: "FAILED" as const, sentAt: null, createdAt: D(day), error });

type Case = { name: string; label: string; status: "ACTIVE" | "FAILED" | "UNSUBSCRIBED" | "COMPLETED"; currentStepIdx: number; nextSendAt: Date | null; logs: ReturnType<typeof SENT | typeof FAIL>[]; sequenceActive?: boolean };
const CASES: Case[] = [
  { name: "first email pending", label: "First email pending", status: "ACTIVE", currentStepIdx: 0, nextSendAt: D(20), logs: [] },
  { name: "active (progressing)", label: "Active", status: "ACTIVE", currentStepIdx: 1, nextSendAt: D(20), logs: [SENT("s1", 14)] },
  { name: "retry scheduled after a temporary failure", label: "Retry scheduled", status: "ACTIVE", currentStepIdx: 0, nextSendAt: D(16), logs: [FAIL("s1", "Gmail could not send this email. Please try again.")] },
  { name: "delivery unconfirmed", label: "Delivery unconfirmed", status: "ACTIVE", currentStepIdx: 0, nextSendAt: null, logs: [FAIL("s1", "UNCERTAIN: Could not confirm that Gmail sent this email (no response).")] },
  { name: "paused (sequence switched off)", label: "Paused", status: "ACTIVE", currentStepIdx: 1, nextSendAt: D(20), logs: [SENT("s1", 14)], sequenceActive: false },
  { name: "failed (Gmail not connected at send time)", label: "Failed", status: "FAILED", currentStepIdx: 0, nextSendAt: null, logs: [FAIL("s1", "Gmail is not connected. Connect Gmail to send emails from your account.")] },
  { name: "unenrolled", label: "Unenrolled", status: "UNSUBSCRIBED", currentStepIdx: 1, nextSendAt: null, logs: [SENT("s1", 14)] },
  { name: "completed", label: "Completed", status: "COMPLETED", currentStepIdx: 3, nextSendAt: null, logs: [SENT("s1", 10), SENT("s2", 12), SENT("s3", 14)] },
];

const leadEnrollment = (c: Case, id = "e1") => ({
  id,
  status: c.status,
  currentStepIdx: c.currentStepIdx,
  enrolledAt: D(10),
  nextSendAt: c.nextSendAt,
  completedAt: c.status === "COMPLETED" ? D(14) : null,
  sequence: { id: "seq-1", name: "Welcome Series", isActive: c.sequenceActive ?? true, steps: STEPS },
  enrolledBy: { fullName: "Jane Doe" },
  stepLogs: c.logs,
});
const tableRow = (c: Case, id = "e1") => ({
  id,
  leadId: "lead-1",
  status: c.status,
  currentStepIdx: c.currentStepIdx,
  enrolledAt: D(10),
  nextSendAt: c.nextSendAt,
  recipientEmail: null,
  leadVisible: true,
  lead: { contact: { firstName: "Ada", lastName: "Lovelace", primaryEmail: "ada@example.com" } },
  stepLogs: c.logs,
});

const renderLead = (c: Case) => render(<LeadSequencesPanel leadId="lead-1" enrollments={[leadEnrollment(c)] as never} availableSequences={[]} />);
const renderTable = (c: Case) => render(<SequenceEnrollmentsTable enrollments={[tableRow(c)] as never} steps={STEPS} sequenceName="Welcome Series" sequenceActive={c.sequenceActive ?? true} canUnenroll />);

beforeEach(() => vi.clearAllMocks());

describe("Lead page and Sequence page show the same status", () => {
  it.each(CASES)("$name -> '$label' on both", (c) => {
    const lead = renderLead(c);
    const leadItem = (c.status === "ACTIVE" ? screen.getByTestId("active-sequence") : screen.getByTestId("sequence-history-item")) as HTMLElement;
    expect(within(leadItem).getByText(c.label)).toBeInTheDocument();
    lead.unmount();
    renderTable(c);
    expect(within(screen.getByTestId("enrollment-row")).getByText(c.label)).toBeInTheDocument();
  });
});

describe("a failed attempt never looks like a successful active enrollment", () => {
  it("a FAILED enrollment is not in the Active region at all; it is in the history, labelled Failed, with the real reason", () => {
    const failed = CASES.find((c) => c.label === "Failed")!;
    renderLead(failed);
    expect(screen.queryByTestId("active-sequence")).toBeNull();
    const item = screen.getByTestId("sequence-history-item");
    expect(item).toHaveTextContent("Failed");
    expect(item).toHaveTextContent(/Gmail is not connected/);
    expect(item).toHaveTextContent(/no further emails will be sent unless it is retried/);
  });

  it("an active enrollment whose last attempt failed says so, instead of looking healthy (and shows the scheduled retry)", () => {
    renderLead(CASES.find((c) => c.label === "Retry scheduled")!);
    const card = screen.getByTestId("active-sequence");
    expect(within(card).getByTestId("retry-note")).toHaveTextContent(/last attempt failed: Gmail could not send this email.*retried automatically at Nov 16, 2026/);
    expect(card).toHaveTextContent("Nothing sent yet");
  });

  it("the active card never claims a step was sent that was not (last sent comes from the send log)", () => {
    renderLead(CASES.find((c) => c.label === "Active")!);
    expect(screen.getByTestId("active-sequence")).toHaveTextContent(/Last sent: step 1 \(Nov 14, 2026 at 9:00 AM\)/);
    expect(screen.getByTestId("active-sequence")).toHaveTextContent(/Step 2 of 3/);
    expect(screen.getByTestId("active-sequence")).toHaveTextContent(/Next email: Nov 20, 2026 at 9:00 AM/);
  });

  it("a paused enrollment promises no send time", () => {
    renderLead(CASES.find((c) => c.label === "Paused")!);
    const card = screen.getByTestId("active-sequence");
    expect(within(card).getByTestId("sequence-inactive-note")).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/Next email/);
  });

  it("the lead card shows enrollment date/time, status, current step, last sent and next step, plus Unenroll", () => {
    renderLead(CASES.find((c) => c.label === "Active")!);
    const card = screen.getByTestId("active-sequence");
    expect(card).toHaveTextContent(/Enrolled Nov 10, 2026 at 9:00 AM/);
    expect(card).toHaveTextContent("Active");
    expect(within(card).getByRole("button", { name: /Unenroll from Welcome Series/ })).toBeInTheDocument();
  });
});

describe("recovery actions follow the state, on both pages", () => {
  const buttons = (root: HTMLElement) => within(root).queryAllByRole("button").map((b) => b.textContent?.trim());

  it.each([
    ["Retry scheduled", ["Retry now"]],
    ["Failed", ["Retry"]],
    ["Delivery unconfirmed", ["It was sent", "Send again"]],
    ["Active", []],
    ["First email pending", []],
    ["Completed", []],
    ["Unenrolled", []],
  ])("%s offers %j", (label, expected) => {
    const c = CASES.find((x) => x.label === label)!;
    renderLead(c);
    const root = (c.status === "ACTIVE" ? screen.getByTestId("active-sequence") : screen.getByTestId("sequence-history-item")) as HTMLElement;
    const recovery = buttons(root).filter((t) => t && !/^Unenroll$/.test(t));
    expect(recovery).toEqual(expected);
  });

  it("'Retry now' calls the retry action for THIS enrollment and lead, reports success and refreshes both pages' data", async () => {
    retry.mockResolvedValue({ ok: true, outcome: "sent", nextSendAt: D(20).toISOString() });
    renderLead(CASES.find((c) => c.label === "Retry scheduled")!);
    await userEvent.setup().click(screen.getByRole("button", { name: /Retry Welcome Series now/ }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("e1", "lead-1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });

  it("if Gmail is still not usable, the retry shows the Gmail notification (with Connect Gmail when it is the viewer's own) and claims nothing", async () => {
    retry.mockResolvedValue({
      ok: false,
      error: "Gmail is not connected. Your Gmail is not connected. No emails have been sent and this lead has not been enrolled.",
      gmail: { problem: "NOT_CONNECTED", needsReconnect: true, senderName: "Jane Doe", senderIsViewer: true },
    });
    const user = userEvent.setup();
    renderLead(CASES.find((c) => c.label === "Failed")!);
    await user.click(screen.getByRole("button", { name: /Retry Welcome Series now/ }));
    const notice = await screen.findByTestId("gmail-problem");
    expect(notice).toHaveAttribute("data-problem", "NOT_CONNECTED");
    expect(toast.success).not.toHaveBeenCalled();
    await user.click(within(notice).getByRole("button", { name: "Connect Gmail" }));
    await waitFor(() => expect(connect).toHaveBeenCalledWith("/leads/lead-1"));
  });

  it("'Send again' warns that the customer may get two copies and only then calls the action; 'It was sent' asks for confirmation too", async () => {
    resolve.mockResolvedValue({ ok: true, outcome: "sent", nextSendAt: null });
    const user = userEvent.setup();
    renderLead(CASES.find((c) => c.label === "Delivery unconfirmed")!);
    await user.click(screen.getByRole("button", { name: "Send again" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/two copies/i);
    expect(resolve).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("e1", "resend", "lead-1"));

    resolve.mockClear();
    await user.click(screen.getByRole("button", { name: "It was sent" }));
    const confirmSent = await screen.findByRole("alertdialog");
    expect(confirmSent).toHaveTextContent(/Sent folder/i);
    await user.click(within(confirmSent).getByRole("button", { name: "Yes, it was sent" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("e1", "sent", "lead-1"));
  });

  it("the sequence page's table offers the same actions, and none for a viewer who may not manage sequences", () => {
    const c = CASES.find((x) => x.label === "Delivery unconfirmed")!;
    const view = renderTable(c);
    expect(within(screen.getByTestId("enrollment-row")).getByRole("button", { name: "It was sent" })).toBeInTheDocument();
    expect(within(screen.getByTestId("enrollment-row")).getByRole("button", { name: "Send again" })).toBeInTheDocument();
    view.unmount();
    render(<SequenceEnrollmentsTable enrollments={[tableRow(c)] as never} steps={STEPS} sequenceName="Welcome Series" sequenceActive canUnenroll={false} />);
    expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();
  });

  it("the table says why an enrollment is held or retrying, and never 'None yet' for a held first step it did not send", () => {
    renderTable(CASES.find((c) => c.label === "Delivery unconfirmed")!);
    const row = screen.getByTestId("enrollment-row");
    expect(row).toHaveTextContent(/Gmail did not confirm this email/);
    expect(row).toHaveTextContent("0 of 3 sent");
    expect(row).toHaveTextContent("1: Unconfirmed");
    expect(row).toHaveTextContent("Held for you");
  });
});
