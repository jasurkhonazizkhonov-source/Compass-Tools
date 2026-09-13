"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Script from "next/script";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { signInWithGoogle } from "@/server/actions/google-auth";

// Google Identity Services' own official button — loaded via its script
// and rendered through google.accounts.id.renderButton(), never a
// hand-built lookalike. No npm wrapper needed: this is the entirety of
// what Google's own vanilla integration requires.
type GoogleCredentialResponse = { credential: string };
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (response: GoogleCredentialResponse) => void }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

// Pass 37 — real bug found and fixed: signInWithGoogle() used to call
// next/navigation's redirect() internally and this callback simply awaited
// it via `.then(onFulfilled)` with no rejection handler — but redirect()
// throws to unwind, and this callback runs from Google's own external SDK
// (a plain function reference, not a React event handler or transition),
// where that throw surfaces as a rejected promise `.then()` never sees.
// The result was the exact reported bug: "Signing in…" that never
// resolves, on success or denial alike, with no way to retry without a
// full page reload. Fixed at the source (signInWithGoogle no longer
// redirects internally, see google-auth.ts) — this callback now always
// receives a real, resolved result and is the one place that performs the
// actual navigation, guaranteeing a stuck state can never happen: every
// branch below both resets isSigningIn AND either navigates or shows a
// clear, retryable error.
const ACCESS_DENIED_MESSAGES: Record<string, string> = {
  NOT_INITIALIZED: "This Compass Tools deployment has not been initialized yet. Ask your administrator to complete setup.",
  BOOTSTRAP_EMAIL_MISMATCH: "This Google account is not authorized for the initial CRM administrator.",
  ACCESS_DENIED: "Your Google account is not authorized to access Compass Tools CRM. Please contact your CRM administrator.",
};

// Pass 38 — secondary UX safeguard only, per this pass's own explicit
// carve-out: the primary fix (Pass 37) is that signInWithGoogle() always
// settles with a real value and every branch below already resets
// isSigningIn or navigates. This timeout does not hide or replace that —
// it exists purely for the one residual, extremely unlikely case a
// resolved `{ ok: true }` is followed by router.push("/dashboard") somehow
// not completing a navigation (e.g. an intervening client-side error).
// Long enough it can never fire during any normal sign-in (including a
// slow network), and it only ever acts if the component is STILL mounted
// and STILL showing "Signing in…" — a real navigation unmounts this
// component well before it could fire.
const STUCK_SIGN_IN_SAFETY_NET_MS = 15_000;

export function GoogleSignInButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const buttonRef = useRef<HTMLDivElement>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const safetyNetRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Pass 40 — investigated and ruled out, kept as defense-in-depth: the
  // effect below has no cleanup function, and React Strict Mode (the
  // Next.js default since 13.4, not overridden in this project's
  // next.config.ts, active in every `next dev` session) DOES double-invoke
  // a component's effects once on its initial mount. This looked like a
  // promising explanation for the reported "worked before, now unreliable,
  // including on localhost" symptom — but direct testing (a diagnostic
  // effect reproducing this exact deferred-init shape) proved Strict
  // Mode's double-invoke window closes at the initial synchronous mount,
  // and this effect's real work only ever runs LATER, once `scriptLoaded`
  // flips true after the external GIS script finishes loading (an
  // inherently async event, both in the real browser and via next/script's
  // onReady) — a genuine dependency-triggered re-render, not part of the
  // double-invoked mount window. In practice initialize()/renderButton()
  // were therefore only ever called once, even under Strict Mode; this was
  // NOT the cause of the reported bug. The guard below is kept anyway as
  // cheap, harmless insurance against any future change that could cause
  // this effect to genuinely re-run (e.g. if `router`'s reference identity
  // were ever not stable, or `clientId` changed at runtime) — it does not
  // change today's behavior, since a real re-run of this effect does not
  // currently happen at all.
  const initializedRef = useRef(false);

  function clearSafetyNet() {
    if (safetyNetRef.current) {
      clearTimeout(safetyNetRef.current);
      safetyNetRef.current = undefined;
    }
  }

  // Cleared on unmount so a real, successful navigation (which unmounts
  // this component) can never leave a stray timer behind.
  useEffect(() => clearSafetyNet, []);

  useEffect(() => {
    if (!scriptLoaded || !window.google || !buttonRef.current) return;
    // See initializedRef's own comment above — defensive only, not
    // currently reachable in practice.
    if (initializedRef.current) return;
    initializedRef.current = true;

    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        setIsSigningIn(true);
        clearSafetyNet();
        safetyNetRef.current = setTimeout(() => {
          toast.error("Sign-in is taking longer than expected. Please try again.");
          setIsSigningIn(false);
        }, STUCK_SIGN_IN_SAFETY_NET_MS);
        signInWithGoogle(response.credential)
          .then((result) => {
            if (result.ok) {
              router.push("/dashboard");
              // Deliberately NOT resetting isSigningIn here — the button
              // stays in its loading state through the navigation itself
              // rather than flashing back to "idle" for one frame before
              // the route change lands. The safety-net timer above (not
              // cleared here) is the backstop if that navigation somehow
              // never actually lands.
              return;
            }
            clearSafetyNet();
            if (result.reason === "GOOGLE_VERIFICATION_FAILED") {
              toast.error("Google sign-in could not be completed. Please try again.");
            } else {
              router.push(`/access-denied?reason=${result.reason}`);
              return;
            }
            setIsSigningIn(false);
          })
          .catch(() => {
            // A genuine network/server error reaching the action itself
            // (not a normal denial outcome, which is always a resolved
            // value above) — must still return the button to a usable
            // state rather than leaving it stuck.
            clearSafetyNet();
            toast.error("Sign-in failed. Please try again.");
            setIsSigningIn(false);
          });
      },
    });

    window.google.accounts.id.renderButton(buttonRef.current, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "pill",
      width: 280,
    });
  }, [scriptLoaded, clientId, router]);

  return (
    <div className="flex flex-col items-center gap-3">
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onReady={() => setScriptLoaded(true)} />
      <div ref={buttonRef} />
      {isSigningIn && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Signing in…
        </div>
      )}
    </div>
  );
}

// Exported for /access-denied to render a message consistent with this
// button's own reason taxonomy without duplicating the copy.
export { ACCESS_DENIED_MESSAGES };
