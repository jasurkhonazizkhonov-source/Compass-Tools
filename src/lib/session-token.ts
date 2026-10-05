import { createHash } from "node:crypto";

/**
 * SHA-256 (hex) of a session token. Used only to RECOGNISE a token that has stopped working (see RevokedSession): the
 * raw token is never copied anywhere, so the revocation table cannot be used to sign in as anyone.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type SessionEndReason = "superseded" | "signed-out-all";

/** The /login?reason= value for a revoked session, and the non-sensitive message it shows. Never names a device, IP or place. */
export const SESSION_END_MESSAGES: Record<SessionEndReason, string> = {
  superseded: "Your session ended because this account signed in on another device. Please sign in again.",
  "signed-out-all": "You were signed out by an administrator. Please sign in again.",
};

export function isSessionEndReason(value: unknown): value is SessionEndReason {
  return value === "superseded" || value === "signed-out-all";
}

export function revocationToReason(reason: "SUPERSEDED" | "SIGNED_OUT_ALL"): SessionEndReason {
  return reason === "SUPERSEDED" ? "superseded" : "signed-out-all";
}
