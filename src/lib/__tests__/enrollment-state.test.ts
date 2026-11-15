import { describe, it, expect } from "vitest";
import { deriveEnrollmentState, computeStepProgress } from "../sequence-progress";
import { failureAttempts, openDelivery, isRealFailure, markerReason, IN_FLIGHT_STALE_MS } from "../sequence-delivery";

// The one place that decides "what is this enrollment doing?" (the lead page and the sequence page both call it), and the delivery-marker helpers it relies on.

const steps = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
const NOW = Date.UTC(2026, 10, 15, 12);
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000);
const active = (over: Partial<{ currentStepIdx: number; nextSendAt: Date | null }> = {}) => ({ status: "ACTIVE" as const, currentStepIdx: 0, nextSendAt: at(-60), ...over });
const state = (p: Parameters<typeof deriveEnrollmentState>[0]) => deriveEnrollmentState({ now: NOW, ...p }).key;

describe("deriveEnrollmentState", () => {
  it("first email pending: active, nothing sent yet, no failure", () => {
    expect(state({ enrollment: active(), steps, logs: [] })).toBe("first_email_pending");
  });

  it("active: at least one step went out", () => {
    expect(state({ enrollment: active({ currentStepIdx: 1 }), steps, logs: [{ stepId: "s1", status: "SENT", sentAt: at(5) }] })).toBe("active");
  });

  it("retry scheduled: the current step has a genuine failed attempt and the enrollment is still active", () => {
    expect(state({ enrollment: active(), steps, logs: [{ stepId: "s1", status: "FAILED", error: "Gmail could not send this email.", createdAt: at(3) }] })).toBe("retry_scheduled");
  });

  it("sending: a recent in-flight marker; an old one is an unknown outcome, i.e. unconfirmed", () => {
    expect(state({ enrollment: active(), steps, logs: [{ stepId: "s1", status: "FAILED", error: "IN_FLIGHT: send started", createdAt: at(1) }] })).toBe("sending");
    expect(state({ enrollment: active(), steps, logs: [{ stepId: "s1", status: "FAILED", error: "IN_FLIGHT: send started", createdAt: new Date(NOW - IN_FLIGHT_STALE_MS - 1000) }] })).toBe("unconfirmed");
  });

  it("unconfirmed: the unresolved UNCERTAIN marker, whatever else the step has in its history", () => {
    const logs = [
      { stepId: "s1", status: "FAILED" as const, error: "Gmail could not send this email.", createdAt: at(30) },
      { stepId: "s1", status: "FAILED" as const, error: "UNCERTAIN: no response", createdAt: at(10) },
    ];
    expect(state({ enrollment: active({ nextSendAt: null }), steps, logs })).toBe("unconfirmed");
  });

  it("a resolved marker no longer holds the step", () => {
    expect(state({ enrollment: active(), steps, logs: [{ stepId: "s1", status: "FAILED", error: "RESOLVED: sent again by Jane", createdAt: at(10) }] })).toBe("first_email_pending");
  });

  it("paused: an active enrollment of a switched-off sequence (even with a failure on record)", () => {
    expect(state({ enrollment: active(), steps, logs: [], sequenceActive: false })).toBe("paused");
    expect(state({ enrollment: active(), steps, logs: [{ stepId: "s1", status: "FAILED", error: "x", createdAt: at(3) }], sequenceActive: false })).toBe("paused");
  });

  it("failed, unenrolled and completed come straight from the stored status - a failed attempt can never be shown as active", () => {
    const logs = [{ stepId: "s1", status: "FAILED" as const, error: "Gmail is not connected", createdAt: at(3) }];
    expect(state({ enrollment: { status: "FAILED", currentStepIdx: 0, nextSendAt: null }, steps, logs })).toBe("failed");
    expect(state({ enrollment: { status: "UNSUBSCRIBED", currentStepIdx: 1, nextSendAt: null }, steps, logs: [] })).toBe("unenrolled");
    expect(state({ enrollment: { status: "COMPLETED", currentStepIdx: 3, nextSendAt: null }, steps, logs: [] })).toBe("completed");
  });

  it("only the CURRENT step's history decides: an old failure of an earlier step that later succeeded does not make the enrollment 'retry scheduled'", () => {
    const logs = [
      { stepId: "s1", status: "FAILED" as const, error: "rate limited", createdAt: at(50) },
      { stepId: "s1", status: "SENT" as const, sentAt: at(40), createdAt: at(40) },
    ];
    expect(state({ enrollment: active({ currentStepIdx: 1 }), steps, logs })).toBe("active");
  });

  it("each state says whether the enrollment is progressing by itself", () => {
    const progressing = (k: Parameters<typeof deriveEnrollmentState>[0]["enrollment"]["status"]) => k;
    void progressing;
    expect(deriveEnrollmentState({ now: NOW, enrollment: active(), steps, logs: [] }).progressing).toBe(true);
    expect(deriveEnrollmentState({ now: NOW, enrollment: active(), steps, logs: [], sequenceActive: false }).progressing).toBe(false);
    expect(deriveEnrollmentState({ now: NOW, enrollment: { status: "FAILED", currentStepIdx: 0, nextSendAt: null }, steps, logs: [] }).progressing).toBe(false);
  });
});

