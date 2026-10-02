// The attention sound for a FRESH website lead that has just been offered to
// this user (the Accept / Skip dialog) — and only that. Reassignments, contact
// reassignments, e-mails and quote notifications never call into this file.
//
// Why the old chime "sometimes did nothing", and what this does instead
// -------------------------------------------------------------------
// 1. It built a brand-new AudioContext at the moment the offer arrived — i.e.
//    from a background poll, not a user gesture. Browsers (Chrome, Safari,
//    Firefox) create such a context SUSPENDED when the page has not been
//    interacted with, so the oscillators ran silently. Now ONE AudioContext is
//    created/resumed on the user's first click, key press or touch anywhere in
//    the CRM and then kept (and resumed again whenever the tab becomes visible),
//    so by the time an offer arrives the context is normally already running.
// 2. The chime was ~0.3 s and easy to miss. It is now a soft two-round bell
//    phrase of about 2.7 s at a moderate level.
// 3. It was de-duplicated by lead id alone, so the SAME lead offered to the
//    SAME user again (after others skipped it) never sounded again, while
//    every open CRM tab sounded for the same offer. An offer is now identified
//    by lead id + its own expiry (every real re-offer has a new expiry), and
//    one tab per browser sounds it (Web Locks; a localStorage claim where Web
//    Locks is unavailable). A tab that cannot make sound (still suspended) does
//    not take the claim, so a tab that can will.
//
// What cannot be promised: a browser will not let a page make sound before the
// user has interacted with it at all. If the CRM has been open and untouched
// since the page loaded, the context stays suspended; the alert then falls back
// to the visible cues (the dialog and the tab title), and plays the sound the
// moment the user's first interaction arrives IF the offer is still live. This
// never tries to bypass autoplay rules — it only resumes the context from a real
// gesture, which is what the rules allow.

export const OFFER_ALERT_SECONDS = 2.7;
/** How long a tab holds the claim for one offer — longer than any offer window. */
const CLAIM_HOLD_MS = 90_000;

type AudioCtxCtor = typeof AudioContext;
type LocksApi = { request: (name: string, options: { ifAvailable?: boolean }, cb: (lock: unknown | null) => Promise<void>) => Promise<unknown> };

let ctx: AudioContext | null = null;
let listenersAttached = false;
const alertedKeys = new Set<string>();
let pendingBlocked: { accountId: string; key: string; expiresAt: number } | null = null;

function audioCtor(): AudioCtxCtor | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext || (window as unknown as { webkitAudioContext?: AudioCtxCtor }).webkitAudioContext;
}

function getContext(): AudioContext | null {
  if (ctx && ctx.state !== "closed") return ctx;
  const Ctor = audioCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Resumes the shared context (a no-op if it is already running) and reports whether it can make sound now. */
async function ensureRunning(): Promise<boolean> {
  const c = getContext();
  if (!c) return false;
  if (c.state !== "running") {
    try {
      await c.resume();
    } catch {
      // Not allowed yet (no user gesture) — reported as "not running" below.
    }
  }
  return c.state === "running";
}

/**
 * Schedules the bell phrase on the (running) shared context: two rounds of a
 * rising three-note chime, each note a soft fundamental plus a quieter octave
 * with an exponential decay. Peak level 0.2 of full scale — clearly audible,
 * not startling, and fine to hear many times a day.
 */
export function scheduleOfferAlert(c: AudioContext): number {
  const NOTES = [659.25, 783.99, 1046.5]; // E5, G5, C6
  const ROUND_STARTS = [0, 1.3];
  const NOTE_GAP = 0.3;
  const RING = 0.8;
  const t0 = c.currentTime + 0.05;
  let lastStop = t0;
  for (const roundStart of ROUND_STARTS) {
    NOTES.forEach((freq, i) => {
      const start = t0 + roundStart + i * NOTE_GAP;
      const stop = start + RING;
      lastStop = Math.max(lastStop, stop);
      for (const [mult, level] of [
        [1, 0.2],
        [2, 0.05],
      ] as const) {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = "sine";
        osc.frequency.value = freq * mult;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(level, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, stop);
        osc.connect(gain).connect(c.destination);
        osc.start(start);
        osc.stop(stop);
      }
    });
  }
  return lastStop - t0;
}

async function claim(accountId: string, key: string): Promise<boolean> {
  const name = `compass-lead-offer-alert:${accountId}:${key}`;
  const locks = typeof navigator !== "undefined" ? (navigator as unknown as { locks?: LocksApi }).locks : undefined;
  if (locks) {
    return new Promise<boolean>((resolve) => {
      locks
        .request(name, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            resolve(false); // another tab of this browser already sounded this offer
            return;
          }
          resolve(true);
          await new Promise((r) => setTimeout(r, CLAIM_HOLD_MS)); // hold so late-arriving tabs see it taken
        })
        .catch(() => resolve(true)); // Web Locks misbehaving must never silence the alert
    });
  }
  try {
    const storageKey = `compass-lead-offer-alert:${accountId}`;
    if (localStorage.getItem(storageKey) === key) return false;
    localStorage.setItem(storageKey, key);
  } catch {
    // Storage unavailable — fall through and sound it (a duplicate beats silence).
  }
  return true;
}

