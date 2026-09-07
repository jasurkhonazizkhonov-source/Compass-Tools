"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, PenLine, ShieldCheck, Pencil, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { FlightItineraryDisplay } from "@/components/quotes/flight-itinerary-display";
import { PassengerForm, type PassengerFormState } from "@/components/booking/passenger-form";
import { CardPaymentSection, PaymentConsentCheckbox, EMPTY_CARD_FORM, type CardFormState } from "@/components/booking/card-payment-section";
import { LegalAgreementAccordion } from "@/components/booking/legal-agreement-accordion";
import { CountrySelect } from "@/components/booking/country-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PaymentBadge } from "@/components/crm/payment-badge";
import { PhoneInput, DEFAULT_PHONE_COUNTRY } from "@/components/crm/phone-input";
import { Plus } from "lucide-react";
import { calculatePricing, GRATUITY_PRESETS } from "@/lib/pricing";
import { buildPricingSnapshot, formatMoney, type SupportedCurrency } from "@/lib/currency";
import { normalizePhoneNumber, type CountryCode } from "@/lib/phone";
import { submitBooking } from "@/server/actions/booking";
import { isValidCardNumber, isValidExpiry, isValidCvvFormat, detectCardBrand, lastFour } from "@/lib/card-validation";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { AirlineOption } from "@/server/queries/reference-data";

type SegmentDisplay = Parameters<typeof FlightItineraryDisplay>[0]["segments"];

function newPassenger(type: PassengerFormState["type"]): PassengerFormState {
  return {
    clientId: crypto.randomUUID(),
    type,
    firstName: "",
    middleName: "",
    lastName: "",
    dateOfBirth: "",
    gender: "",
    tsaKnownTravelerNumber: "",
    globalEntryNumber: "",
    frequentFlyerAirline: null,
    frequentFlyerNumber: "",
  };
}

