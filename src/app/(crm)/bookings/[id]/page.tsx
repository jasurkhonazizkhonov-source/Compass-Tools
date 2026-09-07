import Link from "next/link";
import { notFound } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { ArrowLeft } from "lucide-react";
import { getBookingDetail, bookingRecordExists } from "@/server/queries/bookings";
import { AccessRestricted } from "@/components/crm/access-restricted";
import { FlightItineraryDisplay } from "@/components/quotes/flight-itinerary-display";
import { BookingTicketingForm } from "@/components/bookings/booking-ticketing-form";
import { ChargeCustomerPanel } from "@/components/bookings/charge-customer-panel";
import { PaymentMethodCard } from "@/components/bookings/payment-method-card";
import { BookingIpReveal } from "@/components/bookings/booking-ip-reveal";
import { StatusBadge } from "@/components/crm/status-badge";
import { BOOKING_STATUS_META } from "@/lib/status-meta";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentAccount } from "@/lib/dev-session";
import { canRevealPaymentMethod, canConfirmPayment, canRevealBookingIp, canAuthorizeSupplierPayment, canDeleteBooking, canViewBookings, canEnterTicketingInfo } from "@/lib/permissions";
import { deleteBooking } from "@/server/actions/bookings";
import { DeleteButton } from "@/components/crm/delete-button";
import { formatMoney, isSupportedCurrency } from "@/lib/currency";
import { getBookingType, BOOKING_TYPE_LABELS } from "@/lib/booking-type";
import { Badge } from "@/components/ui/badge";
import { resolveAirlineConfirmations } from "@/lib/airline-confirmations";
import { resolveAirlineCodes } from "@/server/queries/reference-data";

export const dynamic = "force-dynamic";

