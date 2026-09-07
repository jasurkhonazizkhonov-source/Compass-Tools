import { notFound } from "next/navigation";
import { CheckCircle2, XCircle } from "lucide-react";
import { getQuoteByToken } from "@/server/queries/quotes";
import { FlightItineraryDisplay } from "@/components/quotes/flight-itinerary-display";
import { BOOKING_STATUS_META } from "@/lib/status-meta";
import { StatusBadge } from "@/components/crm/status-badge";
import { CustomerHeader } from "@/components/customer/customer-header";
import { CloseBookingButton } from "@/components/customer/close-booking-button";
import { getCompanyForContactId } from "@/server/queries/company";

export const dynamic = "force-dynamic";

export default async function BookingConfirmationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const quote = await getQuoteByToken(token);
  if (!quote || !quote.booking) notFound();

  const segments = quote.itinerary?.segments ?? [];
  const company = await getCompanyForContactId(quote.contactId);

  // Pass 14 — this page previously always showed the generic "Thank You
  // for Booking... we're working on your ticket issuance" hero with the
  // BOOKING's own ticketing status (PENDING_TICKETING/TICKETED/CONFIRMED/
  // CANCELED), regardless of the QUOTE's cancellation lifecycle. Once a
  // cancellation reaches its true final state (CANCELLATION_CONFIRMED),
  // the quote-detail page's own redirect sends the customer straight here
  // — but this page had no idea a cancellation had ever happened, so a
  // customer whose flight was actually cancelled landed on a page reading
  // "Thank You for Booking... Status: Confirmed" with no cancellation
  // indication anywhere, and the itinerary below rendered with no red
  // segment banner either. Fixed: this page now reads the same
  // cancellationRequests (CONFIRMED-only, already selected by
  // getQuoteByToken — see quote/[token]/page.tsx for the identical
  // pattern) and, once truly confirmed-cancelled, replaces the "Thank You
  // for Booking" hero with a clearly distinct cancelled-state hero and
  // marks the affected segment(s) below — never a silent, misleading
  // "Confirmed" badge over a cancelled flight.
  const isCancelled = quote.status === "CANCELLATION_CONFIRMED";
  const cancelledSegmentIds = new Set(quote.cancellationRequests.flatMap((r) => r.segmentIds));

  return (
    <div className="min-h-screen bg-muted/30">
      <CustomerHeader subtitle="Booking confirmation" action={<CloseBookingButton compact />} maxWidth="max-w-3xl" logoUrl={company.logoWebUrl} companyName={company.name} />

      <main className="max-w-3xl mx-auto px-4 py-10 space-y-6">
        {isCancelled ? (
          <div className="rounded-xl border border-destructive/30 bg-background p-8 text-center space-y-3 animate-in fade-in zoom-in-95 duration-300">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <XCircle className="h-7 w-7" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">This Booking Has Been Cancelled</h1>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              The flight segment(s) marked below have been cancelled, as confirmed with {company.name}. If you have any questions, please reach out to your travel agent.
            </p>
            <p className="text-sm text-muted-foreground">
              {quote.contact.firstName} {quote.contact.lastName}
            </p>
            <div className="flex items-center justify-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground">Status:</span>
              <StatusBadge label="Cancelled" tone="destructive" />
            </div>
          </div>
        ) : (
          <div className="rounded-xl border bg-background p-8 text-center space-y-3 animate-in fade-in zoom-in-95 duration-300">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Thank You for Booking With {company.name}</h1>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              We received your booking request and are currently working on your ticket issuance. As soon as your tickets are booked, you&apos;ll receive an automatic email with your final flight itinerary, complete charge breakdown, and airline confirmation number(s).
            </p>
            <p className="text-sm text-muted-foreground">
              {quote.contact.firstName} {quote.contact.lastName}
            </p>
            {quote.booking && (
              <div className="flex items-center justify-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground">Status:</span>
                <StatusBadge
                  label={BOOKING_STATUS_META[quote.booking.status].label}
                  tone={BOOKING_STATUS_META[quote.booking.status].tone}
                />
              </div>
            )}
          </div>
        )}

        <div className="rounded-xl border bg-background p-6 sm:p-8 space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Flight Summary</h2>
          <FlightItineraryDisplay segments={segments} customerFacing cancelledSegmentIds={cancelledSegmentIds} cancellationState="cancelled" />
        </div>
      </main>
    </div>
  );
}
