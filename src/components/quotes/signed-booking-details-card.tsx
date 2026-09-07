import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CardBrandLogo } from "@/components/ui/card-brand-logo";
import { formatMoney, type SupportedCurrency } from "@/lib/currency";
import type { CardBrand } from "@/lib/card-validation";

const KNOWN_BRANDS: readonly CardBrand[] = ["Visa", "Mastercard", "American Express", "Discover", "Unknown"];
function toCardBrand(value: string | null): CardBrand {
  return (KNOWN_BRANDS as readonly string[]).includes(value ?? "") ? (value as CardBrand) : "Unknown";
}

type Passenger = {
  id: string;
  type: "ADULT" | "CHILD" | "INFANT";
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  tsaKnownTravelerNumber: string | null;
  globalEntryNumber: string | null;
  frequentFlyerAirline: string | null;
  frequentFlyerNumber: string | null;
};

type PaymentMethod = {
  id: string;
  cardholderName: string | null;
  cardBrand: string | null;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  amountAllocated: unknown;
  status: string;
};

type Signature = {
  signedName: string;
  signedAt: Date;
  ipAddress: string | null;
} | null;

type Booking = {
  contactPhone: string;
  contactEmail: string;
  billingAddress: string;
  billingApt: string | null;
  billingCity: string;
  billingState: string;
  billingZip: string;
  billingCountry: string;
  passengers: Passenger[];
  paymentMethods: PaymentMethod[];
  signature: Signature;
};

const PASSENGER_TYPE_LABEL: Record<Passenger["type"], string> = { ADULT: "Adult", CHILD: "Child", INFANT: "Infant" };

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  );
}

/**
 * Part 13 — the signed booking form's own data, shown below the itinerary
 * once a customer has signed. Field order deliberately mirrors the
 * customer-facing booking form: Passengers → Contact Information →
 * Payment → Billing Address → Signature. Payment display is limited to
 * safe display metadata (last4/brand/expiry/cardholder name) — never the
 * full card number or CVV, neither of which this component ever receives
 * (see getQuoteDetail's explicit paymentMethods select).
 */
export function SignedBookingDetailsCard({ booking, currency }: { booking: Booking; currency: SupportedCurrency }) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          Signed Booking Details
          <Badge variant="outline" className="text-[10px] font-normal">From the customer-signed form</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Passengers ({booking.passengers.length})
          </p>
          <div className="space-y-2">
            {booking.passengers.map((p) => (
              <div key={p.id} className="rounded-md border p-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
                <Field label="First Name" value={p.firstName} />
                <Field label="Middle Name" value={p.middleName} />
                <Field label="Last Name" value={p.lastName} />
                <Field label="Type" value={PASSENGER_TYPE_LABEL[p.type]} />
                <Field label="Date of Birth" value={p.dateOfBirth ? p.dateOfBirth.toLocaleDateString("en-US", { timeZone: "UTC" }) : null} />
                <Field label="Gender" value={p.gender} />
                <Field label="TSA Known Traveler #" value={p.tsaKnownTravelerNumber} />
                <Field label="Global Entry #" value={p.globalEntryNumber} />
                <Field
                  label="Frequent Flyer"
                  value={p.frequentFlyerAirline && p.frequentFlyerNumber ? `${p.frequentFlyerAirline} · ${p.frequentFlyerNumber}` : null}
                />
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Contact Information</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Phone" value={booking.contactPhone} />
            <Field label="Email" value={booking.contactEmail} />
          </div>
        </div>

        {booking.paymentMethods.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Payment</p>
            <div className="space-y-2">
              {booking.paymentMethods.map((pm) => (
                <div key={pm.id} className="flex items-center gap-3 rounded-md border p-3">
                  <CardBrandLogo brand={toCardBrand(pm.cardBrand)} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      {pm.cardBrand ?? "Card"} •••• {pm.last4 ?? "••••"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {pm.cardholderName ?? "—"}
                      {pm.expiryMonth && pm.expiryYear ? ` · Exp ${String(pm.expiryMonth).padStart(2, "0")}/${String(pm.expiryYear).slice(-2)}` : ""}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{formatMoney(Number(pm.amountAllocated), currency)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Billing Address</p>
          <p className="text-sm">
            {booking.billingAddress}
            {booking.billingApt ? `, ${booking.billingApt}` : ""}, {booking.billingCity}, {booking.billingState} {booking.billingZip}, {booking.billingCountry}
          </p>
        </div>

        {booking.signature && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Electronic Signature</p>
            <div className="rounded-md border p-3 grid grid-cols-2 gap-2">
              <Field label="Signed Name" value={booking.signature.signedName} />
              <Field
                label="Signed At"
                value={booking.signature.signedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
