// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// The "Enroll All Contacts" dialog and the recipient choice. The server actions are mocked; the rules they enforce (who is eligible, one enrollment per contact, batching,
// suppression) are proven against a real database in server/actions/__integration__/enroll-all-contacts.integration.test.ts.
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
const preview = vi.fn();
const batch = vi.fn();
vi.mock("@/server/actions/sequence-enroll-contacts", () => ({ previewEnrollAllContacts: (...a: unknown[]) => preview(...a), enrollContactsBatch: (...a: unknown[]) => batch(...a) }));

const { EnrollAllContactsDialog } = await import("../enroll-all-contacts-dialog");
const { RecipientModeChoice } = await import("../recipient-mode-choice");

const batchResult = (over: Record<string, unknown> = {}) => ({
  ok: true,
  sequenceName: "Welcome",
  processed: 100,
  enrolled: 90,
  alreadyEnrolled: 4,
  missingEmail: 2,
  addressSuppressed: 1,
  noAssignedAgent: 0,
  gmailUnavailable: 0,
  inaccessible: 0,
  failedOther: 0,
  nextCursor: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  preview.mockResolvedValue({ ok: true, sequenceName: "Welcome", totalContacts: 250, alreadyEnrolled: 10 });
});

async function openAndReview(user: ReturnType<typeof userEvent.setup>) {
  render(<EnrollAllContactsDialog sequenceId="seq-1" sequenceName="Welcome" />);
  await user.click(screen.getByRole("button", { name: /Enroll All Contacts/ }));
  await screen.findByText(/250 contacts/);
  await user.click(screen.getByRole("button", { name: "Review" }));
}

