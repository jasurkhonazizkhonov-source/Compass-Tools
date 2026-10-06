// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { renderToStaticMarkup } from "react-dom/server";

// The Admin-only "Reveal CVV/CVC" / "Destroy CVV/CVC" controls on the Booking Payment card, and the proof that the existing
// "Reveal Card Information" is unchanged. SYNTHETIC code only.
const CODE = "482";
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const revealBookingCvv = vi.fn();
const destroyBookingCvv = vi.fn();
vi.mock("@/server/actions/booking-cvv", () => ({ revealBookingCvv: (...a: unknown[]) => revealBookingCvv(...a), destroyBookingCvv: (...a: unknown[]) => destroyBookingCvv(...a) }));
const revealPaymentMethod = vi.fn();
vi.mock("@/server/actions/payment-methods", () => ({ revealPaymentMethod: (...a: unknown[]) => revealPaymentMethod(...a), updatePaymentMethodWorkflowStatus: vi.fn(async () => undefined) }));

import { PaymentMethodCard } from "../payment-method-card";
import { CvvReveal } from "../cvv-reveal";

const card = { id: "pm1", cardholderName: "Jane Traveler", last4: "1111", cardBrand: "Visa", expiryMonth: 12, expiryYear: 2030, amountAllocated: 570, workflowStatus: "PENDING" as const, status: "ACTIVE" as const };
const available = { available: true as const, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
const baseProps = { bookingId: "b1", label: "Payment Method 1", paymentMethod: card, canReveal: true, canManageStatus: false, currency: "USD" as const };

beforeEach(() => {
  vi.clearAllMocks();
  revealBookingCvv.mockResolvedValue({ cvv: CODE });
  destroyBookingCvv.mockResolvedValue({ destroyed: true });
  revealPaymentMethod.mockResolvedValue({ cardholderName: "Jane Traveler", pan: "4111111111111111", cardBrand: "Visa", expiryMonth: 12, expiryYear: 2030 });
});
afterEach(() => vi.useRealTimers());

describe("who sees the control", () => {
  it("without the `cvv` prop (everyone but an authorized Admin) NOTHING about a security code is in the markup — no button, no hidden node, no attribute", () => {
    const html = renderToStaticMarkup(<PaymentMethodCard {...baseProps} />);
    expect(html).not.toMatch(/cvv|cvc|security code/i);
    expect(html).not.toContain(CODE);
    expect(html).toContain("Reveal Card Information");
  });

  it("with the prop (Admin) the button sits with the existing card reveal, and the value is NOT in the initial markup", () => {
    const html = renderToStaticMarkup(<PaymentMethodCard {...baseProps} cvv={available} />);
    expect(html).toContain("Reveal Card Information");
    expect(html).toContain("Reveal CVV/CVC");
    expect(html.indexOf("Reveal Card Information")).toBeLessThan(html.indexOf("Reveal CVV/CVC"));
    expect(html).not.toContain(CODE);
    expect(html).not.toContain("cv2."); // no ciphertext either
  });

  it("an Admin sees 'no longer available' (and no reveal button) when nothing is retained", () => {
    const html = renderToStaticMarkup(<PaymentMethodCard {...baseProps} cvv={{ available: false }} />);
    expect(html).toContain("CVV/CVC no longer available");
    expect(html).toContain("at most 24 hours after the Booking Form is signed"); // says why, without exposing anything
    expect(html).not.toContain("Reveal CVV/CVC");
  });
});

describe("reveal behaviour", () => {
  it("fetches the code only when clicked, shows it clearly, and hides it again with Hide CVV/CVC", async () => {
    const user = userEvent.setup();
    render(<CvvReveal bookingId="b1" paymentMethodId="pm1" state={available} />);
    expect(screen.queryByTestId("cvv-value")).not.toBeInTheDocument();
    expect(revealBookingCvv).not.toHaveBeenCalled(); // nothing is requested on load / prefetch
    await user.click(screen.getByRole("button", { name: "Reveal CVV/CVC" }));
    expect(revealBookingCvv).toHaveBeenCalledWith("b1", "pm1");
    expect(await screen.findByTestId("cvv-value")).toHaveTextContent(CODE);
    await user.click(screen.getByRole("button", { name: "Hide CVV/CVC" }));
    expect(screen.queryByTestId("cvv-value")).not.toBeInTheDocument();
    expect(screen.queryByText(CODE)).not.toBeInTheDocument();
  });

  it("hides itself after 30 seconds, and can be revealed again while the record exists", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CvvReveal bookingId="b1" paymentMethodId="pm1" state={available} />);
    await user.click(screen.getByRole("button", { name: "Reveal CVV/CVC" }));
    expect(await screen.findByTestId("cvv-value")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(29_000));
    expect(screen.getByTestId("cvv-value")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(2_000));
    await waitFor(() => expect(screen.queryByTestId("cvv-value")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Reveal CVV/CVC" }));
    expect(await screen.findByTestId("cvv-value")).toHaveTextContent(CODE);
  });

  it("keeps the value only in component state: never in storage, the URL or the clipboard events", async () => {
    const user = userEvent.setup();
    const before = JSON.stringify({ ...localStorage });
    render(<CvvReveal bookingId="b1" paymentMethodId="pm1" state={available} />);
    await user.click(screen.getByRole("button", { name: "Reveal CVV/CVC" }));
    await screen.findByTestId("cvv-value");
    expect(JSON.stringify({ ...localStorage })).toBe(before);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(CODE);
    expect(window.location.href).not.toContain(CODE);
    expect(document.cookie).not.toContain(CODE);
    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    screen.getByTestId("cvv-value").dispatchEvent(copyEvent);
    expect(copyEvent.defaultPrevented).toBe(true);
  });

  it("a refusal is shown as a message and no value appears; 'no longer available' replaces the button", async () => {
    revealBookingCvv.mockResolvedValueOnce({ error: "CVV/CVC is no longer available because the 24-hour retention period has expired." });
    const user = userEvent.setup();
    render(<CvvReveal bookingId="b1" paymentMethodId="pm1" state={available} />);
    await user.click(screen.getByRole("button", { name: "Reveal CVV/CVC" }));
    await waitFor(() => expect(screen.getByTestId("cvv-unavailable")).toBeInTheDocument());
    expect(screen.queryByTestId("cvv-value")).not.toBeInTheDocument();
  });

  it("a thrown (forbidden) action shows a message and no value", async () => {
    revealBookingCvv.mockRejectedValueOnce(new Error("You are not authorized to reveal this security code"));
    const user = userEvent.setup();
    render(<CvvReveal bookingId="b1" paymentMethodId="pm1" state={available} />);
    await user.click(screen.getByRole("button", { name: "Reveal CVV/CVC" }));
    await waitFor(() => expect(revealBookingCvv).toHaveBeenCalled());
    expect(screen.queryByTestId("cvv-value")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reveal CVV/CVC" })).toBeEnabled();
  });
});

describe("Destroy CVV/CVC", () => {
  it("asks in the CRM's own dialog (no browser dialog), runs only on confirm, then shows 'no longer available'", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CvvReveal bookingId="b1" paymentMethodId="pm1" state={available} />);
    await user.click(screen.getByRole("button", { name: "Destroy CVV/CVC" }));
    const dialog = screen.getByRole("alertdialog", { name: "Destroy CVV/CVC?" });
    expect(dialog).toHaveTextContent("permanently removes the stored CVV/CVC");
    expect(dialog).toHaveTextContent("cannot be recovered");
    expect(destroyBookingCvv).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(destroyBookingCvv).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Destroy CVV/CVC" }));
    await user.click(screen.getAllByRole("button", { name: "Destroy CVV/CVC" }).at(-1)!);
    await waitFor(() => expect(destroyBookingCvv).toHaveBeenCalledWith("b1", "pm1"));
    await waitFor(() => expect(screen.getByTestId("cvv-unavailable")).toBeInTheDocument());
    expect(refresh).toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("a refused destroy stays open with the reason (the server decides who may)", async () => {
    destroyBookingCvv.mockRejectedValueOnce(new Error("You are not authorized to reveal this security code"));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CvvReveal bookingId="b1" paymentMethodId="pm1" state={available} />);
    await user.click(screen.getByRole("button", { name: "Destroy CVV/CVC" }));
    await user.click(screen.getAllByRole("button", { name: "Destroy CVV/CVC" }).at(-1)!);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});

describe("the existing Reveal Card Information is unchanged", () => {
  it("still reveals the card number, cardholder and expiry — and shows no security code", async () => {
    const user = userEvent.setup();
    render(<PaymentMethodCard {...baseProps} cvv={available} />);
    await user.click(screen.getByRole("button", { name: "Reveal Card Information" }));
    expect(revealPaymentMethod).toHaveBeenCalledWith("pm1");
    expect(await screen.findByText("4111 1111 1111 1111")).toBeInTheDocument();
    expect(screen.getByText("Jane Traveler", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByTestId("cvv-value")).not.toBeInTheDocument();
    expect(revealBookingCvv).not.toHaveBeenCalled(); // the card reveal never triggers the CVV reveal
  });

  it("revealing the card number does not reveal or consume the code, and vice-versa", async () => {
    const user = userEvent.setup();
    render(<PaymentMethodCard {...baseProps} cvv={available} />);
    await user.click(screen.getByRole("button", { name: "Reveal CVV/CVC" }));
    await screen.findByTestId("cvv-value");
    expect(revealPaymentMethod).not.toHaveBeenCalled();
    expect(screen.queryByText("4111 1111 1111 1111")).not.toBeInTheDocument();
  });
});
