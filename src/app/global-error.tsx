"use client";

import { useEffect } from "react";

// Real gap found during the CRM health audit: app/error.tsx (the CRM
// segment-level boundary) cannot catch a throw from the ROOT app/layout.tsx
// itself — per Next's error-boundary model, a segment's error.tsx only
// covers its own child segments, never the layout it's nested inside. Today
// the root layout is static (no DB calls; resolveBaseUrl() never throws,
// only warns and falls back) so this has no live trigger yet, but without
// this file any future throw added there — a new provider, a metadata call
// that can fail — would fall through to Next's bare built-in error page:
// no app chrome, no retry-in-place, not even this app's fonts/theme.
//
// This file replaces the ENTIRE <html>, including fonts and the theme
// bootstrap script (Next's own constraint — global-error renders in place of
// the root layout, not inside it), so it intentionally stays minimal and
// self-contained rather than importing app providers that might themselves
// be the thing that failed. It does not hide or re-interpret the failure —
// Next already logs the real error server-side before this ever renders.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[root] application render failed", error.digest ?? "(no digest — client-side error)");
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily: "system-ui, -apple-system, sans-serif",
          background: "#0a0a0a",
          color: "#fafafa",
        }}
      >
        <div style={{ maxWidth: 380, width: "100%", textAlign: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: "#a3a3a3", margin: "0 0 20px" }}>
            A server error occurred. Please try again.
          </p>
          <button
            onClick={() => reset()}
            style={{
              width: "100%",
              padding: "10px 16px",
              borderRadius: 8,
              border: "none",
              background: "#fafafa",
              color: "#0a0a0a",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p style={{ fontSize: 11, color: "#737373", marginTop: 16 }}>Error ref: {error.digest}</p>
          )}
        </div>
      </body>
    </html>
  );
}
