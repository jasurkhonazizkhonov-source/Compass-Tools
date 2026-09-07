import Link from "next/link";
import { notFound } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { ArrowLeft, Mail, Repeat } from "lucide-react";
import { getQuoteDetail, quoteRecordExists } from "@/server/queries/quotes";
import { AccessRestricted } from "@/components/crm/access-restricted";
import { getCurrentAccount } from "@/lib/dev-session";
import { canDeleteQuote, canApproveExchangeOrCancellation } from "@/lib/permissions";
import { deleteQuote } from "@/server/actions/quotes";
import { FlightItineraryDisplay } from "@/components/quotes/flight-itinerary-display";
import { QuoteActions } from "@/components/quotes/quote-actions";
import { DeleteButton } from "@/components/crm/delete-button";
import { QuoteInternalNotesEditor } from "@/components/quotes/quote-internal-notes-editor";
import { SignedBookingDetailsCard } from "@/components/quotes/signed-booking-details-card";
import { BookingInformationCard } from "@/components/quotes/booking-information-card";
import { StatusBadge } from "@/components/crm/status-badge";
import { QUOTE_STATUS_META } from "@/lib/status-meta";
import { EmptyState } from "@/components/crm/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { resolveBaseUrl } from "@/lib/company-config";
import { isSupportedCurrency, formatMoney } from "@/lib/currency";
import { CancellationDialog } from "@/components/quotes/cancellation-dialog";
import { ExchangeApprovalActions } from "@/components/quotes/exchange-approval-actions";
import { CancellationApprovalActions } from "@/components/quotes/cancellation-approval-actions";
import { resolveAirlineConfirmations } from "@/lib/airline-confirmations";
import { resolveAirlineCodes } from "@/server/queries/reference-data";
import { isExchangeProposalRevisable } from "@/lib/exchange-proposal";

