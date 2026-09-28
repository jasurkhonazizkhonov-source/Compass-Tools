// Conservative low-quality-email screening for the PUBLIC CRM contact form.
//
// Deliberately small: there is no maintained disposable-domain dependency in
// this project, and a large hand-copied list goes stale and risks rejecting
// real customers. This list only names dedicated throwaway-inbox services
// that have no legitimate customer use; it is NOT exhaustive and is not a
// substitute for the honeypot, rate limit and duplicate guard. Addresses at
// mainstream providers (Gmail, Outlook, Yahoo, iCloud, Proton...) and at any
// business/regional domain are never affected.
const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "sharklasers.com",
  "grr.la",
  "10minutemail.com",
  "10minutemail.net",
  "tempmail.com",
  "temp-mail.org",
  "temp-mail.io",
  "tempmailo.com",
  "yopmail.com",
  "yopmail.net",
  "throwawaymail.com",
  "trashmail.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "fakeinbox.com",
  "mailnesia.com",
  "mintemail.com",
  "spamgourmet.com",
]);

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** True when the address is at (or a subdomain of) a known throwaway-inbox service. */
export function isDisposableEmail(raw: string): boolean {
  const email = normalizeEmail(raw);
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1);
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true;
  const parts = domain.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

export const INVALID_EMAIL_MESSAGE = "Please enter a valid email address.";