function alreadyAlertedThisSession(accountId: string, key: string): boolean {
  try {
    return sessionStorage.getItem(`compass-lead-offer-alerted:${accountId}`) === key;
  } catch {
    return false;
  }
}
function rememberAlertedThisSession(accountId: string, key: string) {
  try {
    sessionStorage.setItem(`compass-lead-offer-alerted:${accountId}`, key);
  } catch {
    // ignore
  }
}

export type OfferAlertResult = "played" | "blocked" | "duplicate" | "unsupported";

/**
 * Called once the moment a lead offer is seen. Idempotent per offer: polling,
 * re-renders, remounts, a page reload, a tab switch and other open CRM tabs
 * all resolve to ONE sound. `key` must identify the offer instance
 * (`${leadId}:${offerExpiresAt}`); `expiresAt` (ms epoch) bounds the deferred
 * play-on-first-interaction fallback.
 */
export async function announceLeadOffer(params: { accountId: string; key: string; expiresAt: number }): Promise<OfferAlertResult> {
  const { accountId, key, expiresAt } = params;
  if (!audioCtor()) return "unsupported";
  if (alertedKeys.has(key) || alreadyAlertedThisSession(accountId, key)) return "duplicate";
  alertedKeys.add(key);

  if (!(await ensureRunning())) {
    // No user gesture yet: do not claim (a tab that CAN sound should), remember
    // the offer so the first interaction can still play it while it is live.
    pendingBlocked = { accountId, key, expiresAt };
    return "blocked";
  }
  return playClaimed(accountId, key);
}

async function playClaimed(accountId: string, key: string): Promise<OfferAlertResult> {
  if (!(await claim(accountId, key))) return "duplicate";
  const c = getContext();
  if (!c) return "unsupported";
  try {
    scheduleOfferAlert(c);
    rememberAlertedThisSession(accountId, key);
    return "played";
  } catch {
    return "blocked";
  }
}

/**
 * Attach once (idempotent): the first real user gesture creates/resumes the
 * shared AudioContext, and a later tab-visible event resumes it again (browsers
 * may suspend a context in a backgrounded tab). If an offer was waiting because
 * sound was blocked and it is still live, it sounds now.
 */
export function initOfferAudio(): () => void {
  if (typeof window === "undefined" || listenersAttached) return () => {};
  listenersAttached = true;

  const onGesture = async () => {
    if (!(await ensureRunning())) return;
    const pending = pendingBlocked;
    if (pending && Date.now() < pending.expiresAt) {
      pendingBlocked = null;
      await playClaimed(pending.accountId, pending.key);
    } else {
      pendingBlocked = null;
    }
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") void ensureRunning();
  };
  const events: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchend"];
  events.forEach((e) => window.addEventListener(e, onGesture, { passive: true }));
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    events.forEach((e) => window.removeEventListener(e, onGesture));
    document.removeEventListener("visibilitychange", onVisible);
    listenersAttached = false;
  };
}

/** Test seam: forget every module-level singleton. */
export function __resetOfferAlertForTests() {
  ctx = null;
  listenersAttached = false;
  alertedKeys.clear();
  pendingBlocked = null;
}
