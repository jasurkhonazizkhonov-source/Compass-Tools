// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// Sequences section -> Enroll Leads: the existing "Choose leads" mode and the new "By status" mode (multi-select over the CRM's own statuses, a
// server-computed live count, a confirmation step and an honest per-reason result). Server actions are mocked; their rules are tested in
// server/actions/__tests__/sequence-status-enroll.test.ts and sequences.test.ts.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) } }));
const enrollLeads = vi.fn();
vi.mock("@/server/actions/sequences", () => ({ enrollLeads: (...a: unknown[]) => enrollLeads(...a) }));
const preview = vi.fn();
const enrollByStatus = vi.fn();
vi.mock("@/server/actions/sequence-status-enroll", () => ({
  previewEnrollByStatus: (...a: unknown[]) => preview(...a),
  enrollLeadsByStatus: (...a: unknown[]) => enrollByStatus(...a),
}));

const { EnrollLeadsDialog } = await import("../enroll-leads-dialog");
const { LEAD_STATUS_META, LEAD_STATUS_ORDER } = await import("@/lib/status-meta");

const LEADS = [
  { id: "lead-1", name: "Ada Lovelace", route: "JFK - LHR", status: "BOOKED" },
  { id: "lead-2", name: "Bo Peep", route: "SFO - CDG", status: "QUOTED" },
];
const previewOk = (o: Record<string, unknown> = {}) => ({ ok: true, sequenceName: "Welcome Series", truncated: false, matched: 5, eligible: 3, alreadyActive: 1, missingEmail: 1, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0, ...o });

async function openStatusMode() {
  const user = userEvent.setup();
  render(<EnrollLeadsDialog sequenceId="seq-1" sequenceName="Welcome Series" leads={LEADS} />);
  await user.click(screen.getByRole("button", { name: /Enroll Leads/ }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "By status" }));
  return { user, dialog };
}

beforeEach(() => {
  vi.clearAllMocks();
  preview.mockResolvedValue(previewOk());
  enrollLeads.mockResolvedValue({ enrolled: 2, skipped: 0, alreadyActive: 0, missingEmail: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0, byLead: {} });
});

