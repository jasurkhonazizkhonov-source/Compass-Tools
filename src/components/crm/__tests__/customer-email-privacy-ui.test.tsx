// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// The browser side of customer-email privacy: the Reveal button + "n / 5 used today" indicator, and the composer that addresses a customer by opaque id.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) } }));
const reveal = vi.fn();
vi.mock("@/server/actions/customer-email", () => ({ revealContactEmails: (...a: unknown[]) => reveal(...a) }));
const sendContact = vi.fn(async () => ({ ok: true }));
const sendLead = vi.fn(async () => ({ ok: true }));
vi.mock("@/server/actions/contacts", () => ({ sendContactEmail: (...a: unknown[]) => (sendContact as unknown as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/server/actions/leads", () => ({ sendLeadEmail: (...a: unknown[]) => (sendLead as unknown as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/server/actions/subscribers", () => ({ respondToUnsubscribedSubscriber: vi.fn() }));

const { CustomerEmailReveal } = await import("../customer-email-reveal");
const { EmailComposerButton } = await import("../email-composer-dialog");

beforeEach(() => vi.clearAllMocks());

describe("CustomerEmailReveal", () => {
  it("shows the allowance indicator and a Reveal button while the customer is masked", () => {
    render(<CustomerEmailReveal contactId="c1" masked used={2} limit={5} />);
    expect(screen.getByTestId("customer-email-usage")).toHaveTextContent("Customer email reveals: 2 / 5 used today");
    expect(screen.getByRole("button", { name: "Reveal customer email" })).toBeEnabled();
  });

  it("once the customer is revealed there is no Reveal button, only the indicator", () => {
    render(<CustomerEmailReveal contactId="c1" masked={false} used={3} limit={5} />);
    expect(screen.queryByRole("button", { name: "Reveal customer email" })).toBeNull();
    expect(screen.getByTestId("customer-email-usage")).toHaveTextContent("3 / 5");
  });

  it("Reveal asks the server, updates the counter from the SERVER's answer and refreshes the page (the server decides what is shown)", async () => {
    reveal.mockResolvedValue({ ok: true, charged: true, usage: { used: 3, limit: 5, remaining: 2, unlimited: false } });
    const user = userEvent.setup();
    render(<CustomerEmailReveal contactId="c1" leadId="l1" masked used={2} limit={5} />);
    await user.click(screen.getByRole("button", { name: "Reveal customer email" }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith("c1", "l1"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByTestId("customer-email-usage")).toHaveTextContent("3 / 5");
  });

  it("when the allowance is used up the button is disabled and says when it resets; nothing is sent to the server", async () => {
    const user = userEvent.setup();
    render(<CustomerEmailReveal contactId="c1" masked used={5} limit={5} />);
    expect(screen.getByRole("button", { name: "Reveal customer email" })).toBeDisabled();
    expect(screen.getByText(/resets at midnight Pacific/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reveal customer email" }));
    expect(reveal).not.toHaveBeenCalled();
  });

  it("a refusal from the server (limit reached in another tab) is shown, the counter follows the server and the page is NOT refreshed to a revealed state", async () => {
    reveal.mockResolvedValue({ ok: false, error: "You have used all 5 customer email reveals for today.", usage: { used: 5, limit: 5, remaining: 0, unlimited: false } });
    const user = userEvent.setup();
    render(<CustomerEmailReveal contactId="c1" masked used={4} limit={5} />);
    await user.click(screen.getByRole("button", { name: "Reveal customer email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("used all 5");
    expect(screen.getByTestId("customer-email-usage")).toHaveTextContent("5 / 5");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a thrown error is explained without implying any allowance was spent", async () => {
    reveal.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    render(<CustomerEmailReveal contactId="c1" masked used={1} limit={5} />);
    await user.click(screen.getByRole("button", { name: "Reveal customer email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was counted");
    expect(screen.getByTestId("customer-email-usage")).toHaveTextContent("1 / 5");
  });
});

describe("EmailComposerButton with server-resolved recipients", () => {
  const recipients = [
    { id: "ce1", display: "s**h@example.com", address: null },
    { id: "ce2", display: "w**n@work.com", address: null },
  ];

  it("lists only the masked labels, and sends the chosen ids - never an address", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<EmailComposerButton contactId="c1" recipients={recipients} contactName="Sarah Wilson" />);
    await user.click(screen.getByRole("button", { name: "Email Sarah Wilson" }));
    expect(await screen.findByText("s**h@example.com")).toBeInTheDocument();
    expect(baseElement.textContent).not.toMatch(/sarah\.wilson@/);
    await user.type(screen.getByPlaceholderText("Subject"), "Hi");
    await user.type(screen.getByPlaceholderText("Write your message..."), "Body text");
    await user.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(sendContact).toHaveBeenCalledTimes(1));
    expect(sendContact).toHaveBeenCalledWith("c1", { subject: "Hi", body: "Body text", recipientIds: ["ce1"] });
  });

  it("a lead composer addresses the customer the same way", async () => {
    const user = userEvent.setup();
    render(<EmailComposerButton leadId="l1" recipients={[recipients[0]]} contactName="Sarah Wilson" />);
    await user.click(screen.getByRole("button", { name: "Email Sarah Wilson" }));
    await user.type(await screen.findByPlaceholderText("Subject"), "Hi");
    await user.type(screen.getByPlaceholderText("Write your message..."), "Body");
    await user.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(sendLead).toHaveBeenCalledWith("l1", { subject: "Hi", body: "Body", recipientIds: ["ce1"] }));
  });

  it("the plain-address form (used where the viewer may see addresses) still sends `to`", async () => {
    const user = userEvent.setup();
    render(<EmailComposerButton contactId="c1" emails={["sarah@example.com"]} contactName="Sarah Wilson" />);
    await user.click(screen.getByRole("button", { name: "Email Sarah Wilson" }));
    await user.type(await screen.findByPlaceholderText("Subject"), "Hi");
    await user.type(screen.getByPlaceholderText("Write your message..."), "Body");
    await user.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(sendContact).toHaveBeenCalledWith("c1", { subject: "Hi", body: "Body", to: "sarah@example.com" }));
  });

  it("renders nothing when the customer has no address", () => {
    const { container } = render(<EmailComposerButton contactId="c1" recipients={[]} contactName="Sarah Wilson" />);
    expect(container).toBeEmptyDOMElement();
  });
});
