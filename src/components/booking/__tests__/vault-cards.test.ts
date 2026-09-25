import { describe, it, expect, vi } from "vitest";
import { vaultCards, type CreateSetup } from "../vault-cards";
import type { CardFormState } from "../card-payment-section";
import type { SecureCardHandle } from "@/components/payments/secure-card-fields";

const card = (over: Partial<CardFormState> = {}): CardFormState => ({ cardholderName: " Jane Traveler ", amount: "", slotKey: "slot-aaaaaaaa", setupIntentId: null, ...over });
const okHandle = (id = "seti_1"): SecureCardHandle => ({ isComplete: () => true, confirmSetup: vi.fn(async () => ({ ok: true as const, setupIntentId: id })) });
const makeSetupOk = (): CreateSetup => vi.fn(async () => ({ ok: true as const, clientSecret: "seti_1_secret", setupIntentId: "seti_1" }));

describe("vaultCards — the client-side capture sequence", () => {
  it("creates a setup per unverified card, lets the provider fields confirm it, and returns ONLY opaque references", async () => {
    const handle = okHandle("seti_A");
    const onVaulted = vi.fn();
    const r = await vaultCards({ token: "tok", cards: [card()], handles: [handle], createSetup: makeSetupOk(), onVaulted });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cards[0].setupIntentId).toBe("seti_A");
    expect(onVaulted).toHaveBeenCalledWith(0, "seti_A");
    // The name is trimmed and is the only customer datum passed to the provider call; there is no card field anywhere.
    expect(handle.confirmSetup).toHaveBeenCalledWith("seti_1_secret", "Jane Traveler");
    expect(JSON.stringify(r.cards)).not.toMatch(/\d{12,}/);
  });

  it("passes the stable slotKey so a retried request is the same provider setup (idempotent)", async () => {
    const createSetup = makeSetupOk();
    await vaultCards({ token: "tok", cards: [card({ slotKey: "slot-stable-1" })], handles: [okHandle()], createSetup });
    expect(createSetup).toHaveBeenCalledWith({ token: "tok", slotKey: "slot-stable-1" });
  });

  it("skips a card that was already verified on an earlier attempt — the customer is not asked to re-enter it", async () => {
    const createSetup = makeSetupOk();
    const handle = okHandle();
    const r = await vaultCards({ token: "tok", cards: [card({ setupIntentId: "seti_done" })], handles: [handle], createSetup });
    expect(r.ok).toBe(true);
    expect(createSetup).not.toHaveBeenCalled();
    expect(handle.confirmSetup).not.toHaveBeenCalled();
  });

  it("split payment: verifies the second card only, keeps the first card's reference through a failure of the second", async () => {
    const failing: SecureCardHandle = { isComplete: () => true, confirmSetup: vi.fn(async () => ({ ok: false as const, error: "Your card was declined." })) };
    const r = await vaultCards({ token: "tok", cards: [card({ setupIntentId: "seti_first" }), card({ slotKey: "slot-bbbbbbbb" })], handles: [okHandle(), failing], createSetup: makeSetupOk() });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("Your card was declined.");
    expect(r.cards[0].setupIntentId).toBe("seti_first");
    expect(r.cards[1].setupIntentId).toBeNull();
  });

  it("a server-side setup failure stops before the provider fields are touched", async () => {
    const handle = okHandle();
    const r = await vaultCards({ token: "tok", cards: [card()], handles: [handle], createSetup: async () => ({ ok: false, error: "Online booking is temporarily unavailable." }) });
    expect(r).toMatchObject({ ok: false, error: "Online booking is temporarily unavailable." });
    expect(handle.confirmSetup).not.toHaveBeenCalled();
  });

  it("a card whose secure fields are not mounted yet is a friendly error, not a crash", async () => {
    const r = await vaultCards({ token: "tok", cards: [card()], handles: [null], createSetup: makeSetupOk() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/still loading/i);
  });
});
