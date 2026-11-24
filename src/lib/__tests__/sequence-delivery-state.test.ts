import { describe, it, expect } from "vitest";
import {
  DELIVERY_STATES,
  DELIVERY_TRANSITIONS,
  InvalidDeliveryTransition,
  assertTransition,
  canTransition,
  deliveryStateOfLog,
  effectiveDeliveryState,
  mayAutomaticallySend,
  transitionActor,
  LEGACY_MARKER_TO_STATE,
  type DeliveryState,
} from "../sequence-delivery-state";

const NOW = Date.UTC(2026, 10, 20, 12);
const log = (status: "SENT" | "FAILED", error: string | null, minutesAgo = 1) => ({ status, error, createdAt: new Date(NOW - minutesAgo * 60_000) });

describe("transitions: every pair is either valid or rejected", () => {
  const VALID: Array<[DeliveryState, DeliveryState]> = [
    ["SENDING", "SENT"],
    ["SENDING", "FAILED"],
    ["SENDING", "UNKNOWN"],
    ["SENDING", "SUPERSEDED"], // Gmail refused because the mailbox hit a sending limit: nothing was sent, not a failure
    ["UNKNOWN", "SENT"],
    ["UNKNOWN", "SUPERSEDED"],
  ];
  it.each(VALID)("%s -> %s is valid", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it("every other pair (including staying put and going back) is rejected with InvalidDeliveryTransition", () => {
    for (const from of DELIVERY_STATES) {
      for (const to of DELIVERY_STATES) {
        if (VALID.some(([a, b]) => a === from && b === to)) continue;
        expect(canTransition(from, to), `${from}->${to}`).toBe(false);
        expect(() => assertTransition(from, to)).toThrow(InvalidDeliveryTransition);
      }
    }
  });

  it("SENT, FAILED and SUPERSEDED are terminal: a retry is a new attempt, never an edit of a finished one", () => {
    for (const s of ["SENT", "FAILED", "SUPERSEDED"] as const) expect(DELIVERY_TRANSITIONS[s]).toEqual([]);
  });

  it("an unknown outcome can never become FAILED or SENDING again (it can only be resolved by a person: sent, or send again)", () => {
    expect(canTransition("UNKNOWN", "FAILED")).toBe(false);
    expect(canTransition("UNKNOWN", "SENDING")).toBe(false);
  });

  it("who causes each transition: the worker for SENDING -> anything, only a person for UNKNOWN -> anything", () => {
    expect(transitionActor("SENDING", "SENT")).toBe("automatic");
    expect(transitionActor("SENDING", "UNKNOWN")).toBe("automatic");
    expect(transitionActor("UNKNOWN", "SENT")).toBe("manual");
    expect(transitionActor("UNKNOWN", "SUPERSEDED")).toBe("manual");
    expect(() => transitionActor("SENT", "FAILED")).toThrow(InvalidDeliveryTransition);
  });
});

describe("legacy text markers map onto the typed states (what a migration would convert)", () => {
  it("each marker and plain row", () => {
    expect(deliveryStateOfLog(log("SENT", null))).toBe("SENT");
    expect(deliveryStateOfLog(log("FAILED", "Gmail could not send this email."))).toBe("FAILED");
    expect(deliveryStateOfLog(log("FAILED", "IN_FLIGHT: send started"))).toBe("SENDING");
    expect(deliveryStateOfLog(log("FAILED", "UNCERTAIN: no response"))).toBe("UNKNOWN");
    expect(deliveryStateOfLog(log("FAILED", "RESOLVED: sent again by Jane"))).toBe("SUPERSEDED");
  });

  it("a restart boundary is not an attempt", () => {
    expect(deliveryStateOfLog(log("FAILED", "RETRY_EPOCH: restarted by Jane"))).toBeNull();
  });

  it("rows written before delivery markers existed (plain SENT / FAILED, even with no error text) need no conversion", () => {
    expect(deliveryStateOfLog({ status: "SENT" })).toBe("SENT");
    expect(deliveryStateOfLog({ status: "FAILED" })).toBe("FAILED");
    expect(deliveryStateOfLog({ status: "FAILED", error: null })).toBe("FAILED");
  });

  it("an in-flight attempt older than the stale window is UNKNOWN, a recent one is SENDING", () => {
    expect(effectiveDeliveryState(log("FAILED", "IN_FLIGHT: send started", 1), NOW)).toBe("SENDING");
    expect(effectiveDeliveryState(log("FAILED", "IN_FLIGHT: send started", 10), NOW)).toBe("UNKNOWN");
  });

  it("the documented mapping covers every marker", () => {
    expect(Object.keys(LEGACY_MARKER_TO_STATE)).toEqual(expect.arrayContaining(["IN_FLIGHT:", "UNCERTAIN:", "RESOLVED:", "RETRY_EPOCH:"]));
  });
});

describe("mayAutomaticallySend - the one rule that must never break", () => {
  it("nothing recorded: a first attempt is allowed", () => {
    expect(mayAutomaticallySend([], NOW)).toBe(true);
  });
  it("a confirmed failure may be retried", () => {
    expect(mayAutomaticallySend([log("FAILED", "rate limited", 20)], NOW)).toBe(true);
  });
  it("an attempt in flight, or an unknown outcome, is NEVER sent again automatically", () => {
    expect(mayAutomaticallySend([log("FAILED", "IN_FLIGHT: send started", 1)], NOW)).toBe(false);
    expect(mayAutomaticallySend([log("FAILED", "IN_FLIGHT: send started", 30)], NOW)).toBe(false); // abandoned = unknown
    expect(mayAutomaticallySend([log("FAILED", "UNCERTAIN: no response", 30)], NOW)).toBe(false);
    expect(mayAutomaticallySend([log("FAILED", "rate limited", 50), log("FAILED", "UNCERTAIN: no response", 30)], NOW)).toBe(false);
  });
  it("a step already sent is never sent again", () => {
    expect(mayAutomaticallySend([log("SENT", null, 5)], NOW)).toBe(false);
  });
  it("after a person resolves it as 'send again' the old attempt no longer blocks", () => {
    expect(mayAutomaticallySend([log("FAILED", "RESOLVED: sent again by Jane", 5)], NOW)).toBe(true);
  });
});