describe("Enroll All Contacts", () => {
  it("counts the contacts on the server first (never loading them into the page) and explains what will be skipped", async () => {
    const user = userEvent.setup();
    render(<EnrollAllContactsDialog sequenceId="seq-1" sequenceName="Welcome" />);
    await user.click(screen.getByRole("button", { name: /Enroll All Contacts/ }));
    const box = await screen.findByTestId("all-contacts-preview");
    await waitFor(() => expect(box.textContent).toMatch(/250 contacts in your CRM, 10 of them already enrolled in this sequence/));
    expect(preview).toHaveBeenCalledWith({ sequenceId: "seq-1" });
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/already actively enrolled in this sequence are skipped/);
    expect(dialog.textContent).toMatch(/enrolled through its most recent lead/);
    expect(dialog.textContent).toMatch(/a contact without one is enrolled as a contact/);
    expect(dialog.textContent).toMatch(/unsubscribed or is suppressed/);
  });

  it("needs a confirmation that names the sequence and the address choice, and nothing is enrolled before it", async () => {
    const user = userEvent.setup();
    await openAndReview(user);
    const confirm = screen.getByRole("alertdialog", { name: "Confirm enrolling all contacts" });
    expect(confirm.textContent).toMatch(/Welcome/);
    expect(confirm.textContent).toMatch(/their primary email only/);
    expect(confirm.textContent).toMatch(/batches of 100/);
    expect(batch).not.toHaveBeenCalled();
  });

  it("the address choice defaults to primary only and is sent with every batch when changed", async () => {
    const user = userEvent.setup();
    render(<EnrollAllContactsDialog sequenceId="seq-1" sequenceName="Welcome" />);
    await user.click(screen.getByRole("button", { name: /Enroll All Contacts/ }));
    await screen.findByText(/250 contacts/);
    expect(screen.getByRole("radio", { name: /Primary email only/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /All available email addresses/ }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("alertdialog").textContent).toMatch(/all their email addresses/);
    batch.mockResolvedValue(batchResult());
    await user.click(screen.getByRole("button", { name: "Enroll all contacts" }));
    await waitFor(() => expect(batch).toHaveBeenCalledWith({ sequenceId: "seq-1", recipientMode: "all", cursor: null }));
  });

  it("works through the batches by following the cursor, shows progress, and ends with a summary of every reason", async () => {
    const user = userEvent.setup();
    batch
      .mockResolvedValueOnce(batchResult({ nextCursor: "c100" }))
      .mockResolvedValueOnce(batchResult({ nextCursor: "c200", enrolled: 80, gmailUnavailable: 5, noAssignedAgent: 2 }))
      .mockResolvedValueOnce(batchResult({ processed: 50, enrolled: 40, alreadyEnrolled: 0, missingEmail: 0, addressSuppressed: 0, nextCursor: null }));
    await openAndReview(user);
    await user.click(screen.getByRole("button", { name: "Enroll all contacts" }));
    const outcome = await screen.findByTestId("all-contacts-outcome");
    expect(batch.mock.calls.map((c) => c[0].cursor)).toEqual([null, "c100", "c200"]);
    expect(outcome.textContent).toMatch(/Finished: 210 contacts enrolled in Welcome out of 250 contacts checked/);
    expect(outcome.textContent).toMatch(/Already enrolled: 8/);
    expect(outcome.textContent).not.toMatch(/No lead you can access/); // a contact is never refused for lacking a lead
    expect(outcome.textContent).toMatch(/No valid email address: 4/);
    expect(outcome.textContent).toMatch(/Email unsubscribed or suppressed: 2/);
    expect(outcome.textContent).toMatch(/No assigned agent: 2/);
    expect(outcome.textContent).toMatch(/Gmail is unavailable: 5/);
    expect(refresh).toHaveBeenCalled();
  });

  it("a failed batch is reported with a way to retry just those; the run carries on and nothing is claimed that did not happen", async () => {
    const user = userEvent.setup();
    batch
      .mockResolvedValueOnce(batchResult({ nextCursor: "c100", enrolled: 100, alreadyEnrolled: 0, missingEmail: 0, addressSuppressed: 0 }))
      .mockResolvedValueOnce(batchResult({ nextCursor: null, enrolled: 0, alreadyEnrolled: 0, missingEmail: 0, addressSuppressed: 0, failedOther: 100 }));
    await openAndReview(user);
    await user.click(screen.getByRole("button", { name: "Enroll all contacts" }));
    const outcome = await screen.findByTestId("all-contacts-outcome");
    expect(outcome.textContent).toMatch(/Finished: 100 contacts enrolled/);
    expect(outcome.textContent).toMatch(/Failed for another reason: 100 - run it again to retry just those/);
  });

  it("a lost connection stops the run, says how many were enrolled before it, and says running it again is safe", async () => {
    const user = userEvent.setup();
    batch.mockResolvedValueOnce(batchResult({ nextCursor: "c100" })).mockRejectedValueOnce(new Error("network"));
    await openAndReview(user);
    await user.click(screen.getByRole("button", { name: "Enroll all contacts" }));
    const outcome = await screen.findByTestId("all-contacts-outcome");
    expect(screen.getByRole("alert").textContent).toMatch(/The connection was interrupted. Everyone enrolled so far stays enrolled; run it again to continue/);
    expect(outcome.textContent).toMatch(/90 enrolled before it stopped/);
  });

  it("a refusal from the server (not allowed, sequence off) is shown as it is and nothing is claimed", async () => {
    const user = userEvent.setup();
    batch.mockResolvedValueOnce({ ok: false, error: "That sequence is not available. Choose an active sequence that has at least one step." });
    await openAndReview(user);
    await user.click(screen.getByRole("button", { name: "Enroll all contacts" }));
    await screen.findByTestId("all-contacts-outcome");
    expect(screen.getByRole("alert").textContent).toMatch(/That sequence is not available/);
    expect(screen.getByRole("alert").textContent).toMatch(/0 enrolled before it stopped/);
  });

  it("with no contacts there is nothing to review, and a failed count is explained", async () => {
    const user = userEvent.setup();
    preview.mockResolvedValueOnce({ ok: true, sequenceName: "Welcome", totalContacts: 0, alreadyEnrolled: 0 });
    render(<EnrollAllContactsDialog sequenceId="seq-1" sequenceName="Welcome" />);
    await user.click(screen.getByRole("button", { name: /Enroll All Contacts/ }));
    await waitFor(() => expect(screen.getByTestId("all-contacts-preview").textContent).toMatch(/0 contacts in your CRM/));
    expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
  });

  it("the dialog has an accessible name and the choice is a labelled radio group reachable by keyboard", async () => {
    const user = userEvent.setup();
    render(<EnrollAllContactsDialog sequenceId="seq-1" sequenceName="Welcome" />);
    await user.click(screen.getByRole("button", { name: /Enroll All Contacts/ }));
    const dialog = await screen.findByRole("dialog", { name: "Enroll All Contacts" });
    const group = within(dialog).getByRole("radiogroup", { name: "Email addresses to send to" });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    // Tab reaches the group (the checked option takes the focus).
    for (let i = 0; i < 12 && document.activeElement?.getAttribute("role") !== "radio"; i++) await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole("radio", { name: /Primary email only/ }));
    // The other option is a real, focusable radio: Space on it selects it (no mouse needed).
    within(dialog).getByRole("radio", { name: /All available email addresses/ }).focus();
    await user.keyboard(" ");
    expect(within(dialog).getByRole("radio", { name: /All available email addresses/ })).toBeChecked();
  });
});

describe("RecipientModeChoice", () => {
  it("states the consequence of choosing all addresses, and reports the choice", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RecipientModeChoice value="primary" onChange={onChange} />);
    expect(screen.getByText(/A person with more than one address receives the same sequence at/)).toBeInTheDocument();
    expect(screen.getByText(/addresses that unsubscribed or are suppressed are left out/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /All available email addresses/ }));
    expect(onChange).toHaveBeenCalledWith("all");
  });

  it("disables both options while a request is running", () => {
    render(<RecipientModeChoice value="primary" onChange={vi.fn()} disabled />);
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
  });
});