export const dynamic = "force-dynamic";

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const currentAccount = await getCurrentAccount();
  const viewer = currentAccount ? { id: currentAccount.id, role: currentAccount.role, companyId: currentAccount.companyId } : null;
  const quote = await getQuoteDetail(id, viewer);
  if (!quote) {
    if (await quoteRecordExists(id)) return <AccessRestricted />;
    notFound();
  }

  const meta = QUOTE_STATUS_META[quote.status];
  const baseUrl = resolveBaseUrl();
  const viewDealUrl = `${baseUrl}/quote/${quote.secureToken}`;
  const currency = isSupportedCurrency(quote.currency) ? quote.currency : "USD";
  const canApprove = canApproveExchangeOrCancellation(currentAccount?.role);
  // Pass 13 §30 — sending/resending the cancellation form is also open to
  // the quote's own responsible agent (whoever actually sent it to the
  // customer, falling back to the quote's current agent for older quotes),
  // not just Admin/Manager — this UI gate mirrors
  // canSendCancellationForm's own server-side authorization exactly (see
  // server/actions/cancellation.ts) so a visible button is never a dead
  // end and a hidden one is never a false negative.
  const canSendOrResendCancellationForm =
    canApprove || (!!currentAccount && (quote.sentByAgentId ?? quote.agentId) === currentAccount.id);
  const pendingCancellationRequest = quote.cancellationRequests.find((r) => r.status === "PENDING");
  // Part 8 — approved (Confirm Cancellation, now approval-only) but the
  // customer hasn't been notified yet: the one that gets the separate,
  // deliberate "Send Cancellation Form" action. Only ever one such request
  // at a time given the quote's own status gates both this and the
  // pending-approval lookup above.
  const approvedCancellationRequest =
    quote.status === "CANCELLATION_APPROVED" ? quote.cancellationRequests.find((r) => r.status === "CONFIRMED") : undefined;
  // Pass 13 §31 — the resend action is only offered once the form has
  // already been sent at least once and the customer hasn't confirmed yet.
  const resendableCancellationRequest =
    quote.status === "CANCELLATION_FORM_SENT" ? quote.cancellationRequests.find((r) => r.status === "CONFIRMED") : undefined;
  // Bug fix (live-caught during QA) — this internal itinerary card was
  // always rendering the "CANCELLATION CONFIRMED / has been cancelled"
  // banner the instant a request reached CancellationRequest.status ===
  // "CONFIRMED" (i.e. the moment an Admin/Manager approves it), which is
  // exactly the premature "already cancelled" claim this whole workflow was
  // built to prevent — CancellationRequest.status CONFIRMED only ever meant
  // "an Admin/Manager acted on this one," never "the flight is actually
  // cancelled." Mirrors the customer-facing page's own derivation: only the
  // Quote's true terminal status counts as "cancelled" for display; every
  // other stage with a request against it is still "scheduled."
  const cancellationDisplayState: "scheduled" | "cancelled" = quote.status === "CANCELLATION_CONFIRMED" ? "cancelled" : "scheduled";
  // Pass 13 §27/§28/§29 — the reviewer must see the exact affected
  // segment(s) highlighted DURING review, not only after approval. A
  // DISREGARDED request's segments are deliberately excluded (nothing is
  // "under consideration" for a request the reviewer already rejected).
  const activeCancelledSegmentIds = new Set(
    quote.cancellationRequests.filter((r) => r.status === "PENDING" || r.status === "CONFIRMED").flatMap((r) => r.segmentIds)
  );
  const segmentOptionsForCancellation = (quote.itinerary?.segments ?? []).map((s) => ({
    id: s.id,
    label: `${s.departureAirport.iata} → ${s.arrivalAirport.iata} · ${s.airline?.name ?? s.airlineCodeRaw ?? "Flight"} ${s.flightNumber}`,
  }));

  // Read-only "Booking Information" panel — resolved via the same
  // canonical resolveAirlineConfirmations helper (and the same
  // resolveAirlineCodes airline-name enrichment) already used by the
  // Booking detail page's own Ticketing card and by
  // sendAirlineConfirmationEmail, so this panel can never disagree with
  // either of those about what the booking's confirmations actually are.
  const confirmationEntries = quote.booking ? resolveAirlineConfirmations(quote.booking) : [];
  const confirmationAirlineIatas = confirmationEntries.map((c) => c.airlineIata).filter((v): v is string => !!v);
  const resolvedConfirmationAirlines = confirmationAirlineIatas.length ? await resolveAirlineCodes(confirmationAirlineIatas) : {};
  const bookingInformationConfirmations = confirmationEntries.map((c) => ({
    id: c.id,
    airlineName: (c.airlineIata && resolvedConfirmationAirlines[c.airlineIata]?.name) || null,
    confirmationNumber: c.confirmationNumber,
    eTicketNumbers: c.eTicketNumbers,
  }));

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/leads/${quote.leadId}`} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Lead
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{quote.quoteNumber}</h1>
              <StatusBadge label={meta.label} tone={meta.tone} />
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {quote.contact.firstName} {quote.contact.lastName} · Agent: {quote.agent?.fullName ?? "Unassigned"}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <QuoteActions
              quoteId={quote.id}
              status={quote.status}
              emails={quote.contact.emails.length > 0 ? quote.contact.emails.map((e) => e.email) : quote.contact.primaryEmail ? [quote.contact.primaryEmail] : []}
              viewDealUrl={viewDealUrl}
            />
            {/* Exchange/Cancellation — charged quotes only, server-side
                re-enforced in sendExchangeForApproval/sendCancellationForApproval
                regardless of this button's visibility. */}
            {quote.status === "CHARGED" && (
              <>
                <Button variant="outline" size="sm" asChild className="gap-1.5">
                  <Link href={`/quotes/exchange/new?originalQuoteId=${quote.id}`}>
                    <Repeat className="h-3.5 w-3.5" /> Exchange
                  </Link>
                </Button>
                <CancellationDialog quoteId={quote.id} segments={segmentOptionsForCancellation} currency={currency} />
              </>
            )}
            {canDeleteQuote(currentAccount?.role) && (
              <DeleteButton
                variant="full"
                confirmTitle="Delete this quote?"
                confirmMessage={
                  quote.booking
                    ? "This quote has an associated booking — deleting the quote will also delete that booking and its payment/ticketing records. This action cannot be undone."
                    : "This action cannot be undone."
                }
                deleteAction={deleteQuote.bind(null, quote.id)}
                redirectTo={`/leads/${quote.leadId}`}
              />
            )}
          </div>
        </div>
      </div>

      {/* This quote IS an exchange proposal against another quote. */}
      {quote.originalQuote && (
        <Card className="shadow-none border-primary/30">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium">
              Exchange Proposal — Original Quote:{" "}
              <Link href={`/quotes/${quote.originalQuote.id}`} className="text-primary hover:underline">
                {quote.originalQuote.quoteNumber}
              </Link>
            </CardTitle>
            {/* Pass 26 — a revised proposal may be sent as long as THIS one
                is still the current proposal in its chain and the customer
                hasn't acted on it yet (see isExchangeProposalRevisable's
                own doc comment); server-side re-enforced in
                sendExchangeForApproval regardless of this button's
                visibility, same as every other exchange/cancellation
                action's client-side gating in this file. */}
            {quote.isCurrentExchangeProposal && isExchangeProposalRevisable(quote.status) && (
              <Button variant="outline" size="sm" asChild className="gap-1.5">
                <Link href={`/quotes/exchange/new?originalQuoteId=${quote.originalQuote.id}&supersedesQuoteId=${quote.id}`}>
                  <Repeat className="h-3.5 w-3.5" /> New Exchange Proposal
                </Link>
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              {/* Exchange Fee/Fare Difference are entered against THIS
                  quote's own customer-facing currency (same "currency"
                  computed above from quote.currency, already used for this
                  quote's Booking display below) — a bare "$" here would be
                  ambiguous/wrong for any non-USD exchange quote. */}
              <div><p className="text-xs text-muted-foreground">Exchange Fee</p><p className="font-medium">{quote.exchangeFee != null ? formatMoney(Number(quote.exchangeFee), currency) : "—"}</p></div>
              <div><p className="text-xs text-muted-foreground">Fare Difference</p><p className="font-medium">{quote.fareDifference != null ? formatMoney(Number(quote.fareDifference), currency) : "—"}</p></div>
              <div><p className="text-xs text-muted-foreground">PNR</p><p className="font-medium">{quote.pnr ?? "—"}</p></div>
              <div><p className="text-xs text-muted-foreground">Reviewed By</p><p className="font-medium">{quote.reviewedBy?.fullName ?? "—"}</p></div>
            </div>
            {/* Pass 13 §22/§24 — staff-only actual cost, visually separated
                from the customer-facing fields above; never rendered on any
                customer-facing surface. */}
            {(quote.internalExchangeFee != null || quote.internalFareDifference != null) && (
              <div className="rounded-md border border-dashed bg-muted/20 p-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Internal Cost — staff only</p>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><p className="text-xs text-muted-foreground">Internal Exchange Fee</p><p className="font-medium">{quote.internalExchangeFee != null ? `$${Number(quote.internalExchangeFee).toFixed(2)}` : "—"}</p></div>
                  <div><p className="text-xs text-muted-foreground">Internal Fare Difference</p><p className="font-medium">{quote.internalFareDifference != null ? `$${Number(quote.internalFareDifference).toFixed(2)}` : "—"}</p></div>
                </div>
              </div>
            )}
            {quote.status === "PENDING_EXCHANGE_APPROVAL" && canApprove && <ExchangeApprovalActions exchangeQuoteId={quote.id} />}
            {quote.originalQuote.itinerary && quote.originalQuote.itinerary.segments.length > 0 && (
              <div className="pt-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Original Itinerary</p>
                <FlightItineraryDisplay segments={quote.originalQuote.itinerary.segments} />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Exchange proposals that exist AGAINST this quote (most recent first). */}
      {quote.exchangeQuotes.length > 0 && (
        <Card className="shadow-none">
          <CardHeader><CardTitle className="text-sm font-medium">Exchange Requests</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {quote.exchangeQuotes.map((eq) => {
                const eqMeta = QUOTE_STATUS_META[eq.status];
                return (
                  <li key={eq.id} className="flex items-center justify-between text-sm">
                    <Link href={`/quotes/${eq.id}`} className="hover:underline hover:text-primary font-medium">{eq.quoteNumber}</Link>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      by {eq.agent?.fullName ?? "—"} · {formatDistanceToNow(eq.createdAt, { addSuffix: true })}
                      <StatusBadge label={eqMeta.label} tone={eqMeta.tone} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Cancellation requests against this quote. Pending one gets the
          Approve/Disregard actions; once approved (but not yet sent), the
          separate "Send Cancellation Form" action; every past request
          stays listed for audit history, including a disregarded one. The
          quote's own (finer-grained) status is shown too, since a single
          request can pass through several distinct quote-status stages
          (Approved -> Form Sent -> Submitted -> Cancelled) after review. */}
      {quote.cancellationRequests.length > 0 && (
        <Card className="shadow-none">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium">Cancellation Requests</CardTitle>
            {(quote.status === "CANCELLATION_APPROVED" || quote.status === "CANCELLATION_FORM_SENT" || quote.status === "CANCELLATION_SUBMITTED" || quote.status === "CANCELLATION_CONFIRMED") && (
              <StatusBadge label={QUOTE_STATUS_META[quote.status].label} tone={QUOTE_STATUS_META[quote.status].tone} />
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingCancellationRequest && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-foreground" role="alert">
                <p className="font-semibold text-destructive">Cancellation requested — going to be cancelled if approved and confirmed</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The following segment{pendingCancellationRequest.segmentIds.length === 1 ? " is" : "s are"} being considered for cancellation. No flight has been cancelled yet.
                </p>
                <ul className="mt-1.5 space-y-0.5">
                  {segmentOptionsForCancellation
                    .filter((s) => pendingCancellationRequest.segmentIds.includes(s.id))
                    .map((s) => (
                      <li key={s.id} className="text-xs font-medium">{s.label}</li>
                    ))}
                </ul>
              </div>
            )}
            {pendingCancellationRequest && canApprove && (
              <CancellationApprovalActions cancellationRequestId={pendingCancellationRequest.id} mode="approve" />
            )}
            {approvedCancellationRequest && canSendOrResendCancellationForm && (
              <CancellationApprovalActions cancellationRequestId={approvedCancellationRequest.id} mode="send-form" />
            )}
            {resendableCancellationRequest && canSendOrResendCancellationForm && (
              <CancellationApprovalActions cancellationRequestId={resendableCancellationRequest.id} mode="resend" />
            )}
            <ul className="space-y-2">
              {quote.cancellationRequests.map((r) => (
                <li key={r.id} className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0">
                  <span>
                    {r.segmentIds.length} segment{r.segmentIds.length === 1 ? "" : "s"} · Fee: {r.cancellationFee != null ? formatMoney(Number(r.cancellationFee), currency) : "—"}
                    {r.pnr ? ` · PNR: ${r.pnr}` : ""}
                    {r.internalNotes ? <span className="block text-xs text-muted-foreground mt-0.5">{r.internalNotes}</span> : null}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
                    by {r.createdBy?.fullName ?? "—"} · {formatDistanceToNow(r.createdAt, { addSuffix: true })}
                    <StatusBadge
                      label={r.status === "PENDING" ? "Pending" : r.status === "CONFIRMED" ? "Approved" : "Disregarded"}
                      tone={r.status === "PENDING" ? "warning" : r.status === "CONFIRMED" ? "success" : "neutral"}
                    />
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-5">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Itinerary</CardTitle>
            </CardHeader>
            <CardContent>
              {quote.itinerary && quote.itinerary.segments.length > 0 ? (
                <FlightItineraryDisplay segments={quote.itinerary.segments} cancelledSegmentIds={activeCancelledSegmentIds} cancellationState={cancellationDisplayState} />
              ) : (
                <EmptyState icon={Mail} title="No itinerary" description="This quote has no flight segments." />
              )}
            </CardContent>
          </Card>

          {quote.booking && <SignedBookingDetailsCard booking={quote.booking} currency={currency} />}

          {quote.booking && (
            <BookingInformationCard
              bookingId={quote.booking.id}
              pnr={quote.booking.pnr}
              confirmations={bookingInformationConfirmations}
              status={quote.booking.status}
              fareAmount={quote.booking.fareAmount != null ? Number(quote.booking.fareAmount) : null}
              taxAmount={quote.booking.taxAmount != null ? Number(quote.booking.taxAmount) : null}
              serviceFeeAmount={quote.booking.serviceFeeAmount != null ? Number(quote.booking.serviceFeeAmount) : null}
              profitAmount={quote.booking.profitAmount != null ? Number(quote.booking.profitAmount) : null}
              internalNotes={quote.booking.internalNotes}
              hasSentConfirmationBefore={quote.booking.airlineConfirmationFirstSentAt != null}
            />
          )}

          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Status History</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {quote.statusHistory.map((h) => (
                  <li key={h.id} className="flex items-center justify-between text-sm">
                    <span>
                      {h.fromStatus ? `${QUOTE_STATUS_META[h.fromStatus].label} → ` : ""}
                      <span className="font-medium">{QUOTE_STATUS_META[h.toStatus].label}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {h.changedBy?.fullName ?? "System"} · {formatDistanceToNow(h.changedAt, { addSuffix: true })}
                    </span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card className="shadow-none border-dashed">
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                Internal Notes
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground bg-muted rounded px-1.5 py-0.5">Staff only</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <QuoteInternalNotesEditor
                quoteId={quote.id}
                internalNotes={quote.internalNotes}
                netTicketCost={quote.netTicketCost ? Number(quote.netTicketCost) : null}
              />
            </CardContent>
          </Card>

          {quote.emailLogs.length > 0 && (
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Email Log</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {quote.emailLogs.map((e) => (
                    <li key={e.id} className="flex items-center justify-between text-sm">
                      <span>{e.subject}</span>
                      <span className="flex items-center gap-2">
                        <StatusBadge
                          label={e.status === "SENT" ? "Sent" : "Failed"}
                          tone={e.status === "SENT" ? "success" : "destructive"}
                        />
                        <span className="text-xs text-muted-foreground">{format(e.createdAt, "MMM d, h:mm a")}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>

        <Card className="shadow-none sticky top-20 h-fit">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Price Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Adults ({quote.adults} × ${Number(quote.adultPrice).toLocaleString()})</span>
              <span>${(quote.adults * Number(quote.adultPrice)).toLocaleString()}</span>
            </div>
            {quote.children > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Children ({quote.children} × ${Number(quote.childPrice).toLocaleString()})</span>
                <span>${(quote.children * Number(quote.childPrice)).toLocaleString()}</span>
              </div>
            )}
            {quote.infants > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Infants ({quote.infants} × ${Number(quote.infantPrice).toLocaleString()})</span>
                <span>${(quote.infants * Number(quote.infantPrice)).toLocaleString()}</span>
              </div>
            )}
            <div className="flex justify-between text-muted-foreground">
              <span>Taxes</span>
              <span>${Number(quote.taxes).toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Service fee</span>
              <span>${Number(quote.serviceFee).toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Gratuity</span>
              <span>${Number(quote.gratuity).toLocaleString()}</span>
            </div>
            <div className="flex justify-between font-semibold text-base pt-2 border-t">
              <span>Total</span>
              <span>${Number(quote.total).toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
