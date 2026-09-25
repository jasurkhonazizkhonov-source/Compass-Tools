import { notFound, redirect } from "next/navigation";
import { getQuoteByToken } from "@/server/queries/quotes";
import {
  getLastChargedBookingForContact,
  getPreviousPassengersForContact,
  getPreviousBillingAddressesForContact,
  getPreviousPaymentMethodsForContact,
} from "@/server/queries/bookings";
import { trackBookingFormStarted } from "@/server/actions/booking";
import { BookingFlow } from "@/components/booking/booking-flow";
import { CustomerHeader } from "@/components/customer/customer-header";
import { getCompanyForContactId } from "@/server/queries/company";
import { resolveAirlineCodes } from "@/server/queries/reference-data";
import { isSupportedCurrency } from "@/lib/currency";
import { isQuoteBookable } from "@/lib/exchange-proposal";
import { getPaymentClientConfig } from "@/server/payments/provider";

export const dynamic = "force-dynamic";
// Server Actions inherit their time limit from the page they are used on —
// submitBooking (Finish Booking) runs under this page. See quote/layout.tsx.
export const maxDuration = 60;

export default async function BookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const quote = await getQuoteByToken(token);
  if (!quote || quote.status === "CANCELED") notFound();
  // Pass 26 §2 — same allow-list submitBooking itself enforces (see its own
  // doc comment) — a superseded/disapproved/not-yet-sent quote's booking
  // form must never even render, not merely reject on final submit. Routes
  // back to the main quote page (not notFound()) so the customer sees the
  // correct contextual message (e.g. "replaced by a newer proposal") rather
  // than a bare 404. A quote already carrying a Booking is handled
  // separately just below — this only concerns a quote that was never
  // eligible to begin with.
  if (!quote.booking && !isQuoteBookable(quote.status)) {
    redirect(`/quote/${token}`);
  }
  // Already signed — never show the form again for a resubmission attempt
  // (submitBooking() itself also blocks this server-side), and never a
  // bare 404 for a customer who bookmarks/reloads this URL after signing.
  // Determined server-side from the quote's own booking relation, not any
  // frontend/session state, and reuses the existing confirmation page
  // (which already carries the "we're working on ticket issuance" copy
  // and current status) rather than inventing a second "already signed"
  // surface.
  //
  // Exception: a cancellation in progress — defense-in-depth for a
  // bookmarked/reloaded `/book` URL (the normal flow no longer links here
  // at all during a cancellation; see quote/[token]/page.tsx's own
  // "Confirm Cancellation" panel). submitBooking() would reject this
  // outright anyway (Booking.quoteId is unique and this quote's Booking
  // already exists), and /confirmation has zero cancellation awareness —
  // so route back to the main quote page instead, which correctly shows
  // the current cancellation state.
  if (quote.booking) {
    const cancellationInProgress = quote.status === "CANCELLATION_APPROVED" || quote.status === "CANCELLATION_FORM_SENT" || quote.status === "CANCELLATION_SUBMITTED";
    redirect(cancellationInProgress ? `/quote/${token}` : `/quote/${token}/confirmation`);
  }

  // Every lookup below depends only on values already in hand (the token /
  // quote.contactId), so they run together instead of one after another:
  // this page used to spend ~8 sequential database round trips before it
  // could render, which on a high-latency database link is several seconds
  // of blank screen for the customer. (trackBookingFormStarted is the same
  // once-per-quote write it always was; only its position changed.)
  const [, company, previousBooking, previousPassengers, previousBillingAddresses, previousPaymentMethods] = await Promise.all([
    trackBookingFormStarted(token),
    getCompanyForContactId(quote.contactId),
    // Pass 13 §36/§37 — prefill from the customer's last CHARGED booking,
    // scoped to this contact only, and only for an EXCHANGE quote
    // (originalQuoteId set); never fetched otherwise.
    quote.originalQuoteId ? getLastChargedBookingForContact(quote.contactId) : Promise.resolve(null),
    // Passengers / billing addresses / payment methods are fetched
    // unconditionally (new booking, exchange AND cancellation all offer the
    // explicit selectors). Every one is scoped by `quote.contactId`,
    // server-resolved from the quote's own secureToken — never a
    // client-supplied identifier.
    getPreviousPassengersForContact(quote.contactId),
    getPreviousBillingAddressesForContact(quote.contactId),
    getPreviousPaymentMethodsForContact(quote.contactId),
  ]);

  const segments = quote.itinerary?.segments ?? [];
  const originalSegments = quote.originalQuote?.itinerary?.segments ?? [];
  const cancelledSegmentIds = new Set(quote.cancellationRequests.flatMap((r) => r.segmentIds));
  const cancellationFee = quote.cancellationRequests.find((r) => r.cancellationFee != null)?.cancellationFee;
  // The silent positional prefill for an EXCHANGE (`previousBooking`) is
  // additive to the explicit previous-passenger/billing/payment selectors
  // (Pass 24-27): an exchange gets both, exactly like a new booking.
  const previousFrequentFlyerAirlines = previousPassengers
    .map((p) => p.frequentFlyerAirline)
    .filter((code): code is string => !!code);
  const resolvedFrequentFlyerAirlines = previousFrequentFlyerAirlines.length ? await resolveAirlineCodes(previousFrequentFlyerAirlines) : {};


  const paymentConfig = getPaymentClientConfig();

  return (
    <div className="min-h-screen bg-muted/30">
      <CustomerHeader subtitle="Complete your booking" maxWidth="max-w-6xl" logoUrl={company.logoWebUrl} companyName={company.name} />

      <main className="max-w-6xl mx-auto px-4 py-8">
        <BookingFlow
          token={token}
          segments={segments}
          originalSegments={originalSegments}
          cancelledSegmentIds={cancelledSegmentIds}
          exchangeFee={quote.exchangeFee != null ? Number(quote.exchangeFee) : null}
          fareDifference={quote.fareDifference != null ? Number(quote.fareDifference) : null}
          cancellationFee={cancellationFee != null ? Number(cancellationFee) : null}
          adults={quote.adults}
          childrenCount={quote.children}
          infants={quote.infants}
          adultPrice={Number(quote.adultPrice)}
          childPrice={Number(quote.childPrice)}
          infantPrice={Number(quote.infantPrice)}
          taxes={Number(quote.taxes)}
          serviceFee={Number(quote.serviceFee)}
          currency={isSupportedCurrency(quote.currency) ? quote.currency : "USD"}
          exchangeRate={quote.exchangeRate ? Number(quote.exchangeRate) : 1}
          contactFirstName={quote.contact.firstName}
          contactPhone={quote.contact.primaryPhone ?? ""}
          contactEmail={quote.contact.primaryEmail ?? ""}
          companyName={company.name}
          companyPhone={company.phone}
          companyWebsite={company.website}
          previousPassengers={previousBooking?.passengers}
          previousPassengerOptions={previousPassengers.map((p) => ({
            ...p,
            frequentFlyerAirline: p.frequentFlyerAirline ? (resolvedFrequentFlyerAirlines[p.frequentFlyerAirline] ?? null) : null,
          }))}
          previousBillingAddresses={previousBillingAddresses}
          previousPaymentMethods={previousPaymentMethods}
          // Only the publishable key ever reaches the browser.
          paymentConfig={paymentConfig.ready ? { ready: true, publishableKey: paymentConfig.publishableKey } : { ready: false }}
        />
      </main>
    </div>
  );
}
