"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Loader2, Send, Ban, Sparkles, Eye, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FlightSegmentEditor, SegmentConnector, type EditableSegment } from "@/components/quotes/flight-segment-editor";
import { FlightItineraryDisplay, type SegmentDisplay } from "@/components/quotes/flight-itinerary-display";
import { parseApolloItinerary } from "@/lib/parsers/apollo";
import { parseSabreItinerary } from "@/lib/parsers/sabre";
import { hydrateParsedSegments } from "@/lib/itinerary-parse-hydration";
import { calculatePricing, GRATUITY_PRESETS } from "@/lib/pricing";
import { sendExchangeForApproval } from "@/server/actions/exchange";
import {
  SUPPORTED_CURRENCIES,
  CURRENCY_LABELS,
  DEFAULT_EXCHANGE_RATES,
  convertToUsd,
  convertAmount,
  resolveExchangeRate,
  formatMoney,
  type SupportedCurrency,
} from "@/lib/currency";
import { calculateFlightDurationMinutes } from "@/lib/flight-duration";

function emptySegment(defaultCabin: EditableSegment["cabin"]): EditableSegment {
  return {
    clientId: crypto.randomUUID(),
    departureAirport: null,
    arrivalAirport: null,
    departureDate: "",
    departureTime: "",
    arrivalDate: "",
    arrivalTime: "",
    airline: null,
    airlineCodeRaw: "",
    flightNumber: "",
    bookingClass: "",
    cabin: defaultCabin,
    aircraft: null,
    aircraftRaw: "",
    operatingCarrierName: "",
    warnings: [],
    uncertainFields: [],
    isExtraLeg: false,
    durationOverrideMinutes: null,
  };
}

const TRIP_TYPES = [
  { value: "ROUND_TRIP", label: "Round Trip" },
  { value: "ONE_WAY", label: "One Way" },
  { value: "MULTI_CITY", label: "Multi City" },
] as const;

/**
 * The exchange itinerary workflow — deliberately its own component rather
 * than a fork of QuoteBuilder (which is tightly coupled to leadId-based
 * creation + its own Save Draft/Send Quote logic): it reuses every SHARED
 * primitive QuoteBuilder itself uses (FlightSegmentEditor, SegmentConnector,
 * calculatePricing, currency helpers, the parser functions themselves, and
 * now hydrateParsedSegments — the same paste-hydration logic QuoteBuilder
 * uses) so the itinerary-entry UX is identical including Manual Entry /
 * Sabre/SWAN / Apollo, but has its own submit (sendExchangeForApproval) and
 * its own Exchange Fee/Fare Difference/PNR/Internal Notes fields.
 *
 * Nothing is persisted until "Send for Approval" — "Cancel Exchange" is
 * simply navigating away; the original charged quote is never touched
 * unless/until this component's one server action call succeeds.
 */
