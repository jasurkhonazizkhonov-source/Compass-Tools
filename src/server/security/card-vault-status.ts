// Whether the CRM's own card vault can accept a card right now — a pure
// environment check (no database, no secret ever returned). It mirrors exactly
// what getPaymentVault() (payment-vault.ts) will do when a customer presses
// "Finish Booking", so readiness reporting can never disagree with reality:
//
//   - PRODUCTION guard: in a production environment the vault refuses to store
//     a card (see payment-vault.ts) unless the deployment has deliberately been
//     told it is not production (APP_ENV — docs/DEPLOYMENT.md §5c). The vault is
//     application-level AES encryption, NOT PCI DSS-grade key management.
//   - KEY: CARD_ENCRYPTION_KEY must be a base64-encoded 32-byte key.
//
// The card security code (CVV/CVC) is never stored either way.
import { isProductionEnvironment } from "@/lib/env";

export type CardVaultKeyStatus = "configured" | "missing" | "invalid";

/** Presence/validity of CARD_ENCRYPTION_KEY without ever exposing it. */
export function cardVaultKeyStatus(raw: string | undefined = process.env.CARD_ENCRYPTION_KEY): CardVaultKeyStatus {
  const value = raw?.trim();
  if (!value) return "missing";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return "invalid";
  return Buffer.from(value, "base64").length === 32 ? "configured" : "invalid";
}

export type CardVaultStatus = {
  /** true when a customer's "Finish Booking" can store its card right now. */
  storageAvailable: boolean;
  key: CardVaultKeyStatus;
  /** true when the environment is treated as production, where the vault fails closed. */
  productionGuard: boolean;
  /** Why storage is unavailable, when it is. */
  blockedBy: "production_guard" | "key_missing" | "key_invalid" | null;
};

export function getCardVaultStatus(): CardVaultStatus {
  const key = cardVaultKeyStatus();
  const productionGuard = isProductionEnvironment();
  const blockedBy = productionGuard ? "production_guard" : key === "missing" ? "key_missing" : key === "invalid" ? "key_invalid" : null;
  return { storageAvailable: blockedBy === null, key, productionGuard, blockedBy };
}
