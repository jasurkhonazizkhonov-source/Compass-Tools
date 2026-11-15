// The delivery record of ONE sequence step, kept in the existing SequenceStepLog rows (no schema change).
//
// Why this exists: Gmail's send API cannot be asked "did you already send message X?" (the CRM only has the send permission, not read access), and a send can
// succeed at Gmail while the CRM never learns it (a timeout, a dropped connection, a crash before the log is written). Blindly resending in that situation
// puts the same email in a customer's inbox twice. So every send is bracketed by a marker row written BEFORE the request:
//
//   IN_FLIGHT:   written before the Gmail request. Replaced by SENT (success) or a plain FAILED row (a definite refusal) when the outcome is known.
//                One that is still IN_FLIGHT when the step is next picked up means the process died, or the call never reported back: the outcome is UNKNOWN.
//   UNCERTAIN:   the outcome is unknown (an in-flight marker that never resolved, a timeout, a 5xx). The step is NEVER resent automatically; a person decides
//                ("it was sent" / "send again") after looking at the sender's Gmail Sent folder.
//   RETRY_EPOCH: written when a person restarts an enrollment that had given up; failures before it no longer count toward the automatic-retry limit.
//   RESOLVED:    an UNCERTAIN/IN_FLIGHT marker a person resolved with "send again" (kept as history; not an attempt, not an open question).
//
// All four are status FAILED rows whose error text starts with the prefix, so every existing reader keeps working; readers that show failures or count
// attempts must use the helpers below instead of looking at the raw error text.

export const IN_FLIGHT_PREFIX = "IN_FLIGHT:";
export const UNCERTAIN_PREFIX = "UNCERTAIN:";
export const RETRY_EPOCH_PREFIX = "RETRY_EPOCH:";
export const RESOLVED_PREFIX = "RESOLVED:";

/** How long an IN_FLIGHT marker is shown as "sending" before it is treated as an unknown outcome (the claim lease is 2 minutes; sends time out at 30 s). */
export const IN_FLIGHT_STALE_MS = 3 * 60_000;

export type StepLogLike = { id?: string; status: "SENT" | "FAILED"; error?: string | null; createdAt?: Date | null; sentAt?: Date | null };

const startsWith = (error: string | null | undefined, prefix: string) => typeof error === "string" && error.startsWith(prefix);

export const isInFlightMarker = (l: StepLogLike) => l.status === "FAILED" && startsWith(l.error, IN_FLIGHT_PREFIX);
export const isUncertainMarker = (l: StepLogLike) => l.status === "FAILED" && startsWith(l.error, UNCERTAIN_PREFIX);
export const isRetryEpochMarker = (l: StepLogLike) => l.status === "FAILED" && startsWith(l.error, RETRY_EPOCH_PREFIX);
export const isResolvedMarker = (l: StepLogLike) => l.status === "FAILED" && startsWith(l.error, RESOLVED_PREFIX);
/** Any bookkeeping row (not a real failed attempt). */
export const isMarkerLog = (l: StepLogLike) => isInFlightMarker(l) || isUncertainMarker(l) || isRetryEpochMarker(l) || isResolvedMarker(l);
/** A genuine, definite failed attempt (Gmail refused or was never asked). */
export const isRealFailure = (l: StepLogLike) => l.status === "FAILED" && !isMarkerLog(l);

const time = (l: StepLogLike) => (l.createdAt ? l.createdAt.getTime() : 0);

/** The text after a marker prefix, for display ("no response from Gmail"). */
export function markerReason(error: string | null | undefined): string {
  if (!error) return "";
  for (const p of [IN_FLIGHT_PREFIX, UNCERTAIN_PREFIX, RETRY_EPOCH_PREFIX, RESOLVED_PREFIX]) if (error.startsWith(p)) return error.slice(p.length).trim();
  return error;
}

/**
 * The still-open question about a step's delivery, from ITS log rows: the most recent row, when it is an IN_FLIGHT or UNCERTAIN marker. null when the
 * step has no unresolved attempt. (Rows of other steps must not be passed in.)
 */
export function openDelivery(logs: StepLogLike[]): { kind: "IN_FLIGHT" | "UNCERTAIN"; log: StepLogLike } | null {
  const latest = [...logs].sort((a, b) => time(b) - time(a))[0];
  if (!latest) return null;
  if (isInFlightMarker(latest)) return { kind: "IN_FLIGHT", log: latest };
  if (isUncertainMarker(latest)) return { kind: "UNCERTAIN", log: latest };
  return null;
}

/** Real failed attempts of this step since the last manual restart (RETRY_EPOCH), i.e. what counts toward the automatic retry limit. */
export function failureAttempts(logs: StepLogLike[]): number {
  const epoch = Math.max(0, ...logs.filter(isRetryEpochMarker).map(time));
  return logs.filter((l) => isRealFailure(l) && time(l) >= epoch).length;
}

/** True while an in-flight marker is recent enough to still be a send in progress rather than an abandoned one. */
export function isRecentInFlight(log: StepLogLike, now = Date.now()): boolean {
  return isInFlightMarker(log) && !!log.createdAt && now - log.createdAt.getTime() <= IN_FLIGHT_STALE_MS;
}
