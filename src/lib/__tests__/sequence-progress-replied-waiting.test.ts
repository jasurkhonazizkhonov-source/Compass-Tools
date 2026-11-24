import { describe, it, expect } from "vitest";
import { computeStepProgress, deriveEnrollmentState } from "../sequence-progress";

// The states a person sees for an enrollment that stopped, or is waiting. They must be distinct and must never mislead:
// Replied is not Unenrolled, a customer's unsubscribe is not a staff unenroll, and "waiting for capacity" is not "Failed".
const steps = [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }, { id: "s5" }];
const NOW = Date.parse("2026-11-24T12:00:00Z");
const sent = (stepId: string) => ({ stepId, status: "SENT" as const, sentAt: new Date(NOW - 3_600_000), createdAt: new Date(NOW - 3_600_000) });

describe("Replied", () => {
  const enrollment = { status: "REPLIED" as const, currentStepIdx: 2, nextSendAt: null, stopReason: "REPLIED" };
  const logs = [sent("s1"), sent("s2")];

  it("is its own state, labelled for what happened", () => {
    const state = deriveEnrollmentState({ enrollment, steps, logs, now: NOW });
    expect(state).toMatchObject({ key: "replied", label: "Replied — Automatically stopped", progressing: false });
  });

  it("keeps what was sent as sent and shows every later step as cancelled - never as scheduled or pending", () => {
    const progress = computeStepProgress({ steps, enrollment, logs, now: NOW });
    expect(progress.map((p) => p.status)).toEqual(["sent", "sent", "cancelled", "cancelled", "cancelled"]);
  });

  it("is not shown as paused even when the sequence is switched off", () => {
    expect(deriveEnrollmentState({ enrollment, steps, logs, sequenceActive: false, now: NOW }).key).toBe("replied");
  });
});

describe("Unenrolled and Unsubscribed are different things", () => {
  const base = { status: "UNSUBSCRIBED" as const, currentStepIdx: 1, nextSendAt: null };
  it("staff unenrolling (or an older row with no reason) reads Unenrolled", () => {
    expect(deriveEnrollmentState({ enrollment: { ...base, stopReason: "UNENROLLED" }, steps, logs: [sent("s1")], now: NOW }).label).toBe("Unenrolled");
    expect(deriveEnrollmentState({ enrollment: base, steps, logs: [sent("s1")], now: NOW }).label).toBe("Unenrolled");
  });
  it("the customer's own unsubscribe link reads Unsubscribed", () => {
    expect(deriveEnrollmentState({ enrollment: { ...base, stopReason: "CUSTOMER_UNSUBSCRIBED" }, steps, logs: [sent("s1")], now: NOW })).toMatchObject({ key: "unsubscribed", label: "Unsubscribed" });
  });
  it("either way the remaining steps are cancelled", () => {
    expect(computeStepProgress({ steps, enrollment: { ...base, stopReason: "UNENROLLED" }, logs: [sent("s1")], now: NOW }).map((p) => p.status)).toEqual(["sent", "cancelled", "cancelled", "cancelled", "cancelled"]);
  });
});

describe("Waiting for sending capacity", () => {
  const due = new Date(NOW - 60_000);
  it("an ACTIVE enrollment whose time has come but whose mailbox is out of capacity says so, instead of a time that has already passed", () => {
    const state = deriveEnrollmentState({ enrollment: { status: "ACTIVE", currentStepIdx: 0, nextSendAt: due, waitReason: "CAPACITY" }, steps, logs: [], now: NOW });
    expect(state).toMatchObject({ key: "waiting", label: "Scheduled — Waiting for available Gmail sending capacity", progressing: true });
  });

  it("only while it is actually due: a future step is just scheduled", () => {
    const future = new Date(NOW + 3_600_000);
    expect(deriveEnrollmentState({ enrollment: { status: "ACTIVE", currentStepIdx: 1, nextSendAt: future, waitReason: "CAPACITY" }, steps, logs: [sent("s1")], now: NOW }).key).toBe("active");
  });

  it("a real failed attempt still reads as a retry, and a paused sequence as paused - waiting never hides either", () => {
    const failedLog = { stepId: "s1", status: "FAILED" as const, error: "Gmail could not send this email.", createdAt: new Date(NOW - 1000) };
    expect(deriveEnrollmentState({ enrollment: { status: "ACTIVE", currentStepIdx: 0, nextSendAt: due, waitReason: "CAPACITY" }, steps, logs: [failedLog], now: NOW }).key).toBe("retry_scheduled");
    expect(deriveEnrollmentState({ enrollment: { status: "ACTIVE", currentStepIdx: 0, nextSendAt: due, waitReason: "CAPACITY" }, steps, logs: [], sequenceActive: false, now: NOW }).key).toBe("paused");
  });

  it("without a wait reason a due first email is simply 'First email pending'", () => {
    expect(deriveEnrollmentState({ enrollment: { status: "ACTIVE", currentStepIdx: 0, nextSendAt: due }, steps, logs: [], now: NOW }).key).toBe("first_email_pending");
  });
});

describe("Failed", () => {
  it("stays Failed (with Retry and Unenroll available) - a reply or capacity wait never relabels it", () => {
    const failed = { status: "FAILED" as const, currentStepIdx: 2, nextSendAt: null };
    expect(deriveEnrollmentState({ enrollment: failed, steps, logs: [sent("s1"), sent("s2")], now: NOW }).key).toBe("failed");
    expect(computeStepProgress({ steps, enrollment: failed, logs: [sent("s1"), sent("s2")], now: NOW }).map((p) => p.status)).toEqual(["sent", "sent", "failed", "cancelled", "cancelled"]);
  });
});
