// Internal-only fraud risk signals for the IP vault. NO external
// IP-reputation, VPN-detection, or geolocation API is called anywhere in
// this module (none is integrated in this app, and none was requested to
// be added) — every signal here is derived purely from this app's own
// IpCapture rows plus a manual analyst "suspicious" flag (IpCapture.
// suspicious). The score is a plain, fully-transparent weighted sum, not
// a model and not probabilistic, specifically so a fraud investigator can
// always see exactly why a given score is what it is (assessRisk returns
// the matched signals, not just a number).
//
// Deliberately NOT included: a "signed at an unusual hour" signal. What
// counts as "unusual" depends on the business's own operating hours and
// the signer's own timezone, neither of which this app tracks — a
// hardcoded hour range (e.g. "2am-5am server time") would be an
// unfounded, arbitrary rule dressed up as a real fraud signal. If a real
// business rule for this is ever defined (e.g. "more than N standard
// deviations from this route's own typical signing-hour distribution"),
// it belongs here as a new signal — not fabricated now.

export type RiskSignal = { label: string; weight: number };

export type RiskAssessment = {
  /** 0-100, clamped — the sum of every matched signal's weight. */
  score: number;
  signals: RiskSignal[];
};

/** Rolling window used by the velocity signal below. */
export const VELOCITY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Score at or above this is surfaced as a Notification to the company's
 * Admins/Managers at capture time (see ip-capture.ts). Chosen so a single
 * strong signal (e.g. a previously-flagged IP) or two moderate ones
 * together cross it, but no single weak signal alone does. */
export const HIGH_RISK_THRESHOLD = 50;

const WEIGHTS = {
  velocity: 25,
  multiEmailSameIp: 20,
  multiIpSameEmail: 20,
  subnetFanOut: 15,
  // Equal to HIGH_RISK_THRESHOLD itself, deliberately: a human analyst
  // already confirmed fraud on this exact IP or email on an earlier
  // capture, which is a stronger signal than any of the purely
  // behavioral/statistical ones above — its reappearance alone should
  // always surface an alert, not merely nudge the score.
  previouslyFlagged: 50,
} as const;

/**
 * Pure scoring function — every count is pre-computed by the caller
 * (ip-capture.ts, which has the Prisma access this module deliberately
 * does not) so this stays trivially unit-testable without a database.
 */
export function assessRisk(params: {
  /** Captures sharing this exact IP within VELOCITY_WINDOW_MS, INCLUDING the one just captured. */
  velocityCount: number;
  /** Distinct signerEmails ever seen from this exact IP, INCLUDING this capture. */
  distinctEmailsForIp: number;
  /** Distinct IPs (by ipHash) ever used by this signerEmail, INCLUDING this capture. */
  distinctIpsForEmail: number;
  /** Distinct signerEmails ever seen from this IP's subnet, INCLUDING this capture. */
  distinctEmailsForSubnet: number;
  /** Whether this exact IP or this signerEmail was manually flagged suspicious on an earlier capture. */
  previouslyFlagged: boolean;
}): RiskAssessment {
  const signals: RiskSignal[] = [];

  if (params.velocityCount >= 3) {
    signals.push({ label: `${params.velocityCount} signings from this IP within 1 hour`, weight: WEIGHTS.velocity });
  }
  if (params.distinctEmailsForIp >= 2) {
    signals.push({ label: `${params.distinctEmailsForIp} different signer emails from this IP`, weight: WEIGHTS.multiEmailSameIp });
  }
  if (params.distinctIpsForEmail >= 2) {
    signals.push({ label: `${params.distinctIpsForEmail} different IPs used by this signer email`, weight: WEIGHTS.multiIpSameEmail });
  }
  if (params.distinctEmailsForSubnet >= 3) {
    signals.push({ label: `${params.distinctEmailsForSubnet} different signer emails from this IP's subnet`, weight: WEIGHTS.subnetFanOut });
  }
  if (params.previouslyFlagged) {
    signals.push({ label: "This IP or signer email was previously flagged suspicious", weight: WEIGHTS.previouslyFlagged });
  }

  const score = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0));
  return { score, signals };
}
