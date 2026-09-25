// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { ChargeCustomerPanel } from "../charge-customer-panel";

// The Admin manual-charge UI. The server is the security boundary (covered in
// the real-database suite); these tests pin the UI contract that keeps a click
// from ever becoming a second charge: one idempotency key per attempt, KEPT
// across an "unknown outcome" retry, replaced only after a definitive result,
// plus what a non-Admin sees and what a blocked card shows.

const initiateManualCharge = vi.fn();
const refundManualCharge = vi.fn();
vi.mock("@/server/actions/manual-charge", () => ({
  initiateManualCharge: (...a: unknown[]) => initiateManualCharge(...a),
  refundManualCharge: (...a: unknown[]) => refundManualCharge(...a),
}));
vi.mock("@/server/actions/payment-methods", () => ({ confirmPaymentReceived: vi.fn(async () => ({ status: "SUCCEEDED" })) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const BASE = {
  bookingId: "b1",
  paymentMethodId: "pm1",
  cardLabel: "Visa •••• 4242",
  defaultAmount: 1500,
  currency: "AUD" as const,
  canConfirm: false,
  canManualCharge: true,
  chargeBlockedReason: null,
  charges: [],
};

beforeEach(() => {
  initiateManualCharge.mockReset();
  refundManualCharge.mockReset();
});

async function openConfirm(user: ReturnType<typeof userEvent.setup>, reason = "Ticket purchase") {
  await user.type(screen.getByPlaceholderText(/ticket purchase/i), reason);
  await user.click(screen.getByRole("button", { name: /^charge/i }));
  await user.click(await screen.findByRole("checkbox", {}, { timeout: 8000 }));
}

describe("ChargeCustomerPanel — visibility", () => {
  it("a non-Admin sees no manual-charge controls at all", () => {
    render(<ChargeCustomerPanel {...BASE} canManualCharge={false} />);
    expect(screen.queryByText(/manual charge/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^charge/i })).not.toBeInTheDocument();
  });

  it("an Admin sees the amount in the BOOKING's currency (AUD), never a bare $", () => {
    render(<ChargeCustomerPanel {...BASE} />);
    expect(screen.getByText(/amount \(AUD\)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /A\$1,500\.00/ })).toBeDisabled(); // needs a reason first
  });

  it("a card that cannot be charged shows WHY instead of the form (legacy / expired / removed)", () => {
    render(<ChargeCustomerPanel {...BASE} chargeBlockedReason="This card has expired. Ask the customer for a new payment method." />);
    expect(screen.getByText(/this card has expired/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^charge/i })).not.toBeInTheDocument();
  });

  it("the card is identified only as brand + last four, and the panel says the number/security code are never shown", async () => {
    const user = userEvent.setup();
    render(<ChargeCustomerPanel {...BASE} />);
    expect(screen.getByText(/never shown or needed/i)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/ticket purchase/i), "Fare");
    await user.click(screen.getByRole("button", { name: /^charge/i }));
    expect(await screen.findByText("Visa •••• 4242")).toBeInTheDocument();
  });

  it("charge history shows provider charges vs record-only notes, refunded amounts and the customer-currency amounts", () => {
    const base = { id: "c", currency: "aud", referenceNote: "note", errorMessage: null, createdAt: new Date(), initiatedBy: { fullName: "Ann Admin" }, failureCategory: null };
    render(
      <ChargeCustomerPanel
        {...BASE}
        charges={[
          { ...base, id: "c1", amount: 200, status: "PARTIALLY_REFUNDED", provider: "stripe", refundedAmount: 50 },
          { ...base, id: "c2", amount: 100, status: "SUCCEEDED", provider: null, refundedAmount: 0 },
        ]}
      />
    );
    expect(screen.getByText(/A\$200\.00/)).toBeInTheDocument();
    expect(screen.getByText(/A\$50\.00 refunded/)).toBeInTheDocument();
    expect(screen.getByText(/Card charge/)).toBeInTheDocument();
    expect(screen.getByText(/Recorded \(taken outside the CRM\)/)).toBeInTheDocument();
    // Only the provider charge is refundable.
    expect(screen.getAllByRole("button", { name: /refund/i })).toHaveLength(1);
  });
});

