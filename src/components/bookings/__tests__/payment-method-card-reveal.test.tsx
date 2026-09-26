// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// The Reveal UI's containment behaviour: masked by default, concealed on a
// timer / tab change / blur / unmount, not selectable or copyable, and a
// refusal is shown without ever displaying card data. Official test PAN only.

const revealMock = vi.fn();
vi.mock("@/server/actions/payment-methods", () => ({
  revealPaymentMethod: (...a: unknown[]) => revealMock(...a),
  updatePaymentMethodWorkflowStatus: vi.fn(),
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { PaymentMethodCard } from "../payment-method-card";

const PM = { id: "pm-1", cardholderName: "Jane Traveler", last4: "4242", cardBrand: "Visa", expiryMonth: 12, expiryYear: 2029, amountAllocated: 100, workflowStatus: "PENDING" as const, status: "ACTIVE" as const };
const CARD = { cardholderName: "Jane Traveler", pan: "4242424242424242", cardBrand: "Visa", expiryMonth: 12, expiryYear: 2029 };

function setup(canReveal = true) {
  return render(<PaymentMethodCard bookingId="b-1" label="Payment Method 1" paymentMethod={PM} canReveal={canReveal} canManageStatus={false} currency="USD" />);
}
const pageHasPan = () => document.body.textContent!.includes("4242 4242 4242 4242");

beforeEach(() => {
  revealMock.mockReset();
  toastError.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("Reveal UI containment", () => {
  it("is masked by default and offers no Reveal button without the permission", () => {
    setup(false);
    expect(screen.getByText(/•••• •••• •••• 4242/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
    expect(pageHasPan()).toBe(false);
  });

  it("shows the number on Reveal, in a non-selectable region that blocks copy, cut and the context menu", async () => {
    revealMock.mockResolvedValue(CARD);
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    const region = screen.getByText(/privileged view/i).closest("div")!.parentElement!;
    expect(region.className).toMatch(/select-none/);
    for (const type of ["copy", "cut", "contextMenu"] as const) {
      const event = new Event(type === "contextMenu" ? "contextmenu" : type, { bubbles: true, cancelable: true });
      region.dispatchEvent(event);
      expect(event.defaultPrevented, type).toBe(true);
    }
  });

  it("conceals after 30 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    revealMock.mockResolvedValue(CARD);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    expect(screen.getByText(/auto-hides in 30s/i)).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(29_000);
    });
    expect(pageHasPan()).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(pageHasPan()).toBe(false);
    expect(screen.getByRole("button", { name: /reveal/i })).toBeInTheDocument();
  });

  it("conceals immediately when the tab is hidden", async () => {
    revealMock.mockResolvedValue(CARD);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(pageHasPan()).toBe(false);
  });

  it("conceals immediately when the window loses focus", async () => {
    revealMock.mockResolvedValue(CARD);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(pageHasPan()).toBe(false);
  });

  it("the Hide button conceals it, and unmounting leaves no timer or listener behind", async () => {
    revealMock.mockResolvedValue(CARD);
    const clear = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /hide/i }));
    expect(pageHasPan()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    unmount();
    expect(clear).toHaveBeenCalled();
    expect(pageHasPan()).toBe(false);
  });

  it("a returned refusal is shown as a message and no card data is displayed or retained", async () => {
    revealMock.mockResolvedValue({ error: "For security, Reveal requires a sign-in within the last 15 minutes. Sign out, sign back in, then try again." });
    setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toMatch(/sign-in within the last 15 minutes/);
    expect(pageHasPan()).toBe(false);
    expect(screen.getByRole("button", { name: /reveal/i })).toBeEnabled();
  });

  it("a thrown (masked) error shows a generic, useful fallback — never the raw digest text", async () => {
    revealMock.mockRejectedValue(new Error("An error occurred in the Server Components render. The specific message is omitted in production builds"));
    setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toBe("Unable to reveal this card. You may not have permission.");
    expect(pageHasPan()).toBe(false);
  });

  it("the component never writes to browser storage", async () => {
    revealMock.mockResolvedValue(CARD);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).not.toMatch(/4242/);
  });
});