describe("step progress ignores bookkeeping rows and shows the unconfirmed / sending steps", () => {
  it("an in-flight/unconfirmed/restart marker is not a failed attempt; the held step is shown as Unconfirmed", () => {
    const logs = [
      { stepId: "s1", status: "FAILED" as const, error: "RETRY_EPOCH: restarted by Jane", createdAt: at(20) },
      { stepId: "s1", status: "FAILED" as const, error: "UNCERTAIN: no response", createdAt: at(10) },
    ];
    const p = computeStepProgress({ steps, enrollment: active({ nextSendAt: null }), logs, now: NOW });
    expect(p.map((x) => x.status)).toEqual(["uncertain", "pending", "pending"]);
  });

  it("a recent in-flight marker shows as Sending", () => {
    const p = computeStepProgress({ steps, enrollment: active(), logs: [{ stepId: "s1", status: "FAILED", error: "IN_FLIGHT: send started", createdAt: at(1) }], now: NOW });
    expect(p[0].status).toBe("sending");
  });
});

describe("delivery marker helpers", () => {
  it("failureAttempts counts only genuine failures since the last manual restart", () => {
    const logs = [
      { status: "FAILED" as const, error: "a", createdAt: at(100) },
      { status: "FAILED" as const, error: "b", createdAt: at(90) },
      { status: "FAILED" as const, error: "c", createdAt: at(80) },
      { status: "FAILED" as const, error: "RETRY_EPOCH: restarted", createdAt: at(70) },
      { status: "FAILED" as const, error: "UNCERTAIN: x", createdAt: at(60) },
      { status: "FAILED" as const, error: "d", createdAt: at(50) },
    ];
    expect(failureAttempts(logs)).toBe(1);
    expect(failureAttempts(logs.slice(0, 3))).toBe(3);
    expect(failureAttempts([])).toBe(0);
  });

  it("openDelivery looks only at the most recent row", () => {
    expect(openDelivery([{ status: "FAILED", error: "IN_FLIGHT: x", createdAt: at(5) }])?.kind).toBe("IN_FLIGHT");
    expect(openDelivery([{ status: "FAILED", error: "UNCERTAIN: x", createdAt: at(5) }, { status: "SENT", createdAt: at(1) }])).toBeNull();
    expect(openDelivery([])).toBeNull();
  });

  it("isRealFailure and markerReason", () => {
    expect(isRealFailure({ status: "FAILED", error: "Gmail could not send" })).toBe(true);
    expect(isRealFailure({ status: "FAILED", error: "UNCERTAIN: no response" })).toBe(false);
    expect(isRealFailure({ status: "SENT" })).toBe(false);
    expect(markerReason("UNCERTAIN: no response")).toBe("no response");
  });
});
