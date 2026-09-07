import { describe, it, expect } from "vitest";
import { assessRisk, HIGH_RISK_THRESHOLD } from "../ip-risk";

describe("assessRisk — pure, transparent, no external API", () => {
  it("returns a zero score with no signals when nothing is unusual", () => {
    const result = assessRisk({ velocityCount: 1, distinctEmailsForIp: 1, distinctIpsForEmail: 1, distinctEmailsForSubnet: 1, previouslyFlagged: false });
    expect(result.score).toBe(0);
    expect(result.signals).toHaveLength(0);
  });

  it("flags velocity — 3+ signings from the same IP within the window", () => {
    const below = assessRisk({ velocityCount: 2, distinctEmailsForIp: 1, distinctIpsForEmail: 1, distinctEmailsForSubnet: 1, previouslyFlagged: false });
    expect(below.signals).toHaveLength(0);
    const at = assessRisk({ velocityCount: 3, distinctEmailsForIp: 1, distinctIpsForEmail: 1, distinctEmailsForSubnet: 1, previouslyFlagged: false });
    expect(at.signals.map((s) => s.label)).toContain("3 signings from this IP within 1 hour");
    expect(at.score).toBeGreaterThan(0);
  });

  it("flags multiple distinct emails sharing one IP", () => {
    const result = assessRisk({ velocityCount: 1, distinctEmailsForIp: 2, distinctIpsForEmail: 1, distinctEmailsForSubnet: 1, previouslyFlagged: false });
    expect(result.signals.some((s) => s.label.includes("different signer emails from this IP"))).toBe(true);
  });

  it("flags one email using multiple distinct IPs", () => {
    const result = assessRisk({ velocityCount: 1, distinctEmailsForIp: 1, distinctIpsForEmail: 2, distinctEmailsForSubnet: 1, previouslyFlagged: false });
    expect(result.signals.some((s) => s.label.includes("different IPs used by this signer email"))).toBe(true);
  });

  it("flags subnet fan-out only at 3+ distinct emails (a looser threshold than exact-IP fan-out)", () => {
    const below = assessRisk({ velocityCount: 1, distinctEmailsForIp: 1, distinctIpsForEmail: 1, distinctEmailsForSubnet: 2, previouslyFlagged: false });
    expect(below.signals).toHaveLength(0);
    const at = assessRisk({ velocityCount: 1, distinctEmailsForIp: 1, distinctIpsForEmail: 1, distinctEmailsForSubnet: 3, previouslyFlagged: false });
    expect(at.signals.some((s) => s.label.includes("subnet"))).toBe(true);
  });

  it("a previous manual suspicious flag alone crosses the high-risk threshold", () => {
    const result = assessRisk({ velocityCount: 1, distinctEmailsForIp: 1, distinctIpsForEmail: 1, distinctEmailsForSubnet: 1, previouslyFlagged: true });
    expect(result.score).toBeGreaterThanOrEqual(HIGH_RISK_THRESHOLD);
  });

  it("stacks multiple signals additively, clamped to 100", () => {
    const result = assessRisk({ velocityCount: 5, distinctEmailsForIp: 4, distinctIpsForEmail: 3, distinctEmailsForSubnet: 5, previouslyFlagged: true });
    expect(result.signals).toHaveLength(5);
    expect(result.score).toBe(100); // sum of all weights (25+20+20+15+40=120) clamps at 100
  });

  it("never includes a time-of-day / unusual-hour signal — no business definition exists for one", () => {
    const result = assessRisk({ velocityCount: 5, distinctEmailsForIp: 5, distinctIpsForEmail: 5, distinctEmailsForSubnet: 5, previouslyFlagged: true });
    expect(result.signals.every((s) => !/hour of day|unusual time|midnight|late.?night/i.test(s.label))).toBe(true);
  });
});
