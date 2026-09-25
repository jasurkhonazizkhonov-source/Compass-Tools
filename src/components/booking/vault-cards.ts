// The client-side sequence that turns "cards the customer typed into the
// provider's secure fields" into opaque references the booking action can
// verify. Pulled out of BookingFlow so its retry/idempotency behavior is
// unit-testable. No card number or security code exists in this module or in
// anything it touches: the handle can SEND the card to the provider, never read it.
import type { CardFormState } from "@/components/booking/card-payment-section";
import type { SecureCardHandle } from "@/components/payments/secure-card-fields";

export type CreateSetup = (input: { token: string; slotKey: string }) => Promise<{ ok: true; clientSecret: string; setupIntentId: string } | { ok: false; error: string }>;

export type VaultResult =
  | { ok: true; cards: CardFormState[] }
  // `cards` carries every reference obtained BEFORE the failure, so a retry never asks the customer to re-enter a card that was already verified.
  | { ok: false; error: string; cards: CardFormState[] };

export async function vaultCards(params: {
  token: string;
  cards: CardFormState[];
  handles: Array<SecureCardHandle | null>;
  createSetup: CreateSetup;
  onVaulted?: (index: number, setupIntentId: string) => void;
}): Promise<VaultResult> {
  const cards = [...params.cards];
  for (let i = 0; i < cards.length; i++) {
    if (cards[i].setupIntentId) continue; // already verified on an earlier attempt
    const handle = params.handles[i];
    if (!handle) return { ok: false, error: "The secure card form is still loading. Please wait a moment and try again.", cards };
    const setup = await params.createSetup({ token: params.token, slotKey: cards[i].slotKey });
    if (!setup.ok) return { ok: false, error: setup.error, cards };
    const confirmed = await handle.confirmSetup(setup.clientSecret, cards[i].cardholderName.trim());
    if (!confirmed.ok) return { ok: false, error: confirmed.error, cards };
    cards[i] = { ...cards[i], setupIntentId: confirmed.setupIntentId };
    params.onVaulted?.(i, confirmed.setupIntentId);
  }
  return { ok: true, cards };
}