describe("ChargeCustomerPanel — exactly-once UI contract", () => {
  it("requires the reason AND an explicit 'customer authorized' confirmation before anything is sent", async () => {
    const user = userEvent.setup();
    render(<ChargeCustomerPanel {...BASE} />);
    await user.type(screen.getByPlaceholderText(/ticket purchase/i), "Fare");
    await user.click(screen.getByRole("button", { name: /^charge/i }));
    expect(screen.getByRole("button", { name: /charge now/i })).toBeDisabled();
    expect(initiateManualCharge).not.toHaveBeenCalled();
  });

  it("sends the booking's own ids, the amount and a UUID idempotency key — and NO card data, status or currency", async () => {
    initiateManualCharge.mockResolvedValue({ ok: true, chargeId: "c1", status: "SUCCEEDED" });
    const user = userEvent.setup();
    render(<ChargeCustomerPanel {...BASE} />);
    await openConfirm(user);
    await user.click(screen.getByRole("button", { name: /charge now/i }));
    await waitFor(() => expect(initiateManualCharge).toHaveBeenCalledTimes(1), { timeout: 8000 });
    const arg = initiateManualCharge.mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(["amount", "bookingId", "idempotencyKey", "paymentMethodId", "reason"]);
    expect(arg).toMatchObject({ bookingId: "b1", paymentMethodId: "pm1", amount: 1500, reason: "Ticket purchase" });
    expect(arg.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("after an UNKNOWN outcome the SAME key is reused on Retry (so it cannot charge twice)", async () => {
    initiateManualCharge.mockResolvedValueOnce({ ok: false, code: "OUTCOME_UNKNOWN", error: "We couldn't confirm the result." }).mockResolvedValueOnce({ ok: true, chargeId: "c1", status: "SUCCEEDED" });
    const user = userEvent.setup();
    render(<ChargeCustomerPanel {...BASE} />);
    await openConfirm(user);
    await user.click(screen.getByRole("button", { name: /charge now/i }));
    const retry = await screen.findByRole("button", { name: /retry/i }, { timeout: 8000 });
    // The button is disabled while the first request's transition is still settling.
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 8000 });
    await user.click(retry);
    await waitFor(() => expect(initiateManualCharge).toHaveBeenCalledTimes(2), { timeout: 8000 });
    expect(initiateManualCharge.mock.calls[1][0].idempotencyKey).toBe(initiateManualCharge.mock.calls[0][0].idempotencyKey);
  });

  it("a network exception (request may or may not have arrived) also keeps the key and offers a safe Retry", async () => {
    initiateManualCharge.mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValueOnce({ ok: true, chargeId: "c1", status: "SUCCEEDED", duplicate: true });
    const user = userEvent.setup();
    render(<ChargeCustomerPanel {...BASE} />);
    await openConfirm(user);
    await user.click(screen.getByRole("button", { name: /charge now/i }));
    const retry = await screen.findByRole("button", { name: /retry/i }, { timeout: 8000 });
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 8000 });
    await user.click(retry);
    await waitFor(() => expect(initiateManualCharge).toHaveBeenCalledTimes(2), { timeout: 8000 });
    expect(initiateManualCharge.mock.calls[1][0].idempotencyKey).toBe(initiateManualCharge.mock.calls[0][0].idempotencyKey);
  });

  it("after a DEFINITIVE failure (declined) the next attempt uses a NEW key", async () => {
    initiateManualCharge.mockResolvedValue({ ok: false, code: "DECLINED", error: "The card was declined." });
    const user = userEvent.setup();
    render(<ChargeCustomerPanel {...BASE} />);
    await openConfirm(user);
    await user.click(screen.getByRole("button", { name: /charge now/i }));
    await waitFor(() => expect(initiateManualCharge).toHaveBeenCalledTimes(1), { timeout: 8000 });
    await openConfirm(user, " again");
    await user.click(screen.getByRole("button", { name: /charge now/i }));
    await waitFor(() => expect(initiateManualCharge).toHaveBeenCalledTimes(2), { timeout: 8000 });
    expect(initiateManualCharge.mock.calls[1][0].idempotencyKey).not.toBe(initiateManualCharge.mock.calls[0][0].idempotencyKey);
  });

  it("the confirm button is disabled while a request is in flight, so a double click cannot send twice", async () => {
    let release: (v: unknown) => void = () => {};
    initiateManualCharge.mockImplementation(() => new Promise((r) => (release = r)));
    const user = userEvent.setup();
    render(<ChargeCustomerPanel {...BASE} />);
    await openConfirm(user);
    const go = screen.getByRole("button", { name: /charge now/i });
    await user.click(go);
    await user.click(go);
    expect(initiateManualCharge).toHaveBeenCalledTimes(1);
    release({ ok: true, chargeId: "c", status: "SUCCEEDED" });
  });
});
