import { describe, it, expect } from "vitest";
import { computeStepProgress } from "../sequence-progress";

const steps = [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }];
const T = (h: number) => new Date(Date.UTC(2026, 10, 15, h));
const statuses = (p: ReturnType<typeof computeStepProgress>) => p.map((x) => x.status);

describe("computeStepProgress", () => {
  it("an active enrollment: sent steps, then the scheduled one with its time, then pending ones", () => {
    const p = computeStepProgress({
      steps,
      enrollment: { status: "ACTIVE", currentStepIdx: 2, nextSendAt: T(9) },
      logs: [{ stepId: "s1", status: "SENT", sentAt: T(1) }, { stepId: "s2", status: "SENT", sentAt: T(2) }],
    });
    expect(statuses(p)).toEqual(["sent", "sent", "scheduled", "pending"]);
    expect(p[0].at).toEqual(T(1));
    expect(p[2].at).toEqual(T(9));
    expect(p[3].at).toBeNull();
  });

  it("an ATTEMPT is not a send: a failed attempt on the current step is 'failed (retrying)', never 'sent'", () => {
    const p = computeStepProgress({ steps, enrollment: { status: "ACTIVE", currentStepIdx: 0, nextSendAt: T(10) }, logs: [{ stepId: "s1", status: "FAILED" }] });
    expect(statuses(p)).toEqual(["failed", "pending", "pending", "pending"]);
    expect(p[0]).toMatchObject({ retrying: true, at: T(10) });
  });

  it("a failed enrollment: the step it stopped at is failed (not retrying), later steps are cancelled", () => {
    const p = computeStepProgress({
      steps,
      enrollment: { status: "FAILED", currentStepIdx: 1, nextSendAt: null },
      logs: [{ stepId: "s1", status: "SENT", sentAt: T(1) }, { stepId: "s2", status: "FAILED" }, { stepId: "s2", status: "FAILED" }, { stepId: "s2", status: "FAILED" }],
    });
    expect(statuses(p)).toEqual(["sent", "failed", "cancelled", "cancelled"]);
    expect(p[1].retrying).toBe(false);
  });

  it("an unenrolled lead: what went out stays 'sent', everything that had not is cancelled, nothing is scheduled", () => {
    const p = computeStepProgress({ steps, enrollment: { status: "UNSUBSCRIBED", currentStepIdx: 1, nextSendAt: null }, logs: [{ stepId: "s1", status: "SENT", sentAt: T(1) }] });
    expect(statuses(p)).toEqual(["sent", "cancelled", "cancelled", "cancelled"]);
  });

  it("a switched-off sequence shows the waiting step as paused, not scheduled", () => {
    const p = computeStepProgress({ steps, enrollment: { status: "ACTIVE", currentStepIdx: 1, nextSendAt: T(9) }, logs: [{ stepId: "s1", status: "SENT", sentAt: T(1) }], sequenceActive: false });
    expect(statuses(p)).toEqual(["sent", "paused", "pending", "pending"]);
  });

  it("a completed enrollment shows every step sent, even where an old log is missing (the step counter only advances after a successful send)", () => {
    const p = computeStepProgress({ steps, enrollment: { status: "COMPLETED", currentStepIdx: 4, nextSendAt: null }, logs: [{ stepId: "s1", status: "SENT", sentAt: T(1) }] });
    expect(statuses(p)).toEqual(["sent", "sent", "sent", "sent"]);
    expect(p[1].at).toBeNull();
  });

  it("a step that failed once and then succeeded is sent, using the latest send time", () => {
    const p = computeStepProgress({
      steps: [{ id: "s1" }],
      enrollment: { status: "COMPLETED", currentStepIdx: 1, nextSendAt: null },
      logs: [{ stepId: "s1", status: "FAILED", createdAt: T(1) }, { stepId: "s1", status: "SENT", sentAt: T(3) }],
    });
    expect(p[0]).toMatchObject({ status: "sent", at: T(3) });
  });

  it("no steps gives no progress rows", () => {
    expect(computeStepProgress({ steps: [], enrollment: { status: "ACTIVE", currentStepIdx: 0, nextSendAt: null }, logs: [] })).toEqual([]);
  });
});