export function ExchangeBuilder({
  originalQuoteId,
  originalQuoteNumber,
  originalSegments,
  supersedesQuoteId,
  referenceLabel = "Original Itinerary",
  defaultTripType,
  defaultCabin,
  defaultAdults,
  defaultChildren,
  defaultInfants,
}: {
  originalQuoteId: string;
  originalQuoteNumber: string;
  originalSegments: SegmentDisplay[];
  // Pass 26 — when set, "Send for Approval" below revises this existing
  // proposal (sendExchangeForApproval's own revision path) instead of
  // proposing the first-ever exchange against originalQuoteId. Always the
  // id of the CURRENT proposal in the chain — re-verified server-side.
  supersedesQuoteId?: string;
  // Pass 26 — the reference card's heading, so a revision can honestly read
  // "Previous Proposal — Q-XXXX" instead of "Original Itinerary" while
  // still showing originalSegments (in that case, the previous proposal's
  // own itinerary — see quotes/exchange/new/page.tsx's referenceQuote).
  referenceLabel?: string;
  defaultTripType: "ONE_WAY" | "ROUND_TRIP" | "MULTI_CITY";
  defaultCabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  defaultAdults: number;
  defaultChildren: number;
  defaultInfants: number;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("manual");
  const [source, setSource] = useState<"MANUAL" | "SABRE" | "APOLLO">("MANUAL");
  const [tripType, setTripType] = useState<string>(defaultTripType);
  const [segments, setSegments] = useState<EditableSegment[]>([emptySegment(defaultCabin)]);
  const [isParsing, startParsing] = useTransition();
  const [isSaving, startSaving] = useTransition();

  // Separate paste buffers per GDS source — see quote-builder.tsx's
  // identical comment for why a single shared pasteText state let stale
  // text from one tab bleed into a parse on the other.
  const [sabrePasteText, setSabrePasteText] = useState("");
  const [apolloPasteText, setApolloPasteText] = useState("");
  const [referenceYear, setReferenceYear] = useState(new Date().getFullYear());
  const parseRequestRef = useRef(0);

  const [adults, setAdults] = useState(defaultAdults);
  const [children, setChildren] = useState(defaultChildren);
  const [infants, setInfants] = useState(defaultInfants);
  const [childPrice, setChildPrice] = useState("");
  const [infantPrice, setInfantPrice] = useState("");
  const [taxes, setTaxes] = useState("");
  const [serviceFee, setServiceFee] = useState("");
  const [gratuity, setGratuity] = useState("0");
  const [currency, setCurrency] = useState<SupportedCurrency>("USD");
  const [exchangeRate, setExchangeRate] = useState(String(DEFAULT_EXCHANGE_RATES.CAD));
  const [terms, setTerms] = useState(
    "All fares are subject to airline rules and availability at the time of booking. Fare quotes are valid for 24 hours unless otherwise noted."
  );

  // Exchange-specific — never customer-facing (Exchange Fee/Fare Difference
  // below ARE customer-facing; PNR/Internal Notes are not).
  const [exchangeFee, setExchangeFee] = useState("");
  const [fareDifference, setFareDifference] = useState("");
  // Pass 13 §22/§23/§24 — the STAFF-ONLY actual cost of this exchange,
  // tracked entirely separately from the customer-facing Exchange
  // Fee/Fare Difference above. Never read by totalExchangeInCustomerCurrency
  // or any customer-facing total — that calculation uses ONLY exchangeFee/
  // fareDifference, by construction (see its own comment below).
  const [internalExchangeFee, setInternalExchangeFee] = useState("");
  const [internalFareDifference, setInternalFareDifference] = useState("");
  const [pnr, setPnr] = useState("");
  const [internalNotes, setInternalNotes] = useState("");

  // Part 2/4/5 — Total Exchange = Exchange Fee + Fare Difference, entered
  // directly in the customer-facing `currency` selected below (never
  // converted on entry — same convention the customer-facing pages already
  // use for these two fields). Adult Price, by contrast, is tracked
  // internally in USD like every other quote price field — so it can never
  // be "set equal" to Total Exchange by simply copying the number; the
  // two are in different currencies whenever `currency !== "USD"`. Instead,
  // Adult Price is DERIVED here by converting Total Exchange back to USD
  // (reusing the same convertToUsd/resolveExchangeRate primitives
  // currency.ts already provides for exactly this reverse-conversion need)
  // and dividing by the passenger count, so calculatePricing's existing
  // `adults × adultPrice` multiplication reconstructs the exact flat Total
  // Exchange amount regardless of headcount — no changes needed anywhere
  // downstream (calculatePricing, submitBooking, convertBookingPricing,
  // every customer-facing renderer keep receiving an ordinary adultPrice
  // USD number exactly as before). This can never silently diverge from
  // Total Exchange because it's computed FROM it, not entered separately.
  const totalExchangeInCustomerCurrency = (Number(exchangeFee) || 0) + (Number(fareDifference) || 0);
  const rate = resolveExchangeRate(currency, currency === "USD" ? null : Number(exchangeRate) || null);
  const adultPriceUsd = useMemo(() => {
    const totalUsd = convertToUsd(totalExchangeInCustomerCurrency, rate);
    return adults > 0 ? totalUsd / adults : totalUsd;
  }, [totalExchangeInCustomerCurrency, rate, adults]);

  const pricing = useMemo(
    () =>
      calculatePricing({
        adults,
        children,
        infants,
        adultPrice: adultPriceUsd,
        childPrice: Number(childPrice) || 0,
        infantPrice: Number(infantPrice) || 0,
        taxes: Number(taxes) || 0,
        serviceFee: Number(serviceFee) || 0,
        gratuity: Number(gratuity) || 0,
      }),
    [adults, children, infants, adultPriceUsd, childPrice, infantPrice, taxes, serviceFee, gratuity]
  );

  function addSegment() {
    setSegments((prev) => [...prev, emptySegment(defaultCabin)]);
  }
  function removeSegment(clientId: string) {
    setSegments((prev) => prev.filter((s) => s.clientId !== clientId));
  }
  function updateSegment(clientId: string, next: EditableSegment) {
    setSegments((prev) => prev.map((s) => (s.clientId === clientId ? next : s)));
  }

  function runParse(kind: "SABRE" | "APOLLO") {
    const pasteText = kind === "SABRE" ? sabrePasteText : apolloPasteText;
    if (!pasteText.trim()) {
      toast.error("Paste itinerary text first");
      return;
    }
    const requestId = ++parseRequestRef.current;
    startParsing(async () => {
      try {
        const today = new Date();
        const parsed = kind === "SABRE" ? parseSabreItinerary(pasteText, referenceYear, today) : parseApolloItinerary(pasteText, referenceYear, today);
        if (parsed.length === 0) {
          if (requestId === parseRequestRef.current) toast.error("Couldn't find any flight segments in the pasted text");
          return;
        }
        const hydrated = await hydrateParsedSegments(parsed, defaultCabin);
        if (requestId !== parseRequestRef.current) return; // superseded by a newer parse
        setSegments(hydrated);
        setSource(kind);
        setActiveTab("manual");
        const uncertainCount = hydrated.reduce((sum, s) => sum + s.uncertainFields.length, 0);
        toast.success(
          `Parsed ${hydrated.length} flight segment${hydrated.length === 1 ? "" : "s"}` +
            (uncertainCount > 0 ? ` — ${uncertainCount} field${uncertainCount === 1 ? "" : "s"} highlighted for review` : "")
        );
      } catch (err) {
        if (requestId === parseRequestRef.current) toast.error("Failed to parse itinerary — please check the pasted text and try again");
        console.error(err);
      }
    });
  }

  function validateSegments(): string | null {
    for (const [i, s] of segments.entries()) {
      if (!s.departureAirport || !s.arrivalAirport) return `Flight ${i + 1}: departure and arrival airports are required`;
      if (!s.departureDate || !s.departureTime) return `Flight ${i + 1}: departure date and time are required`;
      if (!s.arrivalDate || !s.arrivalTime) return `Flight ${i + 1}: arrival date and time are required`;
      if (!s.flightNumber) return `Flight ${i + 1}: flight number is required`;
    }
    if (totalExchangeInCustomerCurrency <= 0) return "Enter an Exchange Fee and/or Fare Difference before sending for approval";
    // Defense-in-depth (Part 4's explicit ask): confirm Adult Price × Adults,
    // converted back to the customer's currency, still exactly reproduces
    // Total Exchange — structurally guaranteed by the derivation above, but
    // checked anyway in case a future change reintroduces drift, with a
    // cent-level tolerance for rounding (same tolerance convention already
    // used by booking-flow.tsx's own payment-allocation reconciliation).
    const reconvertedTotal = convertAmount(adultPriceUsd * adults, rate);
    if (Math.abs(reconvertedTotal - totalExchangeInCustomerCurrency) > 0.01) {
      return "Adult Price and Total Exchange don't match — please re-check the Exchange Fee and Fare Difference";
    }
    return null;
  }

  function handleSendForApproval() {
    const error = validateSegments();
    if (error) {
      toast.error(error);
      return;
    }
    startSaving(async () => {
      try {
        const { exchangeQuoteId } = await sendExchangeForApproval({
          originalQuoteId,
          supersedesQuoteId,
          tripType: tripType as "ONE_WAY" | "ROUND_TRIP" | "MULTI_CITY",
          source,
          segments: segments.map((s, i) => {
            const depAt = `${s.departureDate}T${s.departureTime}:00`;
            const arrAt = `${s.arrivalDate}T${s.arrivalTime}:00`;
            // Part 3 — an agent-entered override wins over the auto-
            // calculated value at save time (see flight-segment-editor.tsx).
            const durationMinutes = s.durationOverrideMinutes ?? calculateFlightDurationMinutes(depAt, s.departureAirport?.timezone, arrAt, s.arrivalAirport?.timezone);
            return {
              sequence: i + 1,
              departureAirportId: s.departureAirport!.id,
              arrivalAirportId: s.arrivalAirport!.id,
              departureAt: depAt,
              arrivalAt: arrAt,
              airlineId: s.airline?.id,
              airlineCodeRaw: s.airlineCodeRaw || undefined,
              flightNumber: s.flightNumber,
              bookingClass: s.bookingClass || undefined,
              cabin: s.cabin,
              aircraftTypeId: s.aircraft?.id,
              aircraftRaw: s.aircraftRaw || undefined,
              operatingCarrierName: s.operatingCarrierName || undefined,
              durationMinutes,
              connectionType: i > 0 ? s.connectionType : undefined,
              isExtraLeg: s.isExtraLeg,
            };
          }),
          adults,
          children,
          infants,
          adultPrice: adultPriceUsd,
          childPrice: Number(childPrice) || 0,
          infantPrice: Number(infantPrice) || 0,
          taxes: Number(taxes) || 0,
          serviceFee: Number(serviceFee) || 0,
          gratuity: Number(gratuity) || 0,
          currency,
          exchangeRate: currency === "USD" ? undefined : Number(exchangeRate) || undefined,
          termsAndConditions: terms,
          exchangeFee: exchangeFee ? Number(exchangeFee) : undefined,
          fareDifference: fareDifference ? Number(fareDifference) : undefined,
          internalExchangeFee: internalExchangeFee ? Number(internalExchangeFee) : undefined,
          internalFareDifference: internalFareDifference ? Number(internalFareDifference) : undefined,
          pnr: pnr || undefined,
          internalNotes: internalNotes || undefined,
        });
        toast.success(supersedesQuoteId ? "Revised exchange proposal sent for approval" : "Exchange sent for approval");
        router.push(`/quotes/${exchangeQuoteId}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to submit the exchange request");
      }
    });
  }

  function handleCancelExchange() {
    // Nothing was ever persisted — this is purely a client-side
    // navigation, matching the "Cancel Exchange closes the workflow
    // without changing the original charged quote" requirement exactly.
    // For a revision, back to the proposal being revised (still fully
    // intact and untouched) rather than the true original.
    router.push(`/quotes/${supersedesQuoteId ?? originalQuoteId}`);
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-5">
        <Card className="shadow-none border-primary/30">
          <CardHeader>
            <CardTitle className="text-sm font-medium">{referenceLabel} — {originalQuoteNumber}</CardTitle>
          </CardHeader>
          <CardContent>
            {originalSegments.length > 0 ? (
              <FlightItineraryDisplay segments={originalSegments} />
            ) : (
              <p className="text-sm text-muted-foreground">No original itinerary on file.</p>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Proposed Exchange Itinerary</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="manual">Manual Entry</TabsTrigger>
                <TabsTrigger value="sabre">Sabre / SWAN</TabsTrigger>
                <TabsTrigger value="apollo">Apollo</TabsTrigger>
              </TabsList>

              <TabsContent value="manual" className="pt-4 space-y-4">
                <div className="space-y-1.5 max-w-xs">
                  <Label>Trip Type</Label>
                  <Select value={tripType} onValueChange={setTripType}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TRIP_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                {segments.map((seg, i) => (
                  <div key={seg.clientId} className={tripType === "MULTI_CITY" && i > 0 ? "pt-4 mt-2 border-t border-dashed" : undefined}>
                    {i > 0 && (
                      <SegmentConnector
                        value={seg.connectionType}
                        onChange={(v) => updateSegment(seg.clientId, { ...seg, connectionType: v })}
                        previousSegment={segments[i - 1]}
                        currentSegment={seg}
                      />
                    )}
                    <FlightSegmentEditor
                      segment={seg}
                      index={i}
                      onChange={(next) => updateSegment(seg.clientId, next)}
                      onRemove={() => removeSegment(seg.clientId)}
                      canRemove={segments.length > 1}
                    />
                  </div>
                ))}

                <Button variant="outline" onClick={addSegment} className="gap-2">
                  <Plus className="h-4 w-4" /> Add Another Flight
                </Button>
              </TabsContent>

              <TabsContent value="sabre" className="pt-4 space-y-3">
                <p className="text-sm text-muted-foreground">Paste a Sabre/SWAN itinerary display below and click Parse.</p>
                <div className="flex items-center gap-2">
                  <Label className="text-xs">Reference year</Label>
                  <Input
                    type="number"
                    value={referenceYear}
                    onChange={(e) => setReferenceYear(Number(e.target.value))}
                    className="w-24 h-8"
                  />
                </div>
                <Textarea
                  value={sabrePasteText}
                  onChange={(e) => setSabrePasteText(e.target.value)}
                  rows={8}
                  className="font-mono text-xs"
                  placeholder={"1 LH400C 12MAR FRA-JFK HK1 1050A 130P TH"}
                />
                <Button onClick={() => runParse("SABRE")} disabled={isParsing} className="gap-2">
                  {isParsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Parse Itinerary
                </Button>
              </TabsContent>

              <TabsContent value="apollo" className="pt-4 space-y-3">
                <p className="text-sm text-muted-foreground">Paste an Apollo itinerary display below and click Parse.</p>
                <div className="flex items-center gap-2">
                  <Label className="text-xs">Reference year</Label>
                  <Input
                    type="number"
                    value={referenceYear}
                    onChange={(e) => setReferenceYear(Number(e.target.value))}
                    className="w-24 h-8"
                  />
                </div>
                <Textarea
                  value={apolloPasteText}
                  onChange={(e) => setApolloPasteText(e.target.value)}
                  rows={8}
                  className="font-mono text-xs"
                  placeholder={"1 BA1460Y 25SEP LHREDI SS1 600P 725P * FR E"}
                />
                <Button onClick={() => runParse("APOLLO")} disabled={isParsing} className="gap-2">
                  {isParsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Parse Itinerary
                </Button>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Terms & Conditions</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={3} />
          </CardContent>
        </Card>

        <Card className="shadow-none border-dashed">
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              Exchange Details
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground bg-muted rounded px-1.5 py-0.5">Staff only</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Pass 14 §30 — the two financial sections below now carry a
                real visual distinction, not just a text label: "Customer
                Pricing" uses the same primary/blue tint used for
                customer-facing surfaces elsewhere in this app, with an Eye
                icon; "Internal Cost" uses a warning/amber tint with a Lock
                icon, matching the red/amber "internal, handle carefully"
                language already established for cancellation warnings. A
                colorblind or grayscale viewer still gets the icon + heading
                text, so color is never the only signal. */}
            <div className="rounded-md border border-primary/25 bg-primary/[0.04] p-2.5 space-y-2">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                <Eye className="h-3 w-3" /> Customer Pricing — shown on the quote and booking form
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  {/* Tracked in this exchange's own customer-facing currency
                      (the "Customer-facing currency" select below) — labeled
                      explicitly so it's never ambiguous for a non-USD quote. */}
                  <Label className="text-xs">Exchange Fee ({currency})</Label>
                  <Input type="number" min="0" step="0.01" value={exchangeFee} onChange={(e) => setExchangeFee(e.target.value)} placeholder="0.00" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Fare Difference ({currency})</Label>
                  <Input type="number" step="0.01" value={fareDifference} onChange={(e) => setFareDifference(e.target.value)} placeholder="0.00" />
                </div>
              </div>
              <div className="flex justify-between font-semibold text-sm rounded-md bg-background border px-2.5 py-2">
                <span>Total Exchange (customer pays)</span>
                <span className="tabular-nums">{formatMoney(totalExchangeInCustomerCurrency, currency)}</span>
              </div>
            </div>

            {/* Pass 13 §22/§23/§24, Pass 14 §30 — the actual internal cost,
                kept deliberately, visibly separate from the customer-facing
                fields above: a distinct warning tint (not just a dashed
                border) so an agent can never mistake one section for the
                other, and this section's values never feed the customer
                total. Deliberately sized/toned to stay secondary — a caution
                accent, not a large or alarming block that would dominate
                the builder. */}
            <div className="rounded-md border border-warning/30 bg-warning/[0.07] p-2.5 space-y-2">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning-foreground">
                <Lock className="h-3 w-3" /> Internal Cost — never shown to the customer
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Internal Exchange Fee (USD)</Label>
                  <Input type="number" min="0" step="0.01" value={internalExchangeFee} onChange={(e) => setInternalExchangeFee(e.target.value)} placeholder="0.00" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Internal Fare Difference (USD)</Label>
                  <Input type="number" step="0.01" value={internalFareDifference} onChange={(e) => setInternalFareDifference(e.target.value)} placeholder="0.00" />
                </div>
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
              PNR Information and Internal Notes below are also never shown to the customer — not on the quote page, booking form, or any customer email.
            </p>

            <div className="space-y-1.5">
              <Label className="text-xs">PNR Information</Label>
              <Input value={pnr} onChange={(e) => setPnr(e.target.value)} placeholder="Internal only" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Internal Notes</Label>
              <Textarea value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} rows={3} placeholder="Supplier, fare rules, internal booking info..." />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-5">
        <Card className="shadow-none sticky top-20">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Passengers & Pricing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Adults</Label>
                <Input type="number" min={1} value={adults} onChange={(e) => setAdults(Number(e.target.value))} className="h-8" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Children</Label>
                <Input type="number" min={0} value={children} onChange={(e) => setChildren(Number(e.target.value))} className="h-8" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Infants</Label>
                <Input type="number" min={0} value={infants} onChange={(e) => setInfants(Number(e.target.value))} className="h-8" />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <Label className="text-xs">Adult price (USD, auto)</Label>
                <span className="h-8 flex items-center px-2 text-sm font-medium tabular-nums text-muted-foreground" title="Automatically calculated from Exchange Fee + Fare Difference — see Exchange Details below">
                  ${adultPriceUsd.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <Label className="text-xs">Child price</Label>
                <Input type="number" value={childPrice} onChange={(e) => setChildPrice(e.target.value)} className="h-8 w-28 text-right" placeholder="0.00" />
              </div>
              <div className="flex items-center justify-between text-sm">
                <Label className="text-xs">Infant price</Label>
                <Input type="number" value={infantPrice} onChange={(e) => setInfantPrice(e.target.value)} className="h-8 w-28 text-right" placeholder="0.00" />
              </div>
              <div className="flex items-center justify-between text-sm">
                <Label className="text-xs">Taxes</Label>
                <Input type="number" value={taxes} onChange={(e) => setTaxes(e.target.value)} className="h-8 w-28 text-right" placeholder="0.00" />
              </div>
              <div className="flex items-center justify-between text-sm">
                <Label className="text-xs">Service fee</Label>
                <Input type="number" value={serviceFee} onChange={(e) => setServiceFee(e.target.value)} className="h-8 w-28 text-right" placeholder="0.00" />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Adult price is automatically calculated from Exchange Fee + Fare Difference (below) so it can never drift from what the customer is shown — enter those two fields to set it. Child/Infant price, Taxes, and Service Fee stay independently editable for any additional charge on top.
            </p>

            <div className="space-y-1.5">
              <Label className="text-xs">Gratuity</Label>
              <div className="flex gap-1.5">
                {GRATUITY_PRESETS.map((g) => (
                  <Button
                    key={g}
                    type="button"
                    size="sm"
                    variant={Number(gratuity) === g ? "default" : "outline"}
                    onClick={() => setGratuity(String(g))}
                    className="flex-1"
                  >
                    ${g}
                  </Button>
                ))}
              </div>
              <Input type="number" value={gratuity} onChange={(e) => setGratuity(e.target.value)} className="h-8" placeholder="Custom amount" />
            </div>

            <div className="border-t pt-3 space-y-1.5 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Ticket subtotal</span>
                <span>${pricing.ticketSubtotal.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Taxes</span>
                <span>${pricing.taxes.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Service fee</span>
                <span>${pricing.serviceFee.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Gratuity</span>
                <span>${pricing.gratuity.toLocaleString()}</span>
              </div>
              <div className="flex justify-between font-semibold text-base pt-1.5 border-t">
                <span>Total</span>
                <span>${pricing.total.toLocaleString()}</span>
              </div>
            </div>

            <div className="border-t pt-3 space-y-2">
              <Label className="text-xs">Customer-facing currency</Label>
              <Select
                value={currency}
                onValueChange={(v) => {
                  const next = v as SupportedCurrency;
                  setCurrency(next);
                  setExchangeRate(String(DEFAULT_EXCHANGE_RATES[next]));
                }}
              >
                <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SUPPORTED_CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>{CURRENCY_LABELS[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {currency !== "USD" && (
                <div className="flex items-center justify-between text-sm">
                  <Label className="text-xs">Exchange rate (1 USD =)</Label>
                  <Input type="number" step="0.0001" value={exchangeRate} onChange={(e) => setExchangeRate(e.target.value)} className="h-8 w-28 text-right" />
                </div>
              )}
              {/* Customer sees Total Exchange directly in the selected
                  currency — exchangeFee/fareDifference are entered in that
                  currency already, never converted, so this is not a
                  re-conversion of the USD ledger above (unlike a normal
                  quote's own "Customer sees" preview) — it's simply
                  restating the Total Exchange figure from the Exchange
                  Details card for visibility right where the currency is
                  chosen. */}
              <div className="flex justify-between font-semibold text-sm rounded-md bg-muted/40 px-2.5 py-2">
                <span>Customer sees (Total Exchange)</span>
                {/* Pass 28 — totalExchangeInCustomerCurrency = exchangeFee +
                    fareDifference, and fareDifference may legitimately be
                    negative (a lower-priced replacement fare — see
                    Quote.fareDifference's own schema doc comment). The
                    previous `${symbol}${n.toLocaleString(...)}` pattern
                    rendered a negative total as e.g. "$-50.00" instead of
                    "-$50.00" — the same sign-placement bug already fixed
                    at the source in formatMoney; this was a second,
                    independent hand-rolled formatter reproducing it. */}
                <span className="tabular-nums">{formatMoney(totalExchangeInCustomerCurrency, currency)}</span>
              </div>
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <Button variant="outline" onClick={handleCancelExchange} disabled={isSaving} className="gap-2">
                <Ban className="h-4 w-4" /> Cancel Exchange
              </Button>
              <Button onClick={handleSendForApproval} disabled={isSaving} className="gap-2">
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Send for Approval
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
