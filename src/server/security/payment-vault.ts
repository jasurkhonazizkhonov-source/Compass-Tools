// Stable interface the CRM depends on for card storage/retrieval, so the
// booking form, Reveal UI and permission model never need to change when the
// storage implementation does. The implementation is the CRM's own
// application-level AES-256-GCM vault (card-encryption.ts) — there is no
// external provider. It is NOT PCI DSS-grade key management; see
// docs/CARD_VAULT_SECURITY.md. Nothing outside this module should import
// encryptPan or decryptPan directly.
import { encryptPan, decryptPan, CardVaultError } from "./card-encryption";
import { getCardVaultStatus } from "./card-vault-status";

export interface PaymentVault {
  /** Encrypts a plaintext PAN for the row `recordId` and returns the opaque
   * reference to persist in PaymentMethod.encryptedPan. Never returns/logs the
   * plaintext. The row id is bound into the ciphertext (AAD), so it must be the
   * id the row is inserted with. */
  store(pan: string, recordId: string): Promise<string>;
  /** Resolves a stored reference back to the plaintext PAN for that row.
   * Callers must already have completed authorization + audit logging — the
   * vault itself does not gate access. */
  reveal(reference: string, recordId: string): Promise<string>;
}

class ApplicationEncryptedVault implements PaymentVault {
  async store(pan: string, recordId: string): Promise<string> {
    return encryptPan(pan, recordId);
  }
  async reveal(reference: string, recordId: string): Promise<string> {
    return decryptPan(reference, recordId);
  }
}

/** Fail-closed stand-in used whenever storage is not available. It never stores or reveals anything. */
class ClosedVault implements PaymentVault {
  async store(): Promise<never> {
    throw new CardVaultError("VAULT_UNAVAILABLE");
  }
  async reveal(): Promise<never> {
    throw new CardVaultError("VAULT_UNAVAILABLE");
  }
}

/**
 * Fails closed: in a production-class environment the vault opens only when
 * the owner has explicitly set CARD_VAULT_MODE (see card-vault-status.ts) AND
 * the key ring is valid. A generic environment label such as APP_ENV=staging
 * cannot open it. There is no plaintext fallback of any kind.
 */
export function getPaymentVault(): PaymentVault {
  return getCardVaultStatus().storageAvailable ? new ApplicationEncryptedVault() : new ClosedVault();
}
