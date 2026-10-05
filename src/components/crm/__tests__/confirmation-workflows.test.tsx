// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// Every consequential action that used to fire on the first click (or behind a native window.confirm) now asks in the CRM's own
// modal first: nothing runs until the confirm button is pressed, Cancel / Escape run nothing, and a refusal is shown inside
// the dialog. One test per workflow, against the real components with only the server actions mocked.

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, replace: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const cancelQuote = vi.fn();
const sendQuote = vi.fn();
vi.mock("@/server/actions/quotes", () => ({ cancelQuote: (...a: unknown[]) => cancelQuote(...a), sendQuote: (...a: unknown[]) => sendQuote(...a) }));

const confirmCancellation = vi.fn();
const disregardCancellation = vi.fn();
const sendCancellationForm = vi.fn();
const resendCancellationForm = vi.fn();
vi.mock("@/server/actions/cancellation", () => ({
  confirmCancellation: (...a: unknown[]) => confirmCancellation(...a),
  disregardCancellation: (...a: unknown[]) => disregardCancellation(...a),
  sendCancellationForm: (...a: unknown[]) => sendCancellationForm(...a),
  resendCancellationForm: (...a: unknown[]) => resendCancellationForm(...a),
}));

const signOutAllUsers = vi.fn();
vi.mock("@/server/actions/session-admin", () => ({ signOutAllUsers: (...a: unknown[]) => signOutAllUsers(...a) }));

const deleteNote = vi.fn();
vi.mock("@/server/actions/leads", () => ({ addNote: vi.fn(), updateNote: vi.fn(), deleteNote: (...a: unknown[]) => deleteNote(...a) }));

const deleteContactPhone = vi.fn();
const deleteContactEmail = vi.fn();
vi.mock("@/server/actions/contacts", () => ({
  addContactPhone: vi.fn(),
  addContactEmail: vi.fn(),
  setPrimaryPhone: vi.fn(),
  setPrimaryEmail: vi.fn(),
  deleteContactPhone: (...a: unknown[]) => deleteContactPhone(...a),
  deleteContactEmail: (...a: unknown[]) => deleteContactEmail(...a),
}));

const removeCompanyLogo = vi.fn();
vi.mock("@/server/actions/company", () => ({ uploadCompanyLogo: vi.fn(), removeCompanyLogo: (...a: unknown[]) => removeCompanyLogo(...a) }));

import { DeleteButton } from "../delete-button";
import { QuoteActions } from "@/components/quotes/quote-actions";
import { CancellationApprovalActions } from "@/components/quotes/cancellation-approval-actions";
import { SignOutAllUsersButton } from "@/components/accounts/sign-out-all-users-button";
import { NotesPanel } from "../notes-panel";
import { PhoneManager, EmailManager } from "@/components/contacts/phone-email-manager";
import { CompanyLogoPanel } from "@/components/company/company-logo-panel";
import { InputDialog } from "../input-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { validateEditorUrl } from "@/components/subscriptions/rich-text-editor";

beforeEach(() => {
  vi.clearAllMocks();
  cancelQuote.mockResolvedValue(undefined);
  confirmCancellation.mockResolvedValue(undefined);
  disregardCancellation.mockResolvedValue(undefined);
  sendCancellationForm.mockResolvedValue(undefined);
  resendCancellationForm.mockResolvedValue(undefined);
  deleteNote.mockResolvedValue(undefined);
  deleteContactPhone.mockResolvedValue(undefined);
  deleteContactEmail.mockResolvedValue(undefined);
  removeCompanyLogo.mockResolvedValue(undefined);
});

const dialog = (name: string | RegExp) => screen.getByRole("alertdialog", { name });

describe("DeleteButton (lead / contact / quote / booking)", () => {
  const renderDelete = (deleteAction: () => Promise<void>) =>
    render(<DeleteButton variant="full" label="Delete" confirmTitle="Delete this lead?" confirmMessage="Deleting this lead will also delete any quotes." confirmLabel="Delete lead" deleteAction={deleteAction} redirectTo="/leads" />);

  it("nothing is deleted until the confirm button is pressed; then it deletes once and navigates", async () => {
    const user = userEvent.setup();
    const deleteAction = vi.fn().mockResolvedValue(undefined);
    renderDelete(deleteAction);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(dialog("Delete this lead?")).toHaveTextContent("also delete any quotes");
    expect(deleteAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete lead" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/leads"));
    expect(deleteAction).toHaveBeenCalledTimes(1);
  });

  it("Cancel and Escape delete nothing and do not navigate", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const deleteAction = vi.fn().mockResolvedValue(undefined);
    renderDelete(deleteAction);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.keyboard("{Escape}");
    expect(deleteAction).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("a refused delete stays open with the reason and does not navigate (the server's authorization is unchanged)", async () => {
    const user = userEvent.setup();
    const deleteAction = vi.fn().mockRejectedValue(new Error("You do not have permission to delete this lead."));
    renderDelete(deleteAction);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete lead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have permission");
    expect(push).not.toHaveBeenCalled();
  });

  it("a double click on the confirm button deletes once", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const deleteAction = vi.fn(() => new Promise<void>((r) => (release = r)));
    renderDelete(deleteAction);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("button", { name: "Delete lead" });
    await user.dblClick(confirm);
    expect(deleteAction).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
  });
});

