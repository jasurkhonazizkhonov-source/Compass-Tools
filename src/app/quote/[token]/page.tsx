import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getQuoteByToken } from "@/server/queries/quotes";
import { trackViewDealClicked } from "@/server/actions/booking";
import { getCompanyForContactId } from "@/server/queries/company";
import { FlightItineraryDisplay } from "@/components/quotes/flight-itinerary-display";
import { CustomerHeader } from "@/components/customer/customer-header";
import { CloseBookingButton } from "@/components/customer/close-booking-button";
import { Button } from "@/components/ui/button";
import { CancellationConfirmPanel } from "@/components/quotes/cancellation-confirm-panel";
import { resolvePricingSnapshot, formatMoney } from "@/lib/currency";

export const dynamic = "force-dynamic";

// Pass 13 §38/§39 — overrides the layout's brand-agnostic fallback title
// with the actual travel company's own name (never the internal CRM
// product name) once it's resolvable from the token. A failed/unknown
// token falls back to the same neutral title the layout already provides
// (notFound() renders normally; metadata resolution failing here must
// never itself break the page).
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  try {
    const { token } = await params;
    const quote = await getQuoteByToken(token);
    if (!quote) return {};
    const company = await getCompanyForContactId(quote.contactId);
    return { title: `Your Flight Quote | ${company.name}` };
  } catch {
    return {};
  }
}

