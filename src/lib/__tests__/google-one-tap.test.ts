import { describe, it, expect } from "vitest";
import { ONE_TAP_COOLDOWN_MS, ONE_TAP_DISMISSED_KEY, PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL, classifyMoment, clearDismissal, mayPromptOneTap, readDismissedAt, recordDismissal, safeStorage } from "../google-one-tap";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

describe("when the suggestion may be requested", () => {
  const NOW = 1_800_000_000_000;
  it("a first-time visitor: yes", () => expect(mayPromptOneTap({ dismissedAt: null, now: NOW })).toBe(true));
  it("not within the cooldown after the person closed it; yes once it has passed (a returning visitor)", () => {
    expect(mayPromptOneTap({ dismissedAt: NOW - 1000, now: NOW })).toBe(false);
    expect(mayPromptOneTap({ dismissedAt: NOW - ONE_TAP_COOLDOWN_MS + 1, now: NOW })).toBe(false);
    expect(mayPromptOneTap({ dismissedAt: NOW - ONE_TAP_COOLDOWN_MS, now: NOW })).toBe(true);
  });
  it("a dismissal time in the future (clock moved back) can only make it quieter", () => expect(mayPromptOneTap({ dismissedAt: NOW + 3_600_000, now: NOW })).toBe(false));
  it("never while a sign-in is running or in a background tab", () => {
    expect(mayPromptOneTap({ dismissedAt: null, now: NOW, signingIn: true })).toBe(false);
    expect(mayPromptOneTap({ dismissedAt: null, now: NOW, hidden: true })).toBe(false);
  });
});

describe("dismissal memory", () => {
  it("round-trips, ignores garbage, and can be cleared", () => {
    const s = memory();
    expect(readDismissedAt(s)).toBeNull();
    recordDismissal(s, 12345);
    expect(readDismissedAt(s)).toBe(12345);
    s.setItem(ONE_TAP_DISMISSED_KEY, "not a number");
    expect(readDismissedAt(s)).toBeNull();
    s.setItem(ONE_TAP_DISMISSED_KEY, "-5");
    expect(readDismissedAt(s)).toBeNull();
    clearDismissal(s);
    expect(s.m.size).toBe(0);
  });

  it("no storage, or storage that throws, is not an error", () => {
    expect(() => recordDismissal(null)).not.toThrow();
    expect(readDismissedAt(null)).toBeNull();
    const throwing = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
    expect(() => recordDismissal(throwing)).not.toThrow();
    expect(readDismissedAt(throwing)).toBeNull();
    expect(() => clearDismissal(throwing)).not.toThrow();
    expect(safeStorage({ localStorage: throwing as unknown as Storage })).toBeNull();
    expect(safeStorage(undefined)).toBeNull();
    expect(safeStorage({})).toBeNull();
  });
});

describe("Google's moments", () => {
  it("dismissed / not shown / other, and a moment API that is missing or throws is 'other'", () => {
    expect(classifyMoment({ isDismissedMoment: () => true })).toBe("dismissed");
    expect(classifyMoment({ isNotDisplayed: () => true })).toBe("not-shown");
    expect(classifyMoment({ isSkippedMoment: () => true })).toBe("not-shown");
    expect(classifyMoment({})).toBe("other");
    expect(classifyMoment(null)).toBe("other");
    expect(classifyMoment({ isDismissedMoment: () => { throw new Error("FedCM"); } })).toBe("other");
  });
});

describe("the legal documents", () => {
  it("are the real published pages of the organisation (never an invented path; /terms-of-use does not exist)", () => {
    expect(PRIVACY_POLICY_URL).toBe("https://www.businessflights.travel/privacy-policy");
    expect(TERMS_OF_SERVICE_URL).toBe("https://www.businessflights.travel/terms-of-service");
    expect(TERMS_OF_SERVICE_URL).not.toContain("terms-of-use");
  });
});
