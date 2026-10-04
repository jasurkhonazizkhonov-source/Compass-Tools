// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@/test/rtl-setup";

// Contact → Payment: an authorised Reveal shows the COMPLETE supported card record — cardholder name,
// full card number and expiration (plus brand) — and never a security code, which the app does not
// store and so can never show. Official test PAN only.

const revealMock = vi.fn();
const toastError = vi.fn();
vi.mock("@/server/actions/payment-methods", () => ({ revealPaymentMethod: (...a: unknown[]) => revealMock(...a) }));
vi.mock("@/server/actions/contact-payment-methods", () => ({ removePaymentMethod: vi.fn() }));
vi.mock("../payment-method-dialog", () => ({ PaymentMethodDialog: () => null }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { PaymentMethodsPanel } from "../payment-methods-panel";

const PM = { id: "pm-1", cardholderName: "Jane Q. Traveler", last4: "4242", cardBrand: "Visa", expiryMonth: 7, expiryYear: 2029, bookingId: null };
const REVEALED = { cardholderName: "Jane Q. Traveler", pan: "4242424242424242", cardBrand: "Visa", expiryMonth: 7, expiryYear: 2029 };
const pageHasPan = () => document.body.textContent!.includes("4242 4242 4242 4242");

function setup(canReveal = true) {
  return render(<PaymentMethodsPanel contactId="c-1" paymentMethods={[PM]} canReveal={canReveal} canManage={false} />);
}
beforeEach(() => {
  revealMock.mockReset();
  toastError.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("Contact → Payment card Reveal", () => {
  it("shows the cardholder name, the full card number and the expiration after an authorised reveal", async () => {
    revealMock.mockResolvedValue(REVEALED);
    setup();
    expect(pageHasPan()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    const fields = screen.getByTestId("revealed-card-fields");
    expect(fields).toHaveTextContent("Cardholder Name");
    expect(fields).toHaveTextContent("Jane Q. Traveler");
    expect(fields).toHaveTextContent("Card Number");
    expect(fields).toHaveTextContent("4242 4242 4242 4242");
    expect(fields).toHaveTextContent("Expiration");
    expect(fields).toHaveTextContent("07/2029");
    expect(revealMock).toHaveBeenCalledWith("pm-1");
  });

  it("never shows, asks for or stores a security code (CVV / CVC)", async () => {
    revealMock.mockResolvedValue({ ...REVEALED, cvv: "123", cvc: "123", securityCode: "123" });
    setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    const text = screen.getByTestId("revealed-card-fields").textContent!;
    expect(text).not.toMatch(/cvv|cvc|security code/i);
    expect(text).not.toMatch(/\b123\b/);
    expect(document.querySelector('input[name*="cv" i]')).toBeNull();
  });

  it("the revealed region blocks copy / cut / context-menu, is not selectable, and Hide conceals everything", async () => {
    revealMock.mockResolvedValue(REVEALED);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    const region = screen.getByTestId("revealed-card-fields").parentElement!;
    expect(region.className).toMatch(/select-none/);
    for (const type of ["copy", "cut", "contextmenu"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      region.dispatchEvent(event);
      expect(event.defaultPrevented, type).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: /hide/i }));
    expect(pageHasPan()).toBe(false);
    expect(screen.queryByTestId("revealed-card-fields")).not.toBeInTheDocument(); // only the masked summary line remains
  });

  it("auto-hides the whole record on the timer and on blur", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    revealMock.mockResolvedValue(REVEALED);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    await act(async () => void vi.advanceTimersByTime(31_000));
    expect(pageHasPan()).toBe(false);
    expect(screen.queryByTestId("revealed-card-fields")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    await act(async () => {}); // let the reveal hook attach its blur listener (a passive effect) before blurring
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(screen.queryByTestId("revealed-card-fields")).not.toBeInTheDocument();
  });

  it("a viewer without the grant gets no Reveal button and the action is never called", () => {
    setup(false);
    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
    expect(revealMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("•••• 4242");
  });

  it("a returned refusal (stale sign-in, rate limit) is shown and no card data appears", async () => {
    revealMock.mockResolvedValue({ error: "For security, Reveal requires a sign-in within the last 15 minutes." });
    setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(pageHasPan()).toBe(false);
    expect(screen.queryByTestId("revealed-card-fields")).not.toBeInTheDocument();
  });

  it("a thrown (masked) error shows a readable fallback, never the raw digest", async () => {
    revealMock.mockRejectedValue(new Error("An error occurred in the Server Components render. The specific message is omitted in production builds"));
    setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toBe("Unable to reveal this card. You may not have permission.");
  });

  it("never writes card data to browser storage or cookies", async () => {
    revealMock.mockResolvedValue(REVEALED);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setup();
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHasPan()).toBe(true));
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).not.toMatch(/4242|Traveler/);
  });
});
