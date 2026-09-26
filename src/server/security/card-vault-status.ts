// Whether the CRM's own card vault can accept or reveal a card right now — a
// pure environment check (no database, no secret ever returned). It is the
// single source of truth used by getPaymentVault() (payment-vault.ts) AND by
// every readiness report (banner, System Health, /api/health), so what is
// reported can never disagree with what "Finish Booking" will actually do.
//
// The vault opens only when ALL of these hold:
//   1. The key ring is valid (card-keyring.ts): a usable current key exists.
//   2. In a production-class environment (production or a Vercel preview),
//      the owner has explicitly accepted application-level encryption by
//      setting CARD_VAULT_MODE to the exact phrase below. This is deliberately
//      NOT a boolean and NOT tied to the environment label: APP_ENV="staging",
//      "true", "1" or any other generic value opens nothing. Local development
//      and tests do not need the phrase.
//
// The card security code (CVV/CVC) is never stored either way.
import { getAppEnvironment, isProductionEnvironment, type AppEnvironment } from "@/lib/env";
import { getKeyringStatus, type KeyringState } from "./card-keyring";

/** The one value of CARD_VAULT_MODE that opens the vault in a production-class environment. */
export const CARD_VAULT_MODE_ACCEPTED = "application-encryption-risk-accepted";

/** @deprecated kept for callers that only need key presence; use getKeyringStatus(). */
export type CardVaultKeyStatus = KeyringState;

export type CardVaultBlockedBy = "vault_not_enabled" | "key_missing" | "key_invalid";

/**
 * One label for the vault's configured state:
 *   disabled                  production-class and CARD_VAULT_MODE not set to the acceptance phrase
 *   misconfigured             the key ring is missing or invalid
 *   available                 non-production (local/test) with a valid ring
 *   available_risk_accepted   production-class, explicitly enabled, valid ring — application-managed
 *                             encryption is in use and its risk has been accepted by the owner
 * (A runtime failure while storing a card — e.g. a database fault — is not a
 * configuration state; it surfaces as a recorded System Health incident.)
 */
export type CardVaultState = "disabled" | "misconfigured" | "available" | "available_risk_accepted";

export type CardVaultStatus = {
  /** true when a card can be stored / revealed right now. */
  storageAvailable: boolean;
  environment: AppEnvironment;
  /** Production or preview — where the explicit CARD_VAULT_MODE is required. */
  productionClass: boolean;
  /** CARD_VAULT_MODE holds the exact acceptance phrase. */
  modeAccepted: boolean;
  state: CardVaultState;
  key: KeyringState;
  /** Id (a label, never key material) new cards are encrypted under. */
  keyVersion: string | null;
  keyIds: string[];
  /** Variable names / key ids only — never a value. */
  problems: string[];
  blockedBy: CardVaultBlockedBy | null;
};

export function getCardVaultStatus(): CardVaultStatus {
  const ring = getKeyringStatus();
  const productionClass = isProductionEnvironment();
  const modeAccepted = process.env.CARD_VAULT_MODE?.trim() === CARD_VAULT_MODE_ACCEPTED; // trimmed: a pasted trailing newline must not silently keep the vault closed
  const blockedBy: CardVaultBlockedBy | null =
    productionClass && !modeAccepted ? "vault_not_enabled" : ring.state === "missing" ? "key_missing" : ring.state === "invalid" ? "key_invalid" : null;
  const state: CardVaultState =
    blockedBy === "vault_not_enabled" ? "disabled" : blockedBy !== null ? "misconfigured" : productionClass ? "available_risk_accepted" : "available";
  return {
    storageAvailable: blockedBy === null,
    state,
    environment: getAppEnvironment(),
    productionClass,
    modeAccepted,
    key: ring.state,
    keyVersion: ring.currentKeyId,
    keyIds: ring.keyIds,
    problems: ring.problems,
    blockedBy,
  };
}