describe("By status — selecting", () => {
  it("lists exactly the CRM's own lead statuses, with their own labels, and names the sequence", async () => {
    const { dialog } = await openStatusMode();
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes).toHaveLength(LEAD_STATUS_ORDER.length);
    for (const s of LEAD_STATUS_ORDER) expect(within(dialog).getByRole("checkbox", { name: LEAD_STATUS_META[s].label })).toBeInTheDocument();
    expect(within(dialog).getByText("Welcome Series")).toBeInTheDocument();
    expect(within(dialog).getByText(/Select at least one status/)).toBeInTheDocument();
    expect(preview).not.toHaveBeenCalled(); // nothing selected, nothing asked of the server
  });

  it("one status: asks the server for the live count of that status and shows the breakdown", async () => {
    const { user, dialog } = await openStatusMode();
    await user.click(within(dialog).getByRole("checkbox", { name: "Booked" }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith({ sequenceId: "seq-1", statuses: ["BOOKED"], recipientMode: "primary" }));
    const box = await within(dialog).findByTestId("status-preview");
    await waitFor(() => expect(box.textContent).toMatch(/5 leads currently match; 3 can be enrolled in Welcome Series/));
    expect(box.textContent).toMatch(/1 lead already actively enrolled/);
    expect(box.textContent).toMatch(/1 lead without a valid email address/);
  });

  it("several statuses are sent together; Clear selection empties them and the count goes away", async () => {
    const { user, dialog } = await openStatusMode();
    await user.click(within(dialog).getByRole("checkbox", { name: "Attempting to Contact" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Booked" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Reached" }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith({ sequenceId: "seq-1", statuses: ["ATTEMPTING_TO_CONTACT", "BOOKED", "REACHED"], recipientMode: "primary" }));
    await user.click(within(dialog).getByRole("button", { name: "Clear selection" }));
    for (const b of within(dialog).getAllByRole("checkbox")) expect(b).not.toBeChecked();
    expect(within(dialog).getByText(/Select at least one status/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Review/ })).toBeDisabled();
  });

  it("Gmail problems and an over-large selection are shown plainly, and Review stays disabled when nothing can be enrolled", async () => {
    preview.mockResolvedValue(previewOk({ eligible: 0, gmailUnavailable: 2, gmailMessage: "Gmail is not connected. Agent One's Gmail is not connected" }));
    const { user, dialog } = await openStatusMode();
    await user.click(within(dialog).getByRole("checkbox", { name: "Booked" }));
    const box = await within(dialog).findByTestId("status-preview");
    await waitFor(() => expect(box.textContent).toMatch(/2 leads blocked because Gmail is unavailable - Gmail is not connected/));
    expect(within(dialog).getByRole("button", { name: /Review/ })).toBeDisabled();
    preview.mockResolvedValue(previewOk({ truncated: true }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Quoted" }));
    await waitFor(() => expect(box.textContent).toMatch(/Too many leads match/));
    expect(within(dialog).getByRole("button", { name: /Review/ })).toBeDisabled();
  });
});

describe("By status — confirming and the result", () => {
  it("enrolls only after an explicit confirmation, sends the chosen statuses plus the previewed count, and reports every category", async () => {
    enrollByStatus.mockResolvedValue({ ok: true, sequenceName: "Welcome Series", matched: 5, enrolled: 2, alreadyActive: 1, gmailUnavailable: 1, missingEmail: 1, noAssignedAgent: 0, inaccessible: 0, failedOther: 0, changedSincePreview: 2, gmailMessage: "Gmail is not connected." });
    const { user, dialog } = await openStatusMode();
    await user.click(within(dialog).getByRole("checkbox", { name: "Booked" }));
    const review = await within(dialog).findByRole("button", { name: /Review \(3\)/ });
    await user.click(review);
    expect(enrollByStatus).not.toHaveBeenCalled(); // a review is not an enrollment
    const confirm = within(dialog).getByRole("alertdialog", { name: "Confirm enrollment" });
    expect(confirm.textContent).toMatch(/Enroll 3 leads in Welcome Series/);
    await user.click(within(confirm).getByRole("button", { name: "Confirm enrollment" }));
    await waitFor(() => expect(enrollByStatus).toHaveBeenCalledWith({ sequenceId: "seq-1", statuses: ["BOOKED"], previewMatched: 5, recipientMode: "primary" }));
    const out = await within(dialog).findByTestId("status-outcome");
    expect(out.textContent).toMatch(/2 leads enrolled in Welcome Series out of 5 matching leads/);
    expect(out.textContent).toMatch(/Successfully enrolled: 2/);
    expect(out.textContent).toMatch(/Already actively enrolled: 1/);
    expect(out.textContent).toMatch(/Not enrolled because Gmail is unavailable: 1 - Gmail is not connected/);
    expect(out.textContent).toMatch(/Missing or invalid email address: 1/);
    expect(out.textContent).toMatch(/Status changed since the preview \(2 fewer or more leads matched than previewed\)/);
    expect(refresh).toHaveBeenCalled();
  });

  it("Back cancels the confirmation without enrolling", async () => {
    const { user, dialog } = await openStatusMode();
    await user.click(within(dialog).getByRole("checkbox", { name: "Booked" }));
    await user.click(await within(dialog).findByRole("button", { name: /Review \(3\)/ }));
    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
    expect(enrollByStatus).not.toHaveBeenCalled();
  });

  it("a server refusal is shown as an error, and nothing is claimed as enrolled", async () => {
    enrollByStatus.mockResolvedValue({ ok: false, error: "That sequence is not available." });
    const { user, dialog } = await openStatusMode();
    await user.click(within(dialog).getByRole("checkbox", { name: "Booked" }));
    await user.click(await within(dialog).findByRole("button", { name: /Review \(3\)/ }));
    await user.click(within(dialog).getByRole("button", { name: "Confirm enrollment" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("That sequence is not available.");
    expect(within(dialog).queryByText(/enrolled in/)).toBeNull();
  });
});

describe("Choose leads — the existing mode", () => {
  it("still enrolls the picked leads, and the toast now says what was and was not enrolled", async () => {
    enrollLeads.mockResolvedValue({ enrolled: 1, skipped: 1, alreadyActive: 1, missingEmail: 1, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0, byLead: {} });
    const user = userEvent.setup();
    render(<EnrollLeadsDialog sequenceId="seq-1" leads={LEADS} />);
    await user.click(screen.getByRole("button", { name: /Enroll Leads/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByText("Ada Lovelace"));
    await user.click(within(dialog).getByText("Bo Peep"));
    await user.click(within(dialog).getByRole("button", { name: "Enroll 2" }));
    await waitFor(() => expect(enrollLeads).toHaveBeenCalledWith("seq-1", ["lead-1", "lead-2"], undefined, { recipientMode: "primary" }));
    expect(toastSuccess).toHaveBeenCalledWith("Enrolled 1 lead (1 already enrolled, 1 without a valid email address)");
  });

  it("when Gmail blocks everything the toast shows the Gmail error and the dialog stays open", async () => {
    enrollLeads.mockResolvedValue({ enrolled: 0, skipped: 0, alreadyActive: 0, missingEmail: 0, noAssignedAgent: 0, gmailUnavailable: 1, inaccessible: 0, byLead: {}, error: "Gmail is not connected. Your Gmail is not connected." });
    const user = userEvent.setup();
    render(<EnrollLeadsDialog sequenceId="seq-1" leads={LEADS} />);
    await user.click(screen.getByRole("button", { name: /Enroll Leads/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByText("Ada Lovelace"));
    await user.click(within(dialog).getByRole("button", { name: "Enroll 1" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Gmail is not connected. Your Gmail is not connected."));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Which email addresses the sequence goes to", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preview.mockResolvedValue(previewOk());
  });

  it("choosing leads: defaults to the primary email, explains the consequence of \"all\", and sends the choice with the enrollment", async () => {
    enrollLeads.mockResolvedValue({ enrolled: 2, skipped: 0, alreadyActive: 0, missingEmail: 0, addressSuppressed: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0, byLead: {} });
    const user = userEvent.setup();
    render(<EnrollLeadsDialog sequenceId="seq-1" leads={LEADS} />);
    await user.click(screen.getByRole("button", { name: /Enroll Leads/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /Primary email only/ })).toBeChecked();
    expect(dialog.textContent).toMatch(/receives the same sequence at each of them/);
    await user.click(within(dialog).getByRole("radio", { name: /All available email addresses/ }));
    await user.click(within(dialog).getByText("Ada Lovelace"));
    await user.click(within(dialog).getByRole("button", { name: "Enroll 1" }));
    await waitFor(() => expect(enrollLeads).toHaveBeenCalledWith("seq-1", ["lead-1"], undefined, { recipientMode: "all" }));
  });

  it("by status: the choice changes the live count, and is sent with the confirmed enrollment; unsubscribed or suppressed addresses are listed as their own reason", async () => {
    preview.mockResolvedValue(previewOk({ addressSuppressed: 2 }));
    enrollByStatus.mockResolvedValue({ ok: true, sequenceName: "Welcome Series", matched: 5, enrolled: 3, alreadyActive: 1, missingEmail: 0, addressSuppressed: 1, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0, failedOther: 0, changedSincePreview: 0 });
    const { user, dialog } = await openStatusMode();
    await user.click(within(dialog).getByLabelText(LEAD_STATUS_META.BOOKED.label));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith({ sequenceId: "seq-1", statuses: ["BOOKED"], recipientMode: "primary" }));
    expect(await within(dialog).findByText(/2 leads with an unsubscribed or suppressed email/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: /All available email addresses/ }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith({ sequenceId: "seq-1", statuses: ["BOOKED"], recipientMode: "all" }));
    await user.click(within(dialog).getByRole("button", { name: /Review/ }));
    await user.click(within(dialog).getByRole("button", { name: "Confirm enrollment" }));
    await waitFor(() => expect(enrollByStatus).toHaveBeenCalledWith({ sequenceId: "seq-1", statuses: ["BOOKED"], previewMatched: 5, recipientMode: "all" }));
    expect((await within(dialog).findByTestId("status-outcome")).textContent).toMatch(/Email unsubscribed or suppressed: 1/);
  });
});
