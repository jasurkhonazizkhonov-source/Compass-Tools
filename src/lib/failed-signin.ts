// Standard reason codes and wording for the Administrator-only failed sign-in log. Safe to import anywhere (no server code).
export const FAILED_SIGNIN_METHODS = { GOOGLE_OAUTH: "Google sign-in" } as const;
export type FailedSignInMethod = keyof typeof FAILED_SIGNIN_METHODS;

export const FAILED_SIGNIN_REASONS = {
  GOOGLE_VERIFICATION_FAILED: { label: "OAuth authentication failure", description: "Google did not accept or could not verify the credential that was presented." },
  UNKNOWN_ACCOUNT: { label: "Unknown account", description: "Google verified this identity, but no CRM user exists for it." },
  ACCOUNT_DISABLED: { label: "Account disabled", description: "Google verified this identity and a CRM user exists, but the account is disabled." },
  NOT_INITIALIZED: { label: "CRM not initialised", description: "A sign-in was attempted before the CRM had any user and before the initial administrator was configured." },
  BOOTSTRAP_EMAIL_MISMATCH: { label: "Initial-administrator mismatch", description: "The CRM had no users yet and this Google account is not the configured initial administrator." },
  EVENTS_SUPPRESSED: { label: "Repeated attempts (recording limit reached)", description: "More attempts than the recording limit came from one address in a short time; this single row stands for the additional attempts (see the count)." },
} as const;
export type FailedSignInReason = keyof typeof FAILED_SIGNIN_REASONS;

export const FAILED_SIGNIN_REASON_CODES = Object.keys(FAILED_SIGNIN_REASONS) as FailedSignInReason[];

export function reasonLabel(code: string): string {
  return (FAILED_SIGNIN_REASONS as Record<string, { label: string }>)[code]?.label ?? "Other";
}
export function methodLabel(code: string): string {
  return (FAILED_SIGNIN_METHODS as Record<string, string>)[code] ?? code;
}

/** Recording limits (per trusted IP address): beyond them individual rows are replaced by ONE roll-up row with a count - never silently dropped. */
export const FAILED_SIGNIN_LIMIT_PER_IP = 20;
export const FAILED_SIGNIN_LIMIT_WINDOW_MS = 10 * 60_000;
/** A repeat delivery of the same credential within this window is the same attempt, not a new one. */
export const FAILED_SIGNIN_DUPLICATE_WINDOW_MS = 60_000;
