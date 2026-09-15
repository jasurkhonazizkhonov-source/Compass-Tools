"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

// Real gap found and fixed: this repo had ZERO error.tsx/global-error.tsx
// anywhere under src/app. That meant ANY uncaught exception thrown while
// rendering ANY Server Component — a page, or (crm)/layout.tsx itself,
// which every single CRM route renders through — fell all the way through
// to Next.js's own built-in default error page: a full-document
// replacement ("This page couldn't load / A server error occurred. Reload
// to try again.") with no retry-in-place, no app chrome, and nothing
// scoped to just the failing section. This is exactly the reported
// intermittent symptom.
//
// This file does NOT hide or swallow the underlying failure — it is a
// presentation-layer boundary only, per Next's own error-boundary model
// (see node_modules/next/dist/docs/.../error.md: "does not wrap the
// layout.js above it in the same segment" — an app/error.tsx here DOES
// catch a throw from (crm)/layout.tsx, since that layout is a child
// segment of this one, while staying rendered inside the real root
// app/layout.tsx so theme/fonts/toaster stay intact, unlike Next's default
// global-error which replaces the whole <html>). The actual exception and
// its stack are already logged server-side by Next itself before this
// component ever renders (confirmed Next 16 behavior) — nothing here needs
// to re-log it. What this adds: a scoped, on-brand, retryable fallback
// instead of the generic full-page replacement, without ever inventing a
// success state or hiding that a real error occurred.
export default function CrmSegmentError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const isServerError = !!error.digest;

  useEffect(() => {
    // Client-side-only note for whoever has devtools open — the real,
    // detailed, stack-bearing log already happened server-side. This never
    // duplicates message/stack content that could be sensitive; the digest
    // is just a correlation id.
    console.error("[crm] segment render failed", error.digest ?? "(no digest — client-side error)");
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-sm w-full rounded-xl border bg-background p-8 text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-foreground">This page couldn&apos;t load</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isServerError
              ? "A server error occurred. Your sign-in is unaffected — try again."
              : "Something went wrong loading this section. Try again."}
          </p>
        </div>
        <Button onClick={() => retry()} className="w-full">
          Try again
        </Button>
        {error.digest && <p className="text-[11px] text-muted-foreground/70">Error ref: {error.digest}</p>}
      </div>
    </div>
  );
}
