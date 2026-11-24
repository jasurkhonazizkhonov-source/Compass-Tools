// Rules for Google's official account suggestion (One Tap) on the sign-in page. Pure and dependency-free so each rule is tested on its own; the component
// (components/layout/google-sign-in-button.tsx) only wires them to Google's SDK.
//
// What Google decides, and what we decide:
//   * GOOGLE decides whether a suggestion can be shown at all (is a Google account signed in in this browser, FedCM / third-party-cookie / privacy settings, its own cooldown after
//     the person closes it several times) and draws it. We never draw anything that looks like it.
//   * WE decide only whether to ASK Google to show it on this visit: not when the person closed it recently, not while a sign-in is already running, and never to sign anyone in
//     automatically (auto_select is off: nothing happens until the person clicks "Continue as ...").

/** After the person closes the suggestion we do not ask Google to show it again for this long. (Google also applies its own, longer, cooldown after repeated dismissals.) */
export const ONE_TAP_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const ONE_TAP_DISMISSED_KEY = "compass:google-one-tap-dismissed-at";

/** The real, published documents of the organisation that runs this CRM (checked on 2026-11-24: both answer 200; /terms-of-use does NOT exist, /terms redirects to /terms-of-service). */
export const PRIVACY_POLICY_URL = "https://www.businessflights.travel/privacy-policy";
export const TERMS_OF_SERVICE_URL = "https://www.businessflights.travel/terms-of-service";

export type OneTapStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The browser's local storage, or null where it is unavailable or throws (private windows, blocked site data): the suggestion then simply has no memory. */
export function safeStorage(win: { localStorage?: Storage } | undefined): OneTapStorage | null {
  try {
    const s = win?.localStorage;
    if (!s) return null;
    s.getItem(ONE_TAP_DISMISSED_KEY); // throws when storage is blocked
    return s;
  } catch {
    return null;
  }
}

export function readDismissedAt(storage: OneTapStorage | null): number | null {
  try {
    const raw = storage?.getItem(ONE_TAP_DISMISSED_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function recordDismissal(storage: OneTapStorage | null, now = Date.now()): void {
  try {
    storage?.setItem(ONE_TAP_DISMISSED_KEY, String(now));
  } catch {
    // no storage: the suggestion just has no memory
  }
}

export function clearDismissal(storage: OneTapStorage | null): void {
  try {
    storage?.removeItem(ONE_TAP_DISMISSED_KEY);
  } catch {
    // ignore
  }
}

/** True when we may ask Google to show the suggestion now. A dismissal time in the future (a clock that moved back) counts as "recent", so it can only ever make us quieter. */
export function mayPromptOneTap(params: { dismissedAt: number | null; now?: number; signingIn?: boolean; hidden?: boolean }): boolean {
  const now = params.now ?? Date.now();
  if (params.signingIn) return false;
  if (params.hidden) return false; // a background tab: Google would not show it, and it must not be queued behind the person's back
  if (params.dismissedAt !== null && now - params.dismissedAt < ONE_TAP_COOLDOWN_MS) return false;
  return true;
}

/**
 * What Google reports about a prompt ("moment"). Under FedCM most detail is intentionally not available, so only three outcomes matter: the person closed it (remember that),
 * Google did not show it, or it was skipped (both: stay silent, the button below is the way in).
 */
export type OneTapMoment = {
  isDismissedMoment?: () => boolean;
  isNotDisplayed?: () => boolean;
  isSkippedMoment?: () => boolean;
};

export type OneTapOutcome = "dismissed" | "not-shown" | "other";

export function classifyMoment(moment: OneTapMoment | null | undefined): OneTapOutcome {
  try {
    if (moment?.isDismissedMoment?.()) return "dismissed";
    if (moment?.isNotDisplayed?.() || moment?.isSkippedMoment?.()) return "not-shown";
  } catch {
    // a moment method Google no longer supports (FedCM) throws or is missing: treat as "nothing to report"
  }
  return "other";
}
