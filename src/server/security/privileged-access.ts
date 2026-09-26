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

/** How recently the account must have signed in to Reveal a full card number. */
export const RECENT_LOGIN_WINDOW_MS = 15 * 60 * 1000;

export type RecentLoginResult = { ok: true; note?: "NOT_AVAILABLE_IN_DEVELOPMENT" } | { ok: false; reason: "RECENT_LOGIN_REQUIRED" };

/**
 * Real step-up for full-card Reveal, built on what this app genuinely has: the
 * session is issued by a fresh Google sign-in and `sessionCreatedAt` is that
 * sign-in time (it is never refreshed by activity). Reveal therefore requires
 * the account to have signed in within RECENT_LOGIN_WINDOW_MS — an idle or
 * stolen older session cannot decrypt a card, and the user must complete a new
 * Google sign-in (with whatever MFA their Google account enforces) first.
 *
 * This is NOT app-managed MFA and does not claim to be. It applies in every
 * production-class environment regardless of how the card vault was enabled.
 * Local development/tests (no real sign-in) pass through explicitly.
 */
export function requireRecentLogin(sessionCreatedAt: Date | null | undefined, now: number = Date.now()): RecentLoginResult {
  if (!isProductionEnvironment()) return { ok: true, note: "NOT_AVAILABLE_IN_DEVELOPMENT" };
  if (!sessionCreatedAt) return { ok: false, reason: "RECENT_LOGIN_REQUIRED" };
  const age = now - sessionCreatedAt.getTime();
  return age >= 0 && age <= RECENT_LOGIN_WINDOW_MS ? { ok: true } : { ok: false, reason: "RECENT_LOGIN_REQUIRED" };
}

/** Alias — today both checks resolve to the same "no real system yet"
 * outcome, but are named separately so a real implementation can
 * distinguish "signed in recently" from "completed an MFA challenge". */
export function requireMfa(): StepUpAuthResult {
  return requireRecentAuthentication();
}
