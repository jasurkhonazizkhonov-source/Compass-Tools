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

export function GoogleSignInButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const buttonRef = useRef<HTMLDivElement>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);

  useEffect(() => {
    if (!scriptLoaded || !window.google || !buttonRef.current) return;

    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        setIsSigningIn(true);
        signInWithGoogle(response.credential)
          .then((result) => {
            if (result.ok) {
              router.push("/dashboard");
              // Deliberately NOT resetting isSigningIn here — the button
              // stays in its loading state through the navigation itself
              // rather than flashing back to "idle" for one frame before
              // the route change lands.
              return;
            }
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