export function BookingFlow({
  token,
  segments,
  adults,
  childrenCount,
  infants,
  adultPrice,
  childPrice,
  infantPrice,
  taxes,
  serviceFee,
  currency,
  exchangeRate,
  contactFirstName,
  contactPhone,
  contactEmail,
  companyName,
  companyPhone,
  companyWebsite,
  originalSegments,
  cancelledSegmentIds,
  exchangeFee,
  fareDifference,
  cancellationFee,
  previousPassengers,
  previousPassengerOptions,
  previousBillingAddresses,
  previousPaymentMethods,
}: {
  token: string;
  segments: SegmentDisplay;
  /** Exchange workflow — the customer's existing itinerary, shown in its
   * own clearly-labeled section above the proposed one. Omitted (or
   * empty) for an ordinary, non-exchange booking. */
  originalSegments?: SegmentDisplay;
  /** Cancellation workflow — ids of segments with a CONFIRMED
   * cancellation, passed straight through to FlightItineraryDisplay. */
  cancelledSegmentIds?: Set<string>;
  /** Exchange Fee + Fare Difference = Total Exchange Cost — shown as an
   * informational "Exchange Summary" block, additive to (never replacing)
   * the Price Summary below, since that's what actually drives the
   * payment-allocation UI and submitBooking()'s own charge amount; see the
   * comment on displayPricing above for why those two can't diverge.
   * Null/undefined (an ordinary quote, or an exchange where the agent
   * hasn't entered both figures yet) simply omits the block. */
  exchangeFee?: number | null;
  fareDifference?: number | null;
  /** Cancellation workflow — the confirmed request's fee, if any. */
  cancellationFee?: number | null;
  adults: number;
  childrenCount: number;
  infants: number;
  adultPrice: number;
  childPrice: number;
  infantPrice: number;
  taxes: number;
  serviceFee: number;
  /** Customer-facing currency for this quote (frozen at send). The actual
   * charge is always processed in USD — the "Amount to Charge (USD)"/"Full
   * booking total" figures below stay in USD, unchanged; this only affects
   * the DISPLAYED total the customer sees at the top of the price summary,
   * with a USD-equivalent note so it's never ambiguous which figure the
   * card is actually charged for. */
  currency: SupportedCurrency;
  exchangeRate: number;
  contactFirstName: string;
  contactPhone: string;
  contactEmail: string;
  /** The quote's own owning Company — never a hardcoded name. */
  companyName: string;
  /** Real, already-configured Company fields used to fill in the
   * Cancellation Policy / Terms & Conditions accordions below (see
   * lib/legal-content.ts) — never invented placeholder contact info.
   * Either may be null if the company hasn't configured them. */
  companyPhone?: string | null;
  companyWebsite?: string | null;
  /** Pass 13 §36/§37 — this contact's own most recent charged booking's
   * passengers (see getLastChargedBookingForContact — the query itself is
   * the security boundary, this component just renders what it's handed).
   * Prefills the form fields below but never locks them — every field
   * stays fully editable, matching §34's explicit "prefilled ≠ immutable"
   * requirement. Omitted (or empty) falls back to the existing blank-form
   * behavior unchanged. Matched to this booking's own adult/child/infant
   * counts positionally by type, not by identity — if the previous
   * booking had a different passenger count, only as many as line up are
   * prefilled; the rest start blank exactly as before.
   */
  previousPassengers?: Array<{
    firstName: string;
    middleName: string | null;
    lastName: string;
    type: "ADULT" | "CHILD" | "INFANT";
    dateOfBirth: Date | null;
    gender: string | null;
    tsaKnownTravelerNumber: string | null;
    globalEntryNumber: string | null;
  }>;
  /** Pass 24/25 — the explicit "select a previous passenger" convenience
   * for the NEW (non-exchange) booking form: every distinct person who's
   * ever traveled with this contact (see
   * getPreviousPassengersForContact — same server-derived, token-scoped
   * security boundary as `previousPassengers` above), offered as a
   * per-slot dropdown in PassengerForm. Selecting one is ONLY a
   * convenience — it populates the slot's fields once, and every field
   * remains fully editable afterward, same as the silent prefill above.
   * Omitted/empty (exchange bookings, or a customer with no prior
   * passengers) simply hides the selector. */
  previousPassengerOptions?: Array<{
    firstName: string;
    middleName: string | null;
    lastName: string;
    type: "ADULT" | "CHILD" | "INFANT";
    dateOfBirth: Date | null;
    gender: string | null;
    tsaKnownTravelerNumber: string | null;
    globalEntryNumber: string | null;
    frequentFlyerAirline: AirlineOption | null;
    frequentFlyerNumber: string | null;
  }>;
  /** Pass 25 §7-8 — same "select a previous X" convenience, scoped to the
   * NEW booking form only (see the query's own doc comment for the
   * contactId security boundary). Selecting an address fills every field
   * below but leaves every one fully editable, and a brand-new address is
   * always the default (never forced). */
  previousBillingAddresses?: Array<{
    billingAddress: string;
    billingApt: string | null;
    billingCity: string;
    billingState: string;
    billingZip: string;
    billingCountry: string;
  }>;
  /** Pass 25 §3-6/§14-16 — masked-only selector: cardholder name + last4 +
   * brand + expiry. NEVER a full card number or CVV — see
   * docs/PAYMENT_AUTOFILL_SECURITY.md for exactly why the full number
   * isn't (and can't safely be) offered here. Selecting an option
   * autofills only the customer-safe fields already in this list; the
   * card number and CVV always require manual entry. */
  previousPaymentMethods?: Array<{
    id: string;
    cardholderName: string;
    last4: string;
    cardBrand: string | null;
    expiryMonth: number;
    expiryYear: number;
  }>;
}) {
  const router = useRouter();
  const autofillBaseId = useId();
  const [passengers, setPassengers] = useState<PassengerFormState[]>(() => {
    // Pair each new blank slot with a same-type previous passenger, in
    // order — e.g. the 1st ADULT slot gets the 1st previous ADULT, the
    // 2nd ADULT slot gets the 2nd, etc. Never partially fills one field
    // from one previous passenger and another field from a different one.
    const remainingByType: Record<PassengerFormState["type"], typeof previousPassengers> = {
      ADULT: previousPassengers?.filter((p) => p.type === "ADULT") ?? [],
      CHILD: previousPassengers?.filter((p) => p.type === "CHILD") ?? [],
      INFANT: previousPassengers?.filter((p) => p.type === "INFANT") ?? [],
    };
    function withPrefill(type: PassengerFormState["type"]): PassengerFormState {
      const prev = remainingByType[type]?.shift();
      const blank = newPassenger(type);
      if (!prev) return blank;
      return {
        ...blank,
        firstName: prev.firstName,
        middleName: prev.middleName ?? "",
        lastName: prev.lastName,
        dateOfBirth: prev.dateOfBirth ? prev.dateOfBirth.toISOString().slice(0, 10) : "",
        gender: prev.gender ?? "",
        tsaKnownTravelerNumber: prev.tsaKnownTravelerNumber ?? "",
        globalEntryNumber: prev.globalEntryNumber ?? "",
      };
    }
    return [
      ...Array.from({ length: adults }, () => withPrefill("ADULT")),
      ...Array.from({ length: childrenCount }, () => withPrefill("CHILD")),
      ...Array.from({ length: infants }, () => withPrefill("INFANT")),
    ];
  });
  const presetPhone = contactPhone ? parsePhoneNumberFromString(contactPhone) : undefined;
  const [phoneCountry, setPhoneCountry] = useState<CountryCode>((presetPhone?.country as CountryCode) ?? DEFAULT_PHONE_COUNTRY);
  const [phoneNational, setPhoneNational] = useState(presetPhone ? presetPhone.formatNational() : contactPhone);
  const normalizedPhone = normalizePhoneNumber(phoneNational, phoneCountry);
  const [email, setEmail] = useState(contactEmail);
  const [billingAddress, setBillingAddress] = useState("");
  const [billingApt, setBillingApt] = useState("");
  const [billingCity, setBillingCity] = useState("");
  const [billingState, setBillingState] = useState("");
  const [billingZip, setBillingZip] = useState("");
  const [billingCountry, setBillingCountry] = useState("United States");
  const [cards, setCards] = useState<CardFormState[]>([EMPTY_CARD_FORM]);
  const [paymentConsent, setPaymentConsent] = useState(false);
  const [gratuity, setGratuity] = useState(0);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [signedName, setSignedName] = useState("");
  const [reviewMode, setReviewMode] = useState(false);
  const [isSubmitting, startSubmitting] = useTransition();

  const pricing = useMemo(
    () => calculatePricing({ adults, children: childrenCount, infants, adultPrice, childPrice, infantPrice, taxes, serviceFee, gratuity }),
    [adults, childrenCount, infants, adultPrice, childPrice, infantPrice, taxes, serviceFee, gratuity]
  );

  // The quote's own currency is the source of truth for everything the
  // customer sees and pays from here on — converted once from the live USD
  // total (including the gratuity the customer just picked) by the same
  // frozen exchange rate the quote was sent with. This IS the authoritative
  // amount: allocation, the actual card amount(s), and what gets submitted
  // to submitBooking() all use this, matching the server's own recompute
  // (see submitBooking's identical conversion) — never a second, possibly
  // drifting, USD-denominated total living alongside it.
  const displayPricing = useMemo(
    () => buildPricingSnapshot({ adultPrice, childPrice, infantPrice, taxes, serviceFee, gratuity, total: pricing.total }, currency, exchangeRate),
    [adultPrice, childPrice, infantPrice, taxes, serviceFee, gratuity, pricing.total, currency, exchangeRate]
  );

  // A single payment method always covers the whole booking — there's
  // nothing to split, so its amount is always exactly the live total
  // rather than something read out of (and kept in sync with) form state.
  // Once a second card is added, allocation becomes a real choice and each
  // card's own `amount` field is what's used instead.
  function amountFor(card: CardFormState): number {
    return cards.length === 1 ? displayPricing.total : Number(card.amount) || 0;
  }

  const totalAllocated = useMemo(
    () => (cards.length === 1 ? displayPricing.total : cards.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)),
    [cards, displayPricing.total]
  );
  const remaining = Math.round((displayPricing.total - totalAllocated) * 100) / 100;

  function validate(): string | null {
    for (const [i, p] of passengers.entries()) {
      if (!p.firstName || !p.lastName) return `Passenger ${i + 1}: first and last name are required`;
      if (!p.dateOfBirth) return `Passenger ${i + 1}: date of birth is required`;
      if (!p.gender) return `Passenger ${i + 1}: gender is required`;
    }
    if (!phoneNational) return "Contact phone is required";
    if (!normalizedPhone) return "Please enter a valid phone number for the selected country";
    if (!email) return "Contact email is required";
    if (!billingAddress || !billingCity || !billingState || !billingZip || !billingCountry) return "Billing address is incomplete";
    for (const [i, card] of cards.entries()) {
      const label = cards.length > 1 ? `Payment Method ${i + 1}: ` : "";
      if (!card.cardholderName.trim()) return `${label}Cardholder name is required`;
      if (!isValidCardNumber(card.cardNumber)) return `${label}Please enter a valid card number`;
      const brand = detectCardBrand(card.cardNumber);
      if (!isValidExpiry(Number(card.expiryMonth), Number(card.expiryYear))) return `${label}Please enter a valid expiration date`;
      if (!isValidCvvFormat(card.cvv, brand)) return `${label}Please enter a valid CVV`;
      if (amountFor(card) <= 0) return `${label}Please enter an amount to charge`;
    }
    if (Math.abs(remaining) > 0.01) {
      return remaining > 0
        ? `${formatMoney(remaining, currency)} of the total is not yet allocated to a payment method`
        : `Payment methods are overallocated by ${formatMoney(Math.abs(remaining), currency)}`;
    }
    if (!paymentConsent) return "Please authorize us to securely store your payment method";
    if (!termsAccepted) return "Please read and agree to the Cancellation Policy and Terms & Conditions to continue";
    if (!signedName.trim()) return "Please sign your name to continue";
    return null;
  }

  function addPaymentMethod() {
    setCards((prev) => [...prev, EMPTY_CARD_FORM]);
  }

  function removePaymentMethod(index: number) {
    setCards((prev) => prev.filter((_, i) => i !== index));
  }

  function updatePaymentMethod(index: number, next: CardFormState) {
    setCards((prev) => prev.map((c, i) => (i === index ? next : c)));
  }

  // Pass 25 §3-6/§14-16 — autofills ONLY the customer-safe fields already
  // in the selector list (cardholder name + expiry). The card number and
  // CVV are never touched — never returned by the query, so there is
  // nothing to autofill them WITH; the customer always types those in
  // manually. See docs/PAYMENT_AUTOFILL_SECURITY.md.
  function applyPreviousPaymentMethod(index: number, option: NonNullable<typeof previousPaymentMethods>[number]) {
    setCards((prev) =>
      prev.map((c, i) =>
        i === index
          ? { ...c, cardholderName: option.cardholderName, expiryMonth: String(option.expiryMonth).padStart(2, "0"), expiryYear: String(option.expiryYear) }
          : c
      )
    );
  }

  // Pass 25 §7-8 — a one-shot fill, every field stays fully editable
  // afterward, same contract as passenger/card autofill above.
  function applyPreviousBillingAddress(option: NonNullable<typeof previousBillingAddresses>[number]) {
    setBillingAddress(option.billingAddress);
    setBillingApt(option.billingApt ?? "");
    setBillingCity(option.billingCity);
    setBillingState(option.billingState);
    setBillingZip(option.billingZip);
    setBillingCountry(option.billingCountry);
  }

  function handleBookFlight() {
    const error = validate();
    if (error) {
      toast.error(error);
      return;
    }
    setReviewMode(true);
    requestAnimationFrame(() => {
      document.getElementById("review-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function handleFinishBooking() {
    const error = validate();
    if (error) {
      toast.error(error);
      return;
    }
    startSubmitting(async () => {
      const result = await submitBooking({
        token,
        passengers: passengers.map((p) => ({
          type: p.type,
          firstName: p.firstName,
          middleName: p.middleName || undefined,
          lastName: p.lastName,
          dateOfBirth: p.dateOfBirth,
          gender: p.gender,
          tsaKnownTravelerNumber: p.tsaKnownTravelerNumber || undefined,
          globalEntryNumber: p.globalEntryNumber || undefined,
          frequentFlyerAirline: p.frequentFlyerAirline?.name,
          frequentFlyerNumber: p.frequentFlyerNumber || undefined,
        })),
        contactPhone: normalizedPhone ?? phoneNational,
        contactEmail: email,
        billingAddress,
        billingApt: billingApt || undefined,
        billingCity,
        billingState,
        billingZip,
        billingCountry,
        paymentMethods: cards.map((c) => ({
          cardholderName: c.cardholderName,
          cardNumber: c.cardNumber,
          expiryMonth: Number(c.expiryMonth),
          expiryYear: Number(c.expiryYear),
          cvv: c.cvv,
          amount: amountFor(c),
        })),
        paymentConsent: true,
        gratuityAmount: gratuity,
        termsAccepted: true,
        signedName,
      });

      // The CVV (and, defensively, the full card number) never need to
      // exist in this component's state again after submission, whether
      // it succeeded or failed.
      setCards((prev) => prev.map((c) => ({ ...c, cardNumber: "", cvv: "" })));

      if (result.ok) {
        router.push(`/quote/${token}/confirmation`);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px] pb-28 lg:pb-0">
      <div className="space-y-6">
        {originalSegments && originalSegments.length > 0 && (
          <Card className="shadow-none">
            <CardHeader><CardTitle role="heading" aria-level={2} className="text-sm font-medium">Your Original Itinerary</CardTitle></CardHeader>
            <CardContent>
              <FlightItineraryDisplay segments={originalSegments} customerFacing />
            </CardContent>
          </Card>
        )}
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="text-sm font-medium">{originalSegments && originalSegments.length > 0 ? "Proposed Exchange Itinerary" : "Flight Itinerary"}</CardTitle>
          </CardHeader>
          <CardContent>
            <FlightItineraryDisplay segments={segments} customerFacing cancelledSegmentIds={cancelledSegmentIds} />
          </CardContent>
        </Card>

        {exchangeFee != null && fareDifference != null && (
          <Card className="shadow-none">
            <CardHeader><CardTitle role="heading" aria-level={2} className="text-sm font-medium">Exchange Summary</CardTitle></CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              <div className="flex justify-between text-muted-foreground"><span>Exchange Fee</span><span className="tabular-nums">{formatMoney(exchangeFee, currency)}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>Fare Difference</span><span className="tabular-nums">{formatMoney(fareDifference, currency)}</span></div>
              <div className="flex justify-between font-semibold text-foreground pt-2 border-t"><span>Total Exchange Cost</span><span className="tabular-nums">{formatMoney(exchangeFee + fareDifference, currency)}</span></div>
            </CardContent>
          </Card>
        )}

        {cancellationFee != null && (
          <Card className="shadow-none">
            <CardContent className="flex items-center justify-between pt-6">
              <span className="text-sm font-medium text-muted-foreground">Cancellation Fee</span>
              <span className="text-sm font-semibold text-foreground tabular-nums">{formatMoney(cancellationFee, currency)}</span>
            </CardContent>
          </Card>
        )}

        <Card className="shadow-none">
          <CardHeader><CardTitle role="heading" aria-level={2} className="text-sm font-medium">Passenger Information</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {passengers.map((p, i) => (
              <PassengerForm
                key={p.clientId}
                passenger={p}
                index={i}
                onChange={(next) => setPassengers((prev) => prev.map((x) => (x.clientId === p.clientId ? next : x)))}
                previousPassengerOptions={previousPassengerOptions}
              />
            ))}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader><CardTitle role="heading" aria-level={2} className="text-sm font-medium">Contact Information</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Phone *</Label>
              <PhoneInput
                country={phoneCountry}
                onCountryChange={setPhoneCountry}
                nationalNumber={phoneNational}
                onNationalNumberChange={setPhoneNational}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Email *</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader><CardTitle role="heading" aria-level={2} className="text-sm font-medium">Payment</CardTitle></CardHeader>
          <CardContent className="space-y-6">
            {cards.map((c, i) => {
              const cardAutofillId = `${autofillBaseId}-card-${i}`;
              return (
                <div key={i} className={i > 0 ? "pt-6 border-t" : undefined}>
                  {previousPaymentMethods && previousPaymentMethods.length > 0 && (
                    <div className="space-y-1.5 mb-3">
                      <Label htmlFor={cardAutofillId} className="text-xs font-normal text-muted-foreground">
                        Autofill from a previously used card (optional)
                      </Label>
                      <Select
                        value=""
                        onValueChange={(v) => {
                          const option = previousPaymentMethods.find((pm) => pm.id === v);
                          if (option) applyPreviousPaymentMethod(i, option);
                        }}
                      >
                        <SelectTrigger id={cardAutofillId} className="w-full"><SelectValue placeholder="Select a previous card…" /></SelectTrigger>
                        <SelectContent>
                          {previousPaymentMethods.map((pm) => (
                            <SelectItem key={pm.id} value={pm.id}>
                              {pm.cardBrand ?? "Card"} ending in {pm.last4} — {pm.cardholderName} — Exp {String(pm.expiryMonth).padStart(2, "0")}/{pm.expiryYear}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">You&apos;ll still need to enter the full card number and security code.</p>
                    </div>
                  )}
                  <CardPaymentSection
                    value={c}
                    onChange={(next) => updatePaymentMethod(i, next)}
                    label={cards.length > 1 ? `Payment Method ${i + 1}` : "Card Details"}
                    onRemove={cards.length > 1 ? () => removePaymentMethod(i) : undefined}
                    fixedAmount={cards.length === 1 ? displayPricing.total : undefined}
                    currency={currency}
                  />
                </div>
              );
            })}

            <Button type="button" variant="outline" className="w-full gap-1.5" onClick={addPaymentMethod}>
              <Plus className="h-4 w-4" /> Add another payment method
            </Button>

            {cards.length > 1 && (
              <div className="rounded-md bg-muted/30 px-3 py-2.5 text-sm space-y-1">
                <div className="flex justify-between text-muted-foreground"><span>Total booking amount</span><span>{formatMoney(displayPricing.total, currency)}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Allocated</span><span>{formatMoney(totalAllocated, currency)}</span></div>
                <div className={`flex justify-between font-medium ${Math.abs(remaining) > 0.01 ? "text-destructive" : "text-success"}`}>
                  <span>{remaining > 0.01 ? "Remaining" : remaining < -0.01 ? "Overallocated" : "Fully allocated"}</span>
                  <span>{formatMoney(Math.abs(remaining), currency)}</span>
                </div>
              </div>
            )}

            <PaymentConsentCheckbox checked={paymentConsent} onChange={setPaymentConsent} companyName={companyName} />
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader><CardTitle role="heading" aria-level={2} className="text-sm font-medium">Billing Address</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {previousBillingAddresses && previousBillingAddresses.length > 0 && (
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`${autofillBaseId}-billing`} className="text-xs font-normal text-muted-foreground">
                  Autofill from a previous address (optional)
                </Label>
                <Select
                  value=""
                  onValueChange={(v) => {
                    const option = previousBillingAddresses[Number(v)];
                    if (option) applyPreviousBillingAddress(option);
                  }}
                >
                  <SelectTrigger id={`${autofillBaseId}-billing`} className="w-full"><SelectValue placeholder="Select a previous address…" /></SelectTrigger>
                  <SelectContent>
                    {previousBillingAddresses.map((addr, addrIndex) => (
                      <SelectItem key={addrIndex} value={String(addrIndex)}>
                        {addr.billingAddress}{addr.billingApt ? `, ${addr.billingApt}` : ""}, {addr.billingCity}, {addr.billingState} {addr.billingZip}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Address *</Label>
              <Input value={billingAddress} onChange={(e) => setBillingAddress(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Apt / Suite</Label>
              <Input value={billingApt} onChange={(e) => setBillingApt(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>City *</Label>
              <Input value={billingCity} onChange={(e) => setBillingCity(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>State / Province *</Label>
              <Input value={billingState} onChange={(e) => setBillingState(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>ZIP / Postal Code *</Label>
              <Input value={billingZip} onChange={(e) => setBillingZip(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Country *</Label>
              <CountrySelect value={billingCountry} onChange={setBillingCountry} />
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader><CardTitle role="heading" aria-level={2} className="text-sm font-medium">Gratuity</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {GRATUITY_PRESETS.map((g) => (
                <Button
                  key={g}
                  type="button"
                  variant={gratuity === g ? "default" : "outline"}
                  className="flex-1 min-w-[64px]"
                  onClick={() => setGratuity(g)}
                >
                  {formatMoney(g, currency)}
                </Button>
              ))}
            </div>
            <div className="mt-3 space-y-1.5">
              <Label>Custom amount</Label>
              <Input type="number" min={0} value={gratuity} onChange={(e) => setGratuity(Number(e.target.value) || 0)} />
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="text-sm font-medium">Cancellation Policy &amp; Terms &amp; Conditions</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <LegalAgreementAccordion company={{ name: companyName, phone: companyPhone ?? null, website: companyWebsite ?? null }} />
          </CardContent>
          <CardContent className="pt-0 border-t">
            <label className="flex items-start gap-2 text-sm pt-4">
              <Checkbox
                checked={termsAccepted}
                onCheckedChange={(v) => setTermsAccepted(v === true)}
                aria-describedby="terms-agreement-label"
              />
              <span id="terms-agreement-label">I have read and agree to the Cancellation Policy and Terms &amp; Conditions.</span>
            </label>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader><CardTitle role="heading" aria-level={2} className="text-sm font-medium">Electronic Signature</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label>Type your full legal name</Label>
              <Input value={signedName} onChange={(e) => setSignedName(e.target.value)} placeholder={contactFirstName ? `e.g. ${contactFirstName} ...` : "Your full name"} />
            </div>
            {signedName && (
              <div className="rounded-md border bg-muted/30 px-4 py-6 flex items-center justify-center">
                <span className="font-serif italic text-2xl text-foreground" style={{ fontFamily: "'Brush Script MT', cursive" }}>
                  {signedName}
                </span>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground flex items-center gap-1">
              <PenLine className="h-3 w-3" /> Your typed name, timestamp, and IP address are recorded as your signature on this booking.
            </p>
          </CardContent>
        </Card>

        {!reviewMode && (
          <Button size="lg" className="w-full hidden lg:flex" onClick={handleBookFlight}>
            Book Flight
          </Button>
        )}

        {reviewMode && (
          <Card id="review-section" className="shadow-none border-primary/40">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle role="heading" aria-level={2} className="text-sm font-medium flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-primary" /> Review Your Booking
              </CardTitle>
              <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => setReviewMode(false)}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div>
                <p className="font-medium mb-1 text-foreground">Flight Itinerary</p>
                <p className="text-xs text-muted-foreground">{segments.length} flight{segments.length === 1 ? "" : "s"} as shown above</p>
              </div>
              <Separator />
              <div>
                <p className="font-medium mb-2 text-foreground">Passengers</p>
                <div className="space-y-3">
                  {passengers.map((p, i) => (
                    <div key={p.clientId} className="rounded-md bg-muted/30 px-3 py-2">
                      <p className="text-xs font-semibold text-muted-foreground mb-1">Passenger {i + 1} · {p.type}</p>
                      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                        <div className="flex gap-1"><dt className="text-muted-foreground">First Name:</dt><dd className="text-foreground">{p.firstName || "—"}</dd></div>
                        <div className="flex gap-1"><dt className="text-muted-foreground">Last Name:</dt><dd className="text-foreground">{p.lastName || "—"}</dd></div>
                        {p.middleName && <div className="flex gap-1"><dt className="text-muted-foreground">Middle Name:</dt><dd className="text-foreground">{p.middleName}</dd></div>}
                        {p.dateOfBirth && <div className="flex gap-1"><dt className="text-muted-foreground">Date of Birth:</dt><dd className="text-foreground">{p.dateOfBirth}</dd></div>}
                        {p.gender && <div className="flex gap-1"><dt className="text-muted-foreground">Gender:</dt><dd className="text-foreground">{p.gender}</dd></div>}
                      </dl>
                    </div>
                  ))}
                </div>
              </div>
              <Separator />
              <div>
                <p className="font-medium text-foreground">Contact Information</p>
                <p className="text-muted-foreground">Phone: {normalizedPhone ?? phoneNational}</p>
                <p className="text-muted-foreground break-words">Email: {email}</p>
              </div>
              <Separator />
              <div>
                <p className="font-medium text-foreground">Billing Address</p>
                <p className="text-muted-foreground">
                  {billingAddress}{billingApt ? `, ${billingApt}` : ""}, {billingCity}, {billingState} {billingZip}, {billingCountry}
                </p>
              </div>
              <Separator />
              <div>
                <p className="font-medium mb-1 text-foreground">Payment</p>
                <div className="space-y-1.5">
                  {cards.map((c, i) => (
                    <div key={i} className="flex items-center justify-between gap-2">
                      <PaymentBadge
                        cardBrand={detectCardBrand(c.cardNumber) === "Unknown" ? null : detectCardBrand(c.cardNumber)}
                        cardLast4={lastFour(c.cardNumber) || null}
                        expiryMonth={c.expiryMonth ? Number(c.expiryMonth) : null}
                        expiryYear={c.expiryYear ? Number(c.expiryYear) : null}
                      />
                      {cards.length > 1 && <span className="text-xs text-muted-foreground shrink-0">{formatMoney(Number(c.amount) || 0, currency)}</span>}
                    </div>
                  ))}
                </div>
              </div>
              <Separator />
              <div>
                <p className="font-medium text-foreground">Gratuity</p>
                <p className="text-muted-foreground">{formatMoney(gratuity, currency)}</p>
              </div>
              <Separator />
              <div>
                <p className="font-medium flex items-center gap-1.5 text-foreground">
                  Cancellation Policy &amp; Terms
                  {termsAccepted && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
                </p>
                <p className="text-muted-foreground">{termsAccepted ? "Agreed" : "Not agreed"}</p>
              </div>
              <Separator />
              <div>
                <p className="font-medium text-foreground">Signature</p>
                <p className="text-muted-foreground italic">{signedName}</p>
              </div>
              <Button size="lg" className="w-full mt-2" onClick={handleFinishBooking} disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Finish Booking
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="hidden lg:block">
        <Card className="shadow-none sticky top-6">
          <CardHeader><CardTitle role="heading" aria-level={2} className="text-sm font-medium">Price Summary</CardTitle></CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            <div className="flex justify-between text-muted-foreground"><span>Ticket cost</span><span>{formatMoney(displayPricing.adultPrice * adults + displayPricing.childPrice * childrenCount + displayPricing.infantPrice * infants, currency)}</span></div>
            {displayPricing.taxes > 0 && (
              <div className="flex justify-between text-muted-foreground"><span>Taxes</span><span>{formatMoney(displayPricing.taxes, currency)}</span></div>
            )}
            {displayPricing.serviceFee > 0 && (
              <div className="flex justify-between text-muted-foreground"><span>Service fee</span><span>{formatMoney(displayPricing.serviceFee, currency)}</span></div>
            )}
            <div className="flex justify-between text-muted-foreground"><span>Gratuity</span><span>{formatMoney(displayPricing.gratuity, currency)}</span></div>
            <div className="flex justify-between font-semibold text-base pt-2 border-t text-foreground"><span>Total</span><span>{formatMoney(displayPricing.total, currency)}</span></div>
            {!reviewMode && (
              <Button className="w-full mt-3" onClick={handleBookFlight}>Book Flight</Button>
            )}
          </CardContent>
        </Card>
      </div>

      {!reviewMode && (
        <div className="lg:hidden fixed bottom-0 inset-x-0 border-t bg-background p-4 flex items-center justify-between gap-4 z-40">
          <div>
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-lg font-semibold text-foreground">{formatMoney(displayPricing.total, currency)}</p>
          </div>
          <Button onClick={handleBookFlight}>Book Flight</Button>
        </div>
      )}
    </div>
  );
}
