// Stable interface the CRM depends on for card storage/retrieval, so the
// booking form, PaymentMethodCard reveal UI, and permission model never
// need to change when the underlying storage implementation does. Today
// the only implementation is a dev-only AES-256-GCM wrapper around
// card-encryption.ts (see that file's warning comment); a production
// deployment must supply a real implementation — an enterprise KMS/HSM
// client or a dedicated PCI-compliant vault provider's SDK — behind this
// same interface. Nothing outside this module should import encryptPan or
// decryptPan directly.
import { encryptPan, decryptPan } from "./card-encryption";
import { isProductionEnvironment } from "@/lib/env";

export interface PaymentVault {
  /** Stores a plaintext PAN and returns an opaque reference to persist in
   * PaymentMethod.encryptedPan. Never returns/logs the plaintext. */
  store(pan: string): Promise<string>;
  /** Resolves a stored reference back to the plaintext PAN. Callers must
   * already have completed authorization + audit logging before calling
   * this — the vault itself does not gate access. */
  reveal(reference: string): Promise<string>;
}

class DevelopmentEncryptedVault implements PaymentVault {
  async store(pan: string): Promise<string> {
    return encryptPan(pan);
  }
  async reveal(reference: string): Promise<string> {
    return decryptPan(reference);
  }
}

/**
 * Fails closed: production must never silently fall back to the dev-only
 * AES key just because CARD_ENCRYPTION_KEY happens to be set in a
 * production environment's config. Until a real production vault provider
 * is wired up here, every card operation in production throws rather than
 * proceeding with non-compliant storage.
 */
class ProductionVaultNotConfigured implements PaymentVault {
  async store(): Promise<never> {
    throw new Error(
      "No production-grade card vault is configured. Refusing to store card data using the development encryption fallback. Configure a real KMS/HSM or PCI-compliant vault provider in payment-vault.ts before running with APP_ENV=production."
    );
  }
  async reveal(): Promise<never> {
    throw new Error(
      "No production-grade card vault is configured. Refusing to reveal card data using the development encryption fallback."
    );
  }
}

export function getPaymentVault(): PaymentVault {
  if (isProductionEnvironment()) {
    return new ProductionVaultNotConfigured();
  }
  return new DevelopmentEncryptedVault();
}
