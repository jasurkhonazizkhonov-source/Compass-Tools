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

export const dynamic = "force-dynamic";

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

  await trackBookingFormStarted(token);

  const segments = quote.itinerary?.segments ?? [];
  const originalSegments = quote.originalQuote?.itinerary?.segments ?? [];
  const cancelledSegmentIds = new Set(quote.cancellationRequests.flatMap((r) => r.segmentIds));
  const company = await getCompanyForContactId(quote.contactId);
  const cancellationFee = quote.cancellationRequests.find((r) => r.cancellationFee != null)?.cancellationFee;
  // Pass 13 §36/§37 — prefill from the customer's last CHARGED booking,
  // scoped to this contact only (see getLastChargedBookingForContact's own
  // security guarantee), only for an EXCHANGE quote (originalQuoteId set)
  // — a brand-new customer's first booking has no prior data to prefill
  // from, and this deliberately doesn't change that existing blank-form
  // behavior. Never awaited when not needed, keeping the common (non-
  // exchange) path's page load exactly as fast as before this pass.
  const previousBooking = quote.originalQuoteId ? await getLastChargedBookingForContact(quote.contactId) : null;

  // Pass 24/25 originally scoped the explicit "select a previous
  // passenger/billing address/payment method" selectors to the NEW
  // (non-exchange) booking form only, reasoning that exchange already had
  // its own silent positional-prefill (`previousPassengers` below) for
  // passengers specifically. That left billing-address and payment-method
  // selection with NO mechanism at all on the exchange form — Pass 27 §13/
  // §14 explicitly requires all three to work across new booking, exchange,
  // AND cancellation. Fixed by fetching all three unconditionally: same
  // security boundary either way (every one of these queries is scoped by
  // `quote.contactId`, server-resolved from the quote's own secureToken —
  // never a client-supplied identifier — so there is nothing exchange-
  // specific that would make this less safe here than on a new booking).
  // The existing silent positional prefill for exchange (`previousBooking`
  // below) is left completely untouched — this is additive, not a
  // replacement: exchange now gets BOTH its original silent default AND
  // the explicit selector, exactly like a new booking already does.
  const previousPassengers = await getPreviousPassengersForContact(quote.contactId);
  const previousFrequentFlyerAirlines = previousPassengers
    .map((p) => p.frequentFlyerAirline)
    .filter((code): code is string => !!code);
  const resolvedFrequentFlyerAirlines = previousFrequentFlyerAirlines.length ? await resolveAirlineCodes(previousFrequentFlyerAirlines) : {};

  const previousBillingAddresses = await getPreviousBillingAddressesForContact(quote.contactId);
  const previousPaymentMethods = await getPreviousPaymentMethodsForContact(quote.contactId);

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
        />
      </main>
    </div>
  );
}
