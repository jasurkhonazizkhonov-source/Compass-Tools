import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CheckCircle2, Clock } from "lucide-react";
import { getCvvRecollectionRequestSummary } from "@/server/actions/cvv-recollection";
import { CvvRecollectionForm } from "@/components/customer/cvv-recollection-form";
import { CloseBookingButton } from "@/components/customer/close-booking-button";

export const dynamic = "force-dynamic";

/**
 * Overrides the root layout's PRODUCT_NAME ("Compass Tools") browser-tab
 * title with the actual travel company's own name — this page has no
 * layout.tsx of its own (see the page doc comment below), so without this
 * it would otherwise inherit the internal CRM product name straight from
 * src/app/layout.tsx, exactly the "no internal branding on a customer
 * surface" rule already applied to /quote (see quote/[token]/page.tsx).
 * A failed/unknown token falls back to {} (Next's own default), same as
 * the quote page's equivalent fallback.
 */
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  try {
    const { token } = await params;
    const summary = await getCvvRecollectionRequestSummary(token);
    if (!summary) return {};
    return { title: `Confirm Your Card | ${summary.companyName}` };
  } catch {
    return {};
  }
}

/**
 * A minimal, standalone public page — deliberately NOT sharing /quote's
 * layout/theme provider (it has nothing to do with a quote, and the less
 * this page does beyond "collect one CVV safely," the smaller the surface
 * for something to go wrong on the one page in this app whose whole job
 * is handling live card data). A genuinely unknown/malformed token gets
 * the same plain 404 as any other broken link — never a hint that a
 * request for it ever existed.
 *
 * A token that DOES correspond to a real request instead shows the state
 * that actually applies: the form (AVAILABLE), a professional "Already
 * Confirmed" notice (USED — reopening the same link after a customer
 * already successfully confirmed, rather than the previous behavior of
 * 404ing it identically to a broken link), or an "expired" notice
 * (EXPIRED — past its TTL or locked out after too many wrong attempts,
 * both meaning "ask your agent for a new link"). See
 * getCvvRecollectionRequestSummary's own doc comment for the full
 * reasoning; submitRecollectedCvv independently re-validates the exact
 * same conditions server-side regardless of what this page shows.
 */
export default async function CvvRecollectionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const summary = await getCvvRecollectionRequestSummary(token);
  if (!summary) notFound();

  if (summary.status === "USED") {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm space-y-4">
          <p className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wide">{summary.companyName}</p>
          <div className="rounded-xl border bg-background p-8 text-center space-y-3">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <h1 className="text-lg font-semibold text-foreground">Already Confirmed</h1>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              This card&apos;s security code (•••• {summary.last4}) has already been confirmed. Your agent will finish processing your payment shortly — no further action is needed from you.
            </p>
            <div className="pt-1 flex justify-center">
              <CloseBookingButton />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (summary.status === "EXPIRED") {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm space-y-4">
          <p className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wide">{summary.companyName}</p>
          <div className="rounded-xl border bg-background p-8 text-center space-y-3">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Clock className="h-7 w-7" />
            </div>
            <h1 className="text-lg font-semibold text-foreground">This Link Has Expired</h1>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              This confirmation link is no longer valid. Please contact your agent and ask them to send a new one.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/30 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-4">
        <p className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wide">{summary.companyName}</p>
        <CvvRecollectionForm token={token} cardBrand={summary.cardBrand} last4={summary.last4} />
      </div>
    </div>
  );
}
