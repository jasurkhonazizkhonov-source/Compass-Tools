import { isProductionEnvironment } from "@/lib/env";

export type StepUpAuthResult =
  | { ok: true; note?: "NOT_AVAILABLE_IN_DEVELOPMENT" }
  | { ok: false; reason: "MFA_REQUIRED_NOT_CONFIGURED" };

/**
 * Gate for privileged actions (full-PAN reveal, booking IP reveal) that
 * should require recent re-authentication / MFA before proceeding. This
 * app's current auth is a dev-mode cookie switcher — there is no real
 * login, session, or MFA system to check a genuine signal against yet.
 *
 * Development/test: explicitly reports NOT_AVAILABLE_IN_DEVELOPMENT and
 * allows the caller through (`ok: true`), so Reveal workflows stay
 * testable and demonstrable without a real auth system.
 *
 * Production: fails CLOSED (`ok: false`). Do not "fix" a production
 * failure here by adding a fake `mfaVerified = true` — wire a real
 * step-up/MFA provider into this function instead. Until that exists,
 * production must not allow privileged Reveal at all, which is the
 * correct and intentional behavior, not a bug.
 */
export function requireRecentAuthentication(): StepUpAuthResult {
  if (isProductionEnvironment()) {
    return { ok: false, reason: "MFA_REQUIRED_NOT_CONFIGURED" };
  }
  return { ok: true, note: "NOT_AVAILABLE_IN_DEVELOPMENT" };
}

/** Alias — today both checks resolve to the same "no real system yet"
 * outcome, but are named separately so a real implementation can
 * distinguish "signed in recently" from "completed an MFA challenge". */
export function requireMfa(): StepUpAuthResult {
  return requireRecentAuthentication();
}
