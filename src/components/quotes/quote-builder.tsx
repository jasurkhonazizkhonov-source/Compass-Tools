"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Loader2, Sparkles, Save, Send } from "lucide-react";
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
import { parseApolloItinerary } from "@/lib/parsers/apollo";
import { parseSabreItinerary } from "@/lib/parsers/sabre";
import { hydrateParsedSegments } from "@/lib/itinerary-parse-hydration";
import { calculatePricing, GRATUITY_PRESETS } from "@/lib/pricing";
import { createQuote } from "@/server/actions/quotes";
import { sendQuote } from "@/server/actions/quotes";
import { SUPPORTED_CURRENCIES, CURRENCY_LABELS, DEFAULT_EXCHANGE_RATES, buildPricingSnapshot, formatMoney, type SupportedCurrency } from "@/lib/currency";
import { calculateFlightDurationMinutes } from "@/lib/flight-duration";

function emptySegment(): EditableSegment {
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
    cabin: "ECONOMY",
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

export function QuoteBuilder({
  leadId,
  defaultTripType,
  defaultCabin,
  defaultAdults,
  defaultChildren,
  defaultInfants,
}: {
  leadId: string;
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
  const [segments, setSegments] = useState<EditableSegment[]>([
    { ...emptySegment(), cabin: defaultCabin },
  ]);
  const [isParsing, startParsing] = useTransition();
  const [isSaving, startSaving] = useTransition();

  // Separate paste buffers per GDS source — previously a single shared
  // `pasteText` state was bound to both the Sabre/SWAN and Apollo
  // textareas, so switching tabs after a parse left the OTHER tab's
  // textarea still showing the just-parsed text; pasting into it without
  // first clearing could concatenate the old and new itinerary text into
  // one nonsensical parse. Keeping them independent makes that
  // structurally impossible rather than relying on the user to clear the
  // field first.
  const [sabrePasteText, setSabrePasteText] = useState("");
  const [apolloPasteText, setApolloPasteText] = useState("");
  const [referenceYear, setReferenceYear] = useState(new Date().getFullYear());
  // Guards against a slower, earlier parse resolving AFTER a faster, later
  // one and overwriting its result — see runParse().
  const parseRequestRef = useRef(0);

  const [adults, setAdults] = useState(defaultAdults);
  const [children, setChildren] = useState(defaultChildren);
  const [infants, setInfants] = useState(defaultInfants);
  const [adultPrice, setAdultPrice] = useState("");
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
  const [internalNotes, setInternalNotes] = useState("");
  const [netTicketCost, setNetTicketCost] = useState("");

  const pricing = useMemo(
    () =>
      calculatePricing({
        adults,
        children,
        infants,
        adultPrice: Number(adultPrice) || 0,
        childPrice: Number(childPrice) || 0,
        infantPrice: Number(infantPrice) || 0,
        taxes: Number(taxes) || 0,
        serviceFee: Number(serviceFee) || 0,
        gratuity: Number(gratuity) || 0,
      }),
    [adults, children, infants, adultPrice, childPrice, infantPrice, taxes, serviceFee, gratuity]
  );

  const convertedPricing = useMemo(
    () =>
      buildPricingSnapshot(
        {
          adultPrice: Number(adultPrice) || 0,
          childPrice: Number(childPrice) || 0,
          infantPrice: Number(infantPrice) || 0,
          taxes: pricing.taxes,
          serviceFee: pricing.serviceFee,
          gratuity: pricing.gratuity,
          total: pricing.total,
        },
        currency,
        Number(exchangeRate) || 1
      ),
    [pricing, adultPrice, childPrice, infantPrice, currency, exchangeRate]
  );

  function addSegment() {
    setSegments((prev) => [...prev, { ...emptySegment(), cabin: defaultCabin }]);
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
    // Stamp this call with a request id and only ever apply its result if
    // it's still the most recent call by the time it resolves. isParsing
    // already disables both Parse buttons for the duration of a pending
    // parse, so this shouldn't be reachable in normal use — but it's a
    // cheap, structural guarantee that an older, slower parse can never
    // clobber a newer one's result, rather than relying solely on button
    // disabling to prevent overlap.
    const requestId = ++parseRequestRef.current;
    startParsing(async () => {
      try {
        // today enables the "already-past-this-year rolls to next year"
        // correction (see parseGdsItinerary) — an explicit embedded year in
        // the pasted text always overrides it and is never second-guessed.
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
    if (!adultPrice) return "Adult price is required";
    return null;
  }

  function buildPayload() {
    return {
      leadId,
      source,
      tripType: tripType as "ONE_WAY" | "ROUND_TRIP" | "MULTI_CITY",
      segments: segments.map((s, i) => {
        const depAt = `${s.departureDate}T${s.departureTime}:00`;
        const arrAt = `${s.arrivalDate}T${s.arrivalTime}:00`;
        // Part 3 — an agent-entered duration override wins over the
        // auto-calculated value at save time; auto-calculated stays the
        // default whenever no override is set (durationOverrideMinutes is
        // cleared back to null the instant any date/time field is edited
        // again — see flight-segment-editor.tsx's set()).
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
      adultPrice: Number(adultPrice) || 0,
      childPrice: Number(childPrice) || 0,
      infantPrice: Number(infantPrice) || 0,
      taxes: Number(taxes) || 0,
      serviceFee: Number(serviceFee) || 0,
      gratuity: Number(gratuity) || 0,
      currency,
      exchangeRate: currency === "USD" ? undefined : Number(exchangeRate) || undefined,
      termsAndConditions: terms,
      internalNotes: internalNotes || undefined,
      netTicketCost: netTicketCost ? Number(netTicketCost) : undefined,
    };
  }

  function handleSave(alsoSend: boolean) {
    const error = validateSegments();
    if (error) {
      toast.error(error);
      return;
    }
    startSaving(async () => {
      try {
        const { quoteId } = await createQuote(buildPayload());
        if (alsoSend) {
          const result = await sendQuote(quoteId);
          if (!result.ok) {
            toast.error(`Quote saved as draft, but sending failed: ${result.error}`);
            router.push(`/quotes/${quoteId}`);
            return;
          }
          toast.success("Quote sent to customer");
        } else {
          toast.success("Quote saved as draft");
        }
        router.push(`/quotes/${quoteId}`);
      } catch (err) {
        toast.error("Failed to save quote");
        console.error(err);
      }
    });
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-5">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Itinerary Source</CardTitle>
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

                {/* Multi-City itineraries get extra breathing room between
                    segments plus a visible divider — with several unrelated
                    legs back to back, the default spacing makes it hard to
                    see where one flight ends and the next begins. One-way
                    and round-trip itineraries (already just 1-2 segments,
                    usually connected legs) are left at the tighter default
                    so the page doesn't grow unnecessarily long. */}
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
              Internal Notes
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground bg-muted rounded px-1.5 py-0.5">Staff only</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Never shown to the customer — not included on the quote page, booking form, or any customer email.
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">Net Ticket Cost</Label>
              <Input type="number" value={netTicketCost} onChange={(e) => setNetTicketCost(e.target.value)} className="w-40" placeholder="0.00" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Notes</Label>
              <Textarea
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
                rows={3}
                placeholder="Supplier, fare rules, internal booking info..."
              />
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
                <Label className="text-xs">Adult price</Label>
                <Input type="number" value={adultPrice} onChange={(e) => setAdultPrice(e.target.value)} className="h-8 w-28 text-right" placeholder="0.00" />
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
                <>
                  <div className="flex items-center justify-between text-sm">
                    <Label className="text-xs">Exchange rate (1 USD =)</Label>
                    <Input
                      type="number"
                      step="0.0001"
                      value={exchangeRate}
                      onChange={(e) => setExchangeRate(e.target.value)}
                      className="h-8 w-28 text-right"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Reference rate only — no live feed is wired up. Verify the current rate before sending; the customer sees only this converted price, never the USD figures above.
                  </p>
                  <div className="flex justify-between font-semibold text-sm rounded-md bg-muted/40 px-2.5 py-2">
                    <span>Customer sees</span>
                    {/* Pass 28 — same defensive fix as exchange-builder.tsx:
                        a hand-rolled `${symbol}${n.toLocaleString(...)}`
                        reproduces the sign-placement bug formatMoney itself
                        already fixes for any negative amount. */}
                    <span>{formatMoney(convertedPricing.total, currency)}</span>
                  </div>
                </>
              )}
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <Button variant="outline" onClick={() => handleSave(false)} disabled={isSaving} className="gap-2">
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save as Draft
              </Button>
              <Button onClick={() => handleSave(true)} disabled={isSaving} className="gap-2">
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Save & Send Quote
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