describe("Cancel Quote", () => {
  const renderQuote = () => render(<QuoteActions quoteId="q1" status="SENT" emails={["a@example.com"]} viewDealUrl="https://example.com/q" />);

  it("asks first; Keep quote runs nothing; confirming cancels exactly once", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderQuote();
    await user.click(screen.getByRole("button", { name: /Cancel Quote/ }));
    expect(dialog("Cancel this quote?")).toBeInTheDocument();
    expect(cancelQuote).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep quote" }));
    expect(cancelQuote).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Cancel Quote/ }));
    await user.click(screen.getByRole("button", { name: "Cancel quote" }));
    await waitFor(() => expect(cancelQuote).toHaveBeenCalledWith("q1"));
    expect(cancelQuote).toHaveBeenCalledTimes(1);
  });

  it("a refused cancel is shown in the dialog, which stays open", async () => {
    cancelQuote.mockRejectedValueOnce(new Error("This quote can no longer be cancelled."));
    const user = userEvent.setup();
    renderQuote();
    await user.click(screen.getByRole("button", { name: /Cancel Quote/ }));
    await user.click(screen.getByRole("button", { name: "Cancel quote" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("can no longer be cancelled");
  });
});

describe("Cancellation review actions", () => {
  it("Disregard asks first, and only the confirm button disregards", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CancellationApprovalActions cancellationRequestId="c1" mode="approve" />);
    await user.click(screen.getByRole("button", { name: /Disregard Cancellation/ }));
    expect(dialog("Disregard this cancellation request?")).toBeInTheDocument();
    expect(disregardCancellation).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(disregardCancellation).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Disregard Cancellation/ }));
    await user.click(screen.getByRole("button", { name: "Disregard request" }));
    await waitFor(() => expect(disregardCancellation).toHaveBeenCalledWith("c1"));
  });

  it("Approve asks first and says the customer is not notified yet", async () => {
    const user = userEvent.setup();
    render(<CancellationApprovalActions cancellationRequestId="c1" mode="approve" />);
    await user.click(screen.getByRole("button", { name: /Approve Cancellation/ }));
    expect(dialog("Approve this cancellation?")).toHaveTextContent("customer is not notified yet");
    expect(confirmCancellation).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Approve cancellation" }));
    await waitFor(() => expect(confirmCancellation).toHaveBeenCalledWith("c1"));
  });

  it("Send Cancellation Form (an email to the customer) and Resend each ask first", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { unmount } = render(<CancellationApprovalActions cancellationRequestId="c1" mode="send-form" />);
    await user.click(screen.getByRole("button", { name: /Send Cancellation Form/ }));
    expect(dialog("Send the cancellation form to the customer?")).toHaveTextContent("cannot be recalled");
    expect(sendCancellationForm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send cancellation form" }));
    await waitFor(() => expect(sendCancellationForm).toHaveBeenCalledWith("c1"));
    unmount();

    render(<CancellationApprovalActions cancellationRequestId="c1" mode="resend" />);
    await user.click(screen.getByRole("button", { name: /Resend Cancellation Form/ }));
    expect(resendCancellationForm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Resend form" }));
    await waitFor(() => expect(resendCancellationForm).toHaveBeenCalledWith("c1"));
  });

  it("a server refusal is shown in the dialog and nothing is reported as done", async () => {
    confirmCancellation.mockRejectedValueOnce(new Error("Only Admins and Managers can approve a cancellation."));
    const user = userEvent.setup();
    render(<CancellationApprovalActions cancellationRequestId="c1" mode="approve" />);
    await user.click(screen.getByRole("button", { name: /Approve Cancellation/ }));
    await user.click(screen.getByRole("button", { name: "Approve cancellation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only Admins and Managers");
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("Sign out all users", () => {
  it("asks first, warns that the Administrator is signed out too, and runs only on confirm", async () => {
    const user = userEvent.setup();
    signOutAllUsers.mockResolvedValue(undefined);
    render(<SignOutAllUsersButton />);
    await user.click(screen.getByRole("button", { name: "Sign out all users" }));
    const d = dialog("Sign out all users?");
    expect(d).toHaveTextContent("including you");
    expect(d).toHaveTextContent("sign in again right away");
    expect(signOutAllUsers).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole("button", { name: "Sign out all users" }).at(-1)!);
    await waitFor(() => expect(signOutAllUsers).toHaveBeenCalledTimes(1));
  });

  it("a refusal (e.g. the step-up message) is shown in the dialog, which stays open", async () => {
    const user = userEvent.setup();
    signOutAllUsers.mockResolvedValue({ error: "For security, signing everyone out requires a sign-in within the last 15 minutes." });
    render(<SignOutAllUsersButton />);
    await user.click(screen.getByRole("button", { name: "Sign out all users" }));
    await user.click(screen.getAllByRole("button", { name: "Sign out all users" }).at(-1)!);
    expect(await screen.findByRole("alert")).toHaveTextContent("within the last 15 minutes");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});

describe("Delete a note / phone number / email address / company logo", () => {
  it("a note is removed only after confirmation", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<NotesPanel leadId="l1" notes={[{ id: "n1", body: "Call back Monday", createdAt: new Date(), author: { fullName: "Agent" } }]} />);
    await user.click(screen.getByRole("button", { name: "Delete note" }));
    expect(dialog("Delete this note?")).toBeInTheDocument();
    expect(deleteNote).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteNote).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete note" }));
    await user.click(screen.getAllByRole("button", { name: "Delete note" }).at(-1)!);
    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith("n1", { contactId: undefined, leadId: "l1" }));
  });

  it("a phone number and an email address are removed only after confirmation", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { unmount } = render(<TooltipProvider><PhoneManager contactId="c1" leadId="l1" phones={[{ id: "p1", number: "+15551234567", type: "MOBILE", isPrimary: true }, { id: "p2", number: "+15557654321", type: "WORK", isPrimary: false }]} /></TooltipProvider>);
    await user.click(screen.getAllByRole("button", { name: "Delete phone number" })[1]);
    expect(dialog("Delete this phone number?")).toBeInTheDocument();
    expect(deleteContactPhone).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete phone number" }));
    await waitFor(() => expect(deleteContactPhone).toHaveBeenCalledWith("c1", "p2", "l1"));
    unmount();

    render(<TooltipProvider><EmailManager contactId="c1" leadId="l1" emails={[{ id: "e1", email: "a@example.com", type: "PERSONAL", isPrimary: true }, { id: "e2", email: "b@example.com", type: "WORK", isPrimary: false }]} /></TooltipProvider>);
    await user.click(screen.getAllByRole("button", { name: "Delete email address" })[1]);
    expect(dialog("Delete this email address?")).toBeInTheDocument();
    expect(deleteContactEmail).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete email address" }));
    await waitFor(() => expect(deleteContactEmail).toHaveBeenCalledWith("c1", "e2", "l1"));
  });

  it("removing the company logo asks first", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CompanyLogoPanel currentWebUrl="/logo.png" status="PROCESSED" error={null} />);
    await user.click(screen.getByRole("button", { name: /Remove/ }));
    expect(dialog("Remove the company logo?")).toBeInTheDocument();
    expect(removeCompanyLogo).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeCompanyLogo).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Remove$/ }));
    await user.click(screen.getByRole("button", { name: "Remove logo" }));
    await waitFor(() => expect(removeCompanyLogo).toHaveBeenCalledTimes(1));
  });
});

