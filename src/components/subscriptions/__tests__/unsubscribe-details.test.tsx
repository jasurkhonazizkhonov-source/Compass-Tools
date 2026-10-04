// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

const respond = vi.fn();
const toastError = vi.fn();
vi.mock("@/server/actions/subscribers", () => ({ respondToUnsubscribedSubscriber: (...a: unknown[]) => respond(...a) }));
vi.mock("@/server/actions/leads", () => ({ sendLeadEmail: vi.fn() }));
vi.mock("@/server/actions/contacts", () => ({ sendContactEmail: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { UnsubscribeDetails, type UnsubscribedSubscriber } from "../unsubscribe-details";

const BASE: UnsubscribedSubscriber = {
  id: "sub-1",
  email: "jane@example.com",
  unsubscribedAt: new Date("2026-10-02T15:12:00"),
  unsubscribeReasonCategory: "TOO_MANY_EMAILS",
  unsubscribeReason: "I receive too many emails.",
  unsubscribeSource: "EMAIL_LINK",
  unsubscribeRespondedAt: null,
  lastCampaignName: "Winter schedule 2026",
};

beforeEach(() => {
  respond.mockReset().mockResolvedValue({ ok: true });
  toastError.mockReset();
});

describe("UnsubscribeDetails (CRM)", () => {
  it("shows the date, source, campaign context and the customer's reason", () => {
    render(<UnsubscribeDetails subscriber={BASE} />);
    expect(screen.getByText("Unsubscribe Reason")).toBeInTheDocument();
    expect(screen.getByText("I receive too many emails")).toBeInTheDocument(); // category label
    expect(screen.getByText("I receive too many emails.")).toBeInTheDocument(); // free text
    expect(screen.getByText(/Oct 2, 2026 at 3:12 PM/)).toBeInTheDocument();
    expect(screen.getByText("Unsubscribe link in an email")).toBeInTheDocument();
    expect(screen.getByText("Winter schedule 2026")).toBeInTheDocument();
  });

  it("with no reason it says 'No reason provided' — never an empty or broken field", () => {
    render(<UnsubscribeDetails subscriber={{ ...BASE, unsubscribeReasonCategory: null, unsubscribeReason: null, lastCampaignName: null, unsubscribeSource: null }} />);
    expect(screen.getByText("No reason provided")).toBeInTheDocument();
    expect(screen.getByText("Not recorded")).toBeInTheDocument();
    expect(screen.queryByText(/Last campaign/)).not.toBeInTheDocument();
  });

  it("a free-text reason containing HTML is shown as text, never as markup", () => {
    const { container } = render(<UnsubscribeDetails subscriber={{ ...BASE, unsubscribeReasonCategory: null, unsubscribeReason: '<img src=x onerror="alert(1)"><b>bold</b>' }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(/<img src=x onerror="alert\(1\)"><b>bold<\/b>/)).toBeInTheDocument();
  });

  it("has a Respond button; the composer opens with the editable subject, the reason shown read-only, and Send / Cancel", async () => {
    const user = userEvent.setup();
    render(<UnsubscribeDetails subscriber={BASE} />);
    await user.click(screen.getByRole("button", { name: /Respond/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Respond to jane@example.com")).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue("jane@example.com")).toBeDisabled(); // recipient, fixed
    expect(within(dialog).getByDisplayValue("Regarding your email preferences")).toBeEnabled(); // prefilled, editable
    const context = within(dialog).getByTestId("respond-context");
    expect(context).toHaveTextContent("I receive too many emails.");
    expect(context).toHaveTextContent(/private/i);
    expect(context).toHaveTextContent(/does not re-subscribe/i);
    expect((within(dialog).getByPlaceholderText("Write your message...") as HTMLTextAreaElement).value).toBe(""); // reason NOT copied into the message
    expect(within(dialog).getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("sending calls the respond action with the edited subject and the typed message only", async () => {
    const user = userEvent.setup();
    render(<UnsubscribeDetails subscriber={BASE} />);
    await user.click(screen.getByRole("button", { name: /Respond/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("Write your message..."), "Thanks for the feedback.");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("sub-1", { subject: "Regarding your email preferences", body: "Thanks for the feedback." }));
    expect(JSON.stringify(respond.mock.calls)).not.toContain("too many emails");
  });

  it("a failed send keeps the dialog open and shows the returned reason", async () => {
    respond.mockResolvedValue({ ok: false, error: "Connect your Gmail account before sending email." });
    const user = userEvent.setup();
    render(<UnsubscribeDetails subscriber={BASE} />);
    await user.click(screen.getByRole("button", { name: /Respond/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("Write your message..."), "Hi");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Connect your Gmail account before sending email."));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Cancel sends nothing", async () => {
    const user = userEvent.setup();
    render(<UnsubscribeDetails subscriber={BASE} />);
    await user.click(screen.getByRole("button", { name: /Respond/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(respond).not.toHaveBeenCalled();
  });

  it("shows when a staff member has already responded", () => {
    render(<UnsubscribeDetails subscriber={{ ...BASE, unsubscribeRespondedAt: new Date("2026-10-03T10:00:00") }} />);
    expect(screen.getByText(/Responded Oct 3, 2026/)).toBeInTheDocument();
  });
});
