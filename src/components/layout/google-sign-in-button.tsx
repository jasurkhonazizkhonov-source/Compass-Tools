"use client";

import { useEffect, useRef, useState } from "react";
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

export function GoogleSignInButton({ clientId }: { clientId: string }) {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);

  useEffect(() => {
    if (!scriptLoaded || !window.google || !buttonRef.current) return;

    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        setIsSigningIn(true);
        // signInWithGoogle() redirects itself (to /dashboard on success or
        // /access-denied when the CRM denies access) — Next.js performs
        // that navigation as part of resolving this call, so the only
        // outcome this callback ever actually observes is the
        // no-redirect case: verification failed and the user stays here.
        signInWithGoogle(response.credential).then((result) => {
          if (!result.ok) {
            toast.error("Google sign-in could not be completed. Please try again.");
            setIsSigningIn(false);
          }
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
  }, [scriptLoaded, clientId]);

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