describe("InputDialog (the replacement for window.prompt) and editor URL validation", () => {
  function Host({ onSubmit }: { onSubmit: (v: string) => void }) {
    return <InputDialog open onOpenChange={() => undefined} title="Add link" label="Link URL" submitLabel="Add link" validate={(v) => validateEditorUrl(v, false)} onSubmit={onSubmit} />;
  }

  it("submits a valid value with Enter or the button; shows an inline error and stays open for an invalid one", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Host onSubmit={onSubmit} />);
    const field = screen.getByLabelText("Link URL");
    await user.type(field, "javascript:alert(1){Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("full address");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.clear(field);
    await user.type(field, "https://example.com/offer{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("https://example.com/offer");
  });

  it("Enter inside the dialog never submits an enclosing form", async () => {
    const user = userEvent.setup();
    const outer = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={outer}>
        <Host onSubmit={() => undefined} />
      </form>
    );
    await user.type(screen.getByLabelText("Link URL"), "https://example.com{Enter}");
    expect(outer).not.toHaveBeenCalled();
  });

  it("URL rules: http(s) and mailto for links, https only for images; never javascript:, data: or a bare word", () => {
    for (const ok of ["https://example.com", "http://example.com/a?b=c", "mailto:team@example.com"]) expect(validateEditorUrl(ok, false), ok).toBeNull();
    for (const bad of ["", "example.com", "javascript:alert(1)", "data:text/html,x", "ftp://example.com", "https://", "mailto:nope"]) expect(validateEditorUrl(bad, false), bad).not.toBeNull();
    expect(validateEditorUrl("https://example.com/a.png", true)).toBeNull();
    expect(validateEditorUrl("mailto:team@example.com", true)).not.toBeNull();
    expect(validateEditorUrl("data:image/png;base64,AAAA", true)).not.toBeNull();
  });
});
