import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { hashSessionToken, isSessionEndReason, revocationToReason, SESSION_END_MESSAGES } from "../session-token";

describe("session token hashing (how a revoked session is recognised without keeping the token)", () => {
  it("is a lowercase 64-character SHA-256 hex, stable, and different for different tokens", () => {
    const h = hashSessionToken("abc");
    expect(h).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken("abc")).toBe(h);
    expect(hashSessionToken("abd")).not.toBe(h);
  });

  it("never contains the token itself", () => {
    const token = "Zm9vYmFyYmF6cXV4";
    expect(hashSessionToken(token)).not.toContain(token);
  });
});

describe("why a session ended", () => {
  it("maps the stored revocation reason to the /login reason value", () => {
    expect(revocationToReason("SUPERSEDED")).toBe("superseded");
    expect(revocationToReason("SIGNED_OUT_ALL")).toBe("signed-out-all");
  });

  it("only the two known reasons are accepted from the query string", () => {
    expect(isSessionEndReason("superseded")).toBe(true);
    expect(isSessionEndReason("signed-out-all")).toBe(true);
    for (const bad of ["expired", "", "SUPERSEDED", undefined, null, 1, ["superseded"], "<script>"]) expect(isSessionEndReason(bad)).toBe(false);
  });

  it("the messages are non-sensitive: no device, IP, location or browser detail, and the single-device wording is exact", () => {
    expect(SESSION_END_MESSAGES.superseded).toContain("Your session ended because this account signed in on another device.");
    for (const message of Object.values(SESSION_END_MESSAGES)) {
      expect(message).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
      expect(message).not.toMatch(/chrome|safari|firefox|windows|mac|iphone|android|location|ip address/i);
    }
  });
});
