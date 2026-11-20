import { isInFlightMarker, isResolvedMarker, isRetryEpochMarker, isUncertainMarker, type StepLogLike } from "@/lib/sequence-delivery";

// The typed delivery-state model for ONE send attempt of ONE sequence step, expressed in code today over the existing text markers (lib/sequence-delivery.ts)
// and designed so a future migration can store the same states in a typed column without changing any rule (docs: COMPASS_SEQUENCE_DELIVERY_AND_CONTACT_PERMISSION_
// MIGRATION_READINESS.md). Nothing here touches a database.
//
//   SENDING     write-ahead recorded; the request to Gmail may or may not have left.
//   SENT        Gmail accepted the message (or a person confirmed it was sent).
//   FAILED      a CONFIRMED failure: Gmail refused, or was never asked. Safe to retry.
//   UNKNOWN     the outcome is not known (timeout, 5xx, a send that never reported back). Never resent automatically; a person resolves it.
//   SUPERSEDED  an UNKNOWN attempt a person resolved with "send again": kept as history, no longer open.
//
// "Pending" is not a stored attempt state: it is the absence of any attempt for the step (the enrollment is ACTIVE with a nextSendAt). "Cancelled" is not
// either: it is the enrollment being UNSUBSCRIBED (nothing more is attempted), so no attempt row is ever created for a cancelled step.

export type DeliveryState = "SENDING" | "SENT" | "FAILED" | "UNKNOWN" | "SUPERSEDED";

export const DELIVERY_STATES: readonly DeliveryState[] = ["SENDING", "SENT", "FAILED", "UNKNOWN", "SUPERSEDED"];

/** Every valid transition. SENT, FAILED and SUPERSEDED are terminal for an attempt (a retry is a NEW attempt, never an edit of a finished one). */
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  SENDING: ["SENT", "FAILED", "UNKNOWN"],
  UNKNOWN: ["SENT", "SUPERSEDED"],
  SENT: [],
  FAILED: [],
  SUPERSEDED: [],
};

export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

export class InvalidDeliveryTransition extends Error {
  constructor(public readonly from: DeliveryState, public readonly to: DeliveryState) {
    super(`Invalid delivery transition ${from} -> ${to}`);
    this.name = "InvalidDeliveryTransition";
  }
}

export function assertTransition(from: DeliveryState, to: DeliveryState): void {
  if (!canTransition(from, to)) throw new InvalidDeliveryTransition(from, to);
}

/** Who may cause a transition: the worker alone ("automatic") or a person ("manual"). A person can only ever resolve an UNKNOWN attempt. */
export function transitionActor(from: DeliveryState, to: DeliveryState): "automatic" | "manual" {
  assertTransition(from, to);
  return from === "UNKNOWN" ? "manual" : "automatic";
}

/**
 * The state of one step-log row. Returns null for a row that is not an attempt: a restart boundary (RETRY_EPOCH). Legacy rows written before delivery markers
 * existed are plain SENT / FAILED rows and map straight onto SENT / FAILED, so no data conversion is needed for them.
 */
export function deliveryStateOfLog(log: StepLogLike): DeliveryState | null {
  if (log.status === "SENT") return "SENT";
  if (isRetryEpochMarker(log)) return null;
  if (isInFlightMarker(log)) return "SENDING";
  if (isUncertainMarker(log)) return "UNKNOWN";
  if (isResolvedMarker(log)) return "SUPERSEDED";
  return "FAILED";
}

/** A SENDING attempt that is older than this is an abandoned one (the process died): it is treated as UNKNOWN. */
export function effectiveDeliveryState(log: StepLogLike, now = Date.now(), staleAfterMs = 3 * 60_000): DeliveryState | null {
  const state = deliveryStateOfLog(log);
  if (state !== "SENDING") return state;
  const started = log.createdAt ? log.createdAt.getTime() : 0;
  return now - started > staleAfterMs ? "UNKNOWN" : "SENDING";
}

/** The mapping a migration would apply to existing rows (also the documentation of what each marker means). */
export const LEGACY_MARKER_TO_STATE = {
  "SENT row": "SENT",
  "FAILED row without a marker": "FAILED",
  "IN_FLIGHT:": "SENDING (stale ones: UNKNOWN)",
  "UNCERTAIN:": "UNKNOWN",
  "RESOLVED:": "SUPERSEDED",
  "RETRY_EPOCH:": "not an attempt: becomes the enrollment's attemptsResetAt",
} as const;

/** Whether an automatic resend of a step may be considered: only when no attempt is open and none is UNKNOWN. */
export function mayAutomaticallySend(logsOfStep: StepLogLike[], now = Date.now()): boolean {
  const states = logsOfStep.map((l) => effectiveDeliveryState(l, now)).filter((s): s is DeliveryState => s !== null);
  if (states.includes("SENT")) return false; // already delivered: never again
  return !states.some((s) => s === "SENDING" || s === "UNKNOWN");
}