export default async function PublicQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const quote = await getQuoteByToken(token);
  if (!quote) notFound();

  // Already signed — send straight to the existing confirmation page
  // rather than showing the itinerary/View Deal button again. Determined
  // server-side from the quote's own booking relation (never frontend
  // state), and scoped to this specific quote's own booking only — a
  // different, still-unsigned quote/flight option is entirely unaffected.
  //
  // Exception: a cancellation in progress. A charged quote's own token
  // ALWAYS already has a booking (cancellation is only requestable on a
  // CHARGED quote, which by definition already went through BOOKED), so
  // without this exception the redirect above would fire unconditionally
  // the moment a cancellation is even approved — making the "scheduled to
  // be cancelled, please confirm" view below permanently unreachable. Only
  // these three specific mid-cancellation statuses take this path; once
  // truly CANCELLATION_CONFIRMED (or any other status), the normal
  // redirect resumes.
  const cancellationInProgress = quote.status === "CANCELLATION_APPROVED" || quote.status === "CANCELLATION_FORM_SENT" || quote.status === "CANCELLATION_SUBMITTED";
  if (quote.booking && !cancellationInProgress) redirect(`/quote/${token}/confirmation`);

  // Pass 26 §2 — a superseded exchange proposal's own token stays
  // permanently resolvable (never deleted, for audit) but must never again
  // present itself as a live, actionable deal — see isQuoteBookable's own
  // doc comment for the matching server-side authorization boundary this
  // mirrors. Checked before trackViewDealClicked below so a stale link
  // being opened doesn't masquerade as a genuine "customer viewed the
  // current deal" engagement event.
  const isSuperseded = quote.status === "EXCHANGE_SUPERSEDED";

  // Landing on this page is "the customer viewed the deal" — whether they
  // clicked the email's View Deal link or opened it directly — regardless
  // of whether the open-tracking pixel fired first. READ (email opened) is
  // tracked separately by the pixel in the SENT email, not here.
  if (quote.status !== "CANCELED" && !isSuperseded) {
    await trackViewDealClicked(token);
  }

  const segments = quote.itinerary?.segments ?? [];
  const originalSegments = quote.originalQuote?.itinerary?.segments ?? [];
  const isExchange = !!quote.originalQuoteId;
  const cancelledSegmentIds = new Set(quote.cancellationRequests.flatMap((r) => r.segmentIds));
  // Part 11 — never claim "already cancelled" until the true final state
  // (a Ticketing-area action has actually confirmed it). Every status this
  // page reaches with cancelledSegmentIds non-empty other than
  // CANCELLATION_CONFIRMED is still pending/scheduled.
  const cancellationDisplayState: "scheduled" | "cancelled" = quote.status === "CANCELLATION_CONFIRMED" ? "cancelled" : "scheduled";
  const cancellationAwaitingCustomer = quote.status === "CANCELLATION_APPROVED" || quote.status === "CANCELLATION_FORM_SENT";
  const cancellationAlreadySubmitted = quote.status === "CANCELLATION_SUBMITTED";
  const company = await getCompanyForContactId(quote.contactId);
  const displayPricing = resolvePricingSnapshot(quote.pricingSnapshot, {
    adultPrice: Number(quote.adultPrice),
    childPrice: Number(quote.childPrice),
    infantPrice: Number(quote.infantPrice),
    taxes: Number(quote.taxes),
    serviceFee: Number(quote.serviceFee),
    gratuity: 0,
    total: Number(quote.total),
  });
  // Exchange Fee + Fare Difference = Total Exchange Cost — the amount the
  // customer is actually being asked to pay for this exchange, distinct
  // from the proposed itinerary's own standalone total above. Only shown
  // once an agent has actually entered both figures; falls back to the
  // generic total panel below otherwise (an agent may not know the fare
  // difference yet when first proposing an exchange).
  const exchangeFee = quote.exchangeFee != null ? Number(quote.exchangeFee) : null;
  const fareDifference = quote.fareDifference != null ? Number(quote.fareDifference) : null;
  const hasExchangeBreakdown = isExchange && exchangeFee != null && fareDifference != null;
  const cancellationFee = quote.cancellationRequests.find((r) => r.cancellationFee != null)?.cancellationFee;

  return (
    <div className="min-h-screen bg-muted/30">
      <CustomerHeader
        subtitle="Your trusted travel partner"
        maxWidth="max-w-3xl"
        logoUrl={company.logoWebUrl}
        companyName={company.name}
        // Customer has nothing further to do once their cancellation
        // confirmation has been submitted — same Done control as the
        // booking confirmation page (CloseBookingButton), so this is the
        // only state on this page where a customer is actually finished.
        action={cancellationAlreadySubmitted ? <CloseBookingButton compact /> : undefined}
      />

      <main className="max-w-3xl mx-auto px-4 py-10 space-y-6">
        {quote.status === "CANCELED" ? (
          <div className="rounded-xl border bg-background p-8 text-center space-y-2">
            <p className="text-lg font-semibold text-foreground">This quote is no longer available</p>
            <p className="text-sm text-muted-foreground">Please contact your travel agent for an updated quote.</p>
          </div>
        ) : isSuperseded ? (
          // Pass 26 §2 — the customer-safe state for an old exchange
          // proposal link once a revised one has replaced it. Deliberately
          // distinct copy from CANCELED above — nothing was cancelled, a
          // newer proposal simply exists now.
          <div className="rounded-xl border bg-background p-8 text-center space-y-2">
            <p className="text-lg font-semibold text-foreground">This exchange proposal has been replaced</p>
            <p className="text-sm text-muted-foreground">Your travel agent has sent a newer proposal. Please check your email for the most recent one, or contact your travel agent.</p>
          </div>
        ) : (
          <>
            <div className="rounded-xl border bg-background p-6 sm:p-8 space-y-1.5">
              <p className="text-sm text-muted-foreground">Hi {quote.contact.firstName},</p>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {isExchange ? "Proposed Itinerary Exchange" : "Your flight quote is ready"}
              </h1>
              <p className="text-sm text-muted-foreground">
                Prepared for <span className="font-medium text-foreground">{quote.contact.firstName} {quote.contact.lastName}</span> · {quote.adults + quote.children + quote.infants} passenger{quote.adults + quote.children + quote.infants === 1 ? "" : "s"}
              </p>
              {isExchange && (
                <p className="text-sm text-warning-foreground bg-warning/15 border border-warning/30 rounded-md px-3 py-2 mt-2">
                  This is <strong>not a new booking</strong> — it&apos;s a proposed exchange for your existing itinerary. Please review your original itinerary alongside the proposed replacement below.
                </p>
              )}
              {cancellationAwaitingCustomer && (
                <p className="text-sm text-warning-foreground bg-warning/15 border border-warning/30 rounded-md px-3 py-2 mt-2">
                  You&apos;ve requested to cancel the flight segment(s) highlighted below. <strong>They have not been cancelled yet</strong> — please review and confirm below.
                </p>
              )}
              {cancellationAlreadySubmitted && (
                <p className="text-sm text-info bg-info/15 border border-info/30 rounded-md px-3 py-2 mt-2">
                  Thanks — we&apos;ve received your confirmation. Your travel agent is processing the cancellation and will send you a final confirmation once it&apos;s complete.
                </p>
              )}
            </div>

            {isExchange && originalSegments.length > 0 && (
              <div className="rounded-xl border bg-background p-6 sm:p-8 space-y-4">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Your Original Itinerary</h2>
                <FlightItineraryDisplay segments={originalSegments} customerFacing />
              </div>
            )}

            <div className="rounded-xl border bg-background p-6 sm:p-8 space-y-4">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                {isExchange ? "Proposed Exchange Itinerary" : "Flight Itinerary"}
              </h2>
              <FlightItineraryDisplay segments={segments} customerFacing cancelledSegmentIds={cancelledSegmentIds} cancellationState={cancellationDisplayState} />
            </div>

            {/* Exchange Fee + Fare Difference = Total Exchange Cost, shown as
                its own clearly-labeled breakdown ABOVE the price panel below
                — additive, not a replacement, so this stays consistent with
                what the booking form itself charges (see BookingFlow's own
                identical block and its comment on why the two can't safely
                diverge). */}
            {hasExchangeBreakdown && (
              <div className="rounded-xl border bg-background p-6 sm:p-8 space-y-2">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">Exchange Summary</h2>
                <div className="flex items-center justify-between text-sm text-foreground">
                  <span className="text-muted-foreground">Exchange Fee</span>
                  <span className="tabular-nums">{formatMoney(exchangeFee, displayPricing.currency)}</span>
                </div>
                <div className="flex items-center justify-between text-sm text-foreground">
                  <span className="text-muted-foreground">Fare Difference</span>
                  <span className="tabular-nums">{formatMoney(fareDifference, displayPricing.currency)}</span>
                </div>
                <div className="flex items-center justify-between pt-2 border-t">
                  <span className="text-sm font-medium text-foreground">Total Exchange Cost</span>
                  <span className="text-lg font-semibold text-foreground tabular-nums">{formatMoney(exchangeFee + fareDifference, displayPricing.currency)}</span>
                </div>
              </div>
            )}

            {cancellationFee != null && (
              <div className="rounded-xl border bg-background p-6 sm:p-8 flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Cancellation Fee</span>
                <span className="text-lg font-semibold text-foreground tabular-nums">{formatMoney(Number(cancellationFee), displayPricing.currency)}</span>
              </div>
            )}

            {/* Part 12/13, Pass 13 §32-§35 — a cancellation in progress gets
                a focused cancellation-confirmation panel (itinerary/red
                alert already shown above, via the itinerary card's own
                cancellation banner) with a passenger review step —
                prefilled from this quote's own already-booked passengers,
                fully editable, resembling the existing booking form's own
                passenger UX — instead of the normal Total price/View Deal
                panel. Nothing to show once already CANCELLATION_SUBMITTED
                — the banner above already covers that state. */}
            {cancellationAwaitingCustomer ? (
              <div className="rounded-xl border bg-background overflow-hidden">
                <div className="p-6 sm:p-8">
                  <CancellationConfirmPanel
                    token={token}
                    initialPassengers={quote.booking?.passengers ?? []}
                    company={{ name: company.name, phone: company.phone, website: company.website }}
                  />
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground justify-center mt-3">
                    <ShieldCheck className="h-3 w-3" /> Secure, unique link — please don&apos;t forward this page
                  </p>
                </div>
              </div>
            ) : !cancellationAlreadySubmitted ? (
              <div className="rounded-xl border bg-background overflow-hidden">
                <div className="bg-primary/5 px-6 sm:px-8 py-5 flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-muted-foreground">Total price</span>
                    <p className="text-xs text-muted-foreground mt-0.5">Includes fare, taxes, and service fee</p>
                  </div>
                  <span className="text-3xl font-bold tracking-tight text-foreground tabular-nums">{formatMoney(displayPricing.total, displayPricing.currency)}</span>
                </div>
                <div className="p-6 sm:p-8 pt-5">
                  <Button asChild size="lg" className="w-full">
                    <Link href={`/quote/${token}/book`}>View Deal</Link>
                  </Button>
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground justify-center mt-3">
                    <ShieldCheck className="h-3 w-3" /> Secure, unique link — please don&apos;t forward this page
                  </p>
                </div>
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