export default async function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const currentAccount = await getCurrentAccount();
  if (!canViewBookings(currentAccount?.role)) notFound();
  const viewer = currentAccount ? { id: currentAccount.id, role: currentAccount.role, companyId: currentAccount.companyId } : null;
  const booking = await getBookingDetail(id, viewer);
  if (!booking) {
    if (await bookingRecordExists(id)) return <AccessRestricted />;
    notFound();
  }

  const meta = BOOKING_STATUS_META[booking.status];
  const bookingType = getBookingType(booking.quote);
  const segments = booking.quote.itinerary?.segments ?? [];
  const currency = isSupportedCurrency(booking.quote.currency) ? booking.quote.currency : "USD";

  // Pass 23 — resolve the booking's confirmations (transparently falling
  // back to any pre-Pass-23 legacy single value) and enrich each with an
  // airline display name for the form, via the same canonical resolver
  // used everywhere else — never a second lookup scheme.
  const confirmationEntries = resolveAirlineConfirmations(booking);
  const confirmationAirlineIatas = confirmationEntries.map((c) => c.airlineIata).filter((v): v is string => !!v);
  const resolvedConfirmationAirlines = confirmationAirlineIatas.length ? await resolveAirlineCodes(confirmationAirlineIatas) : {};
  const airlineConfirmationsForForm = confirmationEntries.map((c) => ({
    id: c.id,
    airlineIata: c.airlineIata,
    airlineName: (c.airlineIata && resolvedConfirmationAirlines[c.airlineIata]?.name) || null,
    confirmationNumber: c.confirmationNumber,
    eTicketNumbers: c.eTicketNumbers,
  }));

  return (
    <div className="space-y-5">
      <div>
        <Link href="/bookings" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Bookings
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{booking.bookingReference}</h1>
            <Badge
              variant="outline"
              className={
                bookingType === "CANCELLATION"
                  ? "border-destructive/40 text-destructive"
                  : bookingType === "EXCHANGE"
                    ? "border-info/40 text-info"
                    : ""
              }
            >
              {BOOKING_TYPE_LABELS[bookingType]}
            </Badge>
            <StatusBadge label={meta.label} tone={meta.tone} />
          </div>
          {canDeleteBooking(currentAccount?.role) && (
            <DeleteButton
              variant="full"
              confirmTitle="Delete this booking?"
              confirmMessage="This will permanently delete this booking, including its passenger, payment, and ticketing records. The quote, lead, and contact are not affected. This action cannot be undone."
              deleteAction={deleteBooking.bind(null, booking.id)}
              redirectTo="/bookings"
            />
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {booking.contact.firstName} {booking.contact.lastName} · Agent: {booking.lead.assignedAgent?.fullName ?? "Unassigned"} ·{" "}
          <Link href={`/leads/${booking.leadId}`} className="text-primary hover:underline">View Lead</Link>
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-5">
          <Card className="shadow-none">
            <CardHeader><CardTitle className="text-sm font-medium">Itinerary</CardTitle></CardHeader>
            <CardContent><FlightItineraryDisplay segments={segments} /></CardContent>
          </Card>

          <Card className="shadow-none">
            <CardHeader><CardTitle className="text-sm font-medium">Passengers</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {booking.passengers.map((p) => {
                const hasMembership = p.tsaKnownTravelerNumber || p.globalEntryNumber || p.frequentFlyerAirline;
                return (
                  <div key={p.id} className="rounded-md border px-3 py-3 space-y-3">
                    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {p.type}
                    </span>
                    <div className="grid grid-cols-3 gap-3">
                      <Field label="First Name" value={p.firstName} />
                      <Field label="Middle Name" value={p.middleName || "—"} />
                      <Field label="Last Name" value={p.lastName} />
                    </div>
                    {/* Date of birth is a calendar date with no time-of-day
                        meaning — formatted in UTC explicitly (never the
                        server process's local timezone) so it can never
                        display a day off from what the customer actually
                        typed, matching the same UTC-forced pattern already
                        used for this same field on the quote page
                        (signed-booking-details-card.tsx) and for
                        Account.hiredAt elsewhere in this app. Using
                        date-fns's format() here previously rendered the
                        wrong calendar day whenever the server process's
                        local timezone was behind UTC. */}
                    <Field
                      label="Date of Birth"
                      value={p.dateOfBirth ? p.dateOfBirth.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "—"}
                    />

                    {hasMembership && (
                      <div className="pt-2 border-t space-y-2">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Traveler Membership Information</p>
                        <div className="grid grid-cols-2 gap-3">
                          {p.tsaKnownTravelerNumber && <Field label="TSA / Known Traveler" value={p.tsaKnownTravelerNumber} />}
                          {p.globalEntryNumber && <Field label="Global Entry" value={p.globalEntryNumber} />}
                          {p.frequentFlyerAirline && (
                            <Field label="Frequent Flyer" value={`${p.frequentFlyerAirline} ${p.frequentFlyerNumber ?? ""}`.trim()} />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card className="shadow-none">
            <CardHeader><CardTitle className="text-sm font-medium">Contact Information</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <Field label="Phone" value={booking.contactPhone || "—"} />
              <Field label="Email" value={booking.contactEmail || "—"} />
            </CardContent>
          </Card>

          <Card className="shadow-none">
            <CardHeader><CardTitle className="text-sm font-medium">Billing Address</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <Field label="Address" value={booking.billingApt ? `${booking.billingAddress}, ${booking.billingApt}` : booking.billingAddress} className="col-span-2" />
              <Field label="City" value={booking.billingCity} />
              <Field label="State / Province" value={booking.billingState} />
              <Field label="ZIP / Postal Code" value={booking.billingZip} />
              <Field label="Country" value={booking.billingCountry} />
            </CardContent>
          </Card>

          <Card className="shadow-none">
            <CardHeader><CardTitle className="text-sm font-medium">Payment Information</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {booking.paymentMethods.length === 0 ? (
                <p className="text-sm text-muted-foreground">No payment method on file</p>
              ) : (
                booking.paymentMethods.map((pm, i) => (
                  <div key={pm.id} className="space-y-3">
                    <PaymentMethodCard
                      bookingId={booking.id}
                      label={`Payment Method ${i + 1}`}
                      paymentMethod={{
                        id: pm.id,
                        cardholderName: pm.cardholderName,
                        last4: pm.last4,
                        cardBrand: pm.cardBrand,
                        expiryMonth: pm.expiryMonth,
                        expiryYear: pm.expiryYear,
                        amountAllocated: Number(pm.amountAllocated),
                        workflowStatus: pm.workflowStatus,
                        status: pm.status,
                      }}
                      canReveal={canRevealPaymentMethod(currentAccount)}
                      canAuthorizeSupplierPayment={canAuthorizeSupplierPayment(currentAccount)}
                      canManageStatus={canConfirmPayment(currentAccount)}
                      currency={currency}
                    />
                    <div className="pl-3 border-l-2">
                      <ChargeCustomerPanel
                        bookingId={booking.id}
                        paymentMethodId={pm.id}
                        defaultAmount={Number(pm.amountAllocated)}
                        currency={currency}
                        canConfirm={canConfirmPayment(currentAccount)}
                        charges={pm.charges.map((c) => ({
                          id: c.id,
                          amount: Number(c.amount),
                          currency: c.currency,
                          status: c.status,
                          referenceNote: c.referenceNote,
                          errorMessage: c.errorMessage,
                          createdAt: c.createdAt,
                          initiatedBy: c.initiatedBy ? { fullName: c.initiatedBy.fullName } : null,
                        }))}
                      />
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {booking.signature && (
            <Card className="shadow-none">
              <CardHeader><CardTitle className="text-sm font-medium">Electronic Signature</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <Field label="Signed By" value={booking.signature.signedName} />
                <Field label="Date" value={format(booking.signature.signedAt, "MMM d, yyyy")} />
                <Field label="Time" value={format(booking.signature.signedAt, "h:mm a")} />
              </CardContent>
            </Card>
          )}

          <Card className="shadow-none">
            <CardHeader><CardTitle className="text-sm font-medium">Security &amp; Submission Information</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <Field label="Submitted" value={format(booking.createdAt, "MMM d, yyyy 'at' h:mm a")} />
              <BookingIpReveal bookingId={booking.id} canReveal={canRevealBookingIp(currentAccount)} />
            </CardContent>
          </Card>

          <Card className="shadow-none">
            {/* Item 11 — combined "PNR Information" + "Booking Information"
                into one section titled "Booking Information" (renamed from
                "Ticketing"; PNR was already just one field within this same
                card, never its own separate section). */}
            <CardHeader><CardTitle className="text-sm font-medium">Booking Information</CardTitle></CardHeader>
            <CardContent>
              <BookingTicketingForm
                bookingId={booking.id}
                pnr={booking.pnr}
                airlineConfirmations={airlineConfirmationsForForm}
                hasSentConfirmationBefore={booking.airlineConfirmationFirstSentAt != null}
                status={booking.status}
                fareAmount={booking.fareAmount ? Number(booking.fareAmount) : null}
                taxAmount={booking.taxAmount ? Number(booking.taxAmount) : null}
                serviceFeeAmount={booking.serviceFeeAmount ? Number(booking.serviceFeeAmount) : null}
                bookingNotes={booking.internalNotes}
                quoteCancellationStatus={booking.quote.status}
                canEdit={canEnterTicketingInfo(currentAccount?.role)}
                quotePassengerPricing={{
                  adults: booking.quote.adults,
                  adultPrice: Number(booking.quote.adultPrice),
                  children: booking.quote.children,
                  childPrice: Number(booking.quote.childPrice),
                  infants: booking.quote.infants,
                  infantPrice: Number(booking.quote.infantPrice),
                }}
              />
            </CardContent>
          </Card>

          <Card className="shadow-none">
            <CardHeader><CardTitle className="text-sm font-medium">Status History</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {booking.statusHistory.map((h) => (
                  <li key={h.id} className="flex items-center justify-between">
                    <span>{h.fromStatus ? `${h.fromStatus} → ` : ""}<span className="font-medium">{h.toStatus}</span></span>
                    <span className="text-xs text-muted-foreground">{h.changedBy?.fullName ?? "System"} · {formatDistanceToNow(h.changedAt, { addSuffix: true })}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <Card className="shadow-none sticky top-6 h-fit">
          <CardHeader><CardTitle className="text-sm font-medium">Price Summary</CardTitle></CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            <div className="flex justify-between text-muted-foreground"><span>Ticket Cost</span><span>{formatMoney(Number(booking.fareAmount), currency)}</span></div>
            {Number(booking.taxAmount) > 0 && (
              <div className="flex justify-between text-muted-foreground"><span>Taxes</span><span>{formatMoney(Number(booking.taxAmount), currency)}</span></div>
            )}
            {Number(booking.serviceFeeAmount) > 0 && (
              <div className="flex justify-between text-muted-foreground"><span>Issuing Fee</span><span>{formatMoney(Number(booking.serviceFeeAmount), currency)}</span></div>
            )}
            <div className="flex justify-between text-muted-foreground"><span>Gratuity</span><span>{formatMoney(Number(booking.gratuityAmount), currency)}</span></div>
            <div className="flex justify-between font-semibold text-base pt-2 border-t"><span>Total</span><span>{formatMoney(Number(booking.totalAmount), currency)}</span></div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium break-words">{value}</p>
    </div>
  );
}
