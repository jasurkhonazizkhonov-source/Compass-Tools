"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Minus, UserRoundSearch, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AirportSearchField } from "@/components/crm/airport-search";
import { DatePicker } from "@/components/crm/date-picker";
import { ContactSearchField, type ContactOption } from "@/components/leads/contact-search-field";
import { createLead, findDuplicateContact } from "@/server/actions/leads";
import { leadSourceLabel } from "@/lib/status-meta";
import { PhoneInput, DEFAULT_PHONE_COUNTRY } from "@/components/crm/phone-input";
import { normalizePhoneNumber, phoneCountryMismatch, type CountryCode } from "@/lib/phone";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { AirportOption } from "@/server/queries/reference-data";

type Agent = { id: string; fullName: string; role: string };

type PresetContact = {
  id: string;
  firstName: string;
  lastName: string;
  primaryPhone: string | null;
  primaryEmail: string | null;
};

const TRIP_TYPES = [
  { value: "ROUND_TRIP", label: "Round Trip" },
  { value: "ONE_WAY", label: "One Way" },
  { value: "MULTI_CITY", label: "Multi City" },
];
const CABIN_CLASSES = [
  { value: "ECONOMY", label: "Economy" },
  { value: "PREMIUM_ECONOMY", label: "Premium Economy" },
  { value: "BUSINESS", label: "Business" },
  { value: "FIRST", label: "First" },
];
const SOURCES = ["WEBSITE", "PHONE", "EMAIL", "WHATSAPP", "FACEBOOK", "INSTAGRAM", "REFERRAL", "OTHER"] as const;
const PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;

function PaxStepper({ label, value, onChange, min = 0 }: { label: string; value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="icon-sm" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`Decrease ${label}`}>
          <Minus className="h-3 w-3" />
        </Button>
        <span className="w-5 text-center text-sm tabular-nums">{value}</span>
        <Button type="button" variant="outline" size="icon-sm" onClick={() => onChange(value + 1)} aria-label={`Increase ${label}`}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Two modes:
 *   - Generic (no `presetContact`) — used from the global Leads page.
 *     Customer identity fields are freely entered, and createLead()
 *     dedup-matches by phone/email, reusing an existing Contact or
 *     creating a new one.
 *   - Contact-scoped (`presetContact` provided) — used from a Contact's
 *     own "New Lead for Customer" button. The contact is fixed and never
 *     re-matched/duplicated; this is simply a new travel request for that
 *     same customer. Editing phone/email here adds an additional number/
 *     address to that contact (never overwrites or discards the existing
 *     one — see createLead's contactId branch).
 */
export function NewLeadDialog({
  agents,
  presetContact,
  currentAccountId,
  canAssignOthers = false,
}: {
  agents: Agent[];
  presetContact?: PresetContact;
  /** The logged-in user creating this lead — defaults "Assigned Agent" to
   * them instead of leaving the field blank, so a manually-created lead is
   * never accidentally left unowned. */
  currentAccountId?: string;
  /** Whether this user may hand the lead to someone else at creation time
   * (mirrors canReassignLeads — Admin/Manager only). When false, the
   * Assigned Agent field is locked to the current user. */
  canAssignOthers?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [firstName, setFirstName] = useState(presetContact?.firstName ?? "");
  const [lastName, setLastName] = useState(presetContact?.lastName ?? "");
  const presetPhone = presetContact?.primaryPhone ? parsePhoneNumberFromString(presetContact.primaryPhone) : undefined;
  const [phoneCountry, setPhoneCountry] = useState<CountryCode>((presetPhone?.country as CountryCode) ?? DEFAULT_PHONE_COUNTRY);
  const [phoneNational, setPhoneNational] = useState(presetPhone ? presetPhone.formatNational() : presetContact?.primaryPhone ?? "");
  const [email, setEmail] = useState(presetContact?.primaryEmail ?? "");
  const [duplicateInfo, setDuplicateInfo] = useState<{ name: string; ownerId: string | null; ownerName: string | null } | null>(null);
  const [checkingDup, setCheckingDup] = useState(false);

  const [from, setFrom] = useState<AirportOption | null>(null);
  const [to, setTo] = useState<AirportOption | null>(null);
  const [departureDate, setDepartureDate] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [tripType, setTripType] = useState("ROUND_TRIP");
  const [cabinClass, setCabinClass] = useState("ECONOMY");
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [infants, setInfants] = useState(0);
  const [flexibleDates, setFlexibleDates] = useState(false);
  const [preferredAirline, setPreferredAirline] = useState("");
  const [budget, setBudget] = useState("");
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState("WEBSITE");
  const [referredByContact, setReferredByContact] = useState<ContactOption | null>(null);
  const [priority, setPriority] = useState("MEDIUM");
  // Defaults to the current user for a manually-created lead (never left
  // accidentally unowned) — the server independently applies the same
  // default, so this is purely a UX head start, not the source of truth.
  const [assignedAgentId, setAssignedAgentId] = useState(currentAccountId ?? "");

  async function checkDuplicate(nextPhone: string, nextEmail: string) {
    // Skip entirely when the contact is already fixed — there's nothing to
    // match, and it would be actively wrong to let this silently redirect
    // the lead to a different customer's record.
    if (presetContact) return;
    if (!nextPhone && !nextEmail) return;
    setCheckingDup(true);
    try {
      const existing = await findDuplicateContact(nextPhone, nextEmail || undefined);
      setDuplicateInfo(
        existing
          ? { name: `${existing.firstName} ${existing.lastName}`, ownerId: existing.owner?.id ?? null, ownerName: existing.owner?.fullName ?? null }
          : null
      );
      if (existing) {
        setFirstName(existing.firstName);
        setLastName(existing.lastName);
      }
    } finally {
      setCheckingDup(false);
    }
  }

  function reset() {
    setFirstName(presetContact?.firstName ?? "");
    setLastName(presetContact?.lastName ?? "");
    setPhoneCountry((presetPhone?.country as CountryCode) ?? DEFAULT_PHONE_COUNTRY);
    setPhoneNational(presetPhone ? presetPhone.formatNational() : presetContact?.primaryPhone ?? "");
    setEmail(presetContact?.primaryEmail ?? "");
    setDuplicateInfo(null);
    setFrom(null);
    setTo(null);
    setDepartureDate("");
    setReturnDate("");
    setTripType("ROUND_TRIP");
    setCabinClass("ECONOMY");
    setAdults(1);
    setChildren(0);
    setInfants(0);
    setFlexibleDates(false);
    setPreferredAirline("");
    setBudget("");
    setNotes("");
    setSource("WEBSITE");
    setReferredByContact(null);
    setPriority("MEDIUM");
    setAssignedAgentId(currentAccountId ?? "");
  }

  // A previously-picked return date must not silently survive a switch away
  // from Round Trip — it would otherwise still be submitted for a One Way/
  // Multi City lead even though the field is now disabled and hidden from
  // the user's attention.
  function handleTripTypeChange(next: string) {
    setTripType(next);
    if (next !== "ROUND_TRIP") setReturnDate("");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!firstName || !lastName || !phoneNational) {
      toast.error("First name, last name, and phone are required.");
      return;
    }
    // A number pasted with its own "+"-prefixed calling code (e.g. "+44 20
    // 7946 0958") silently overrides whatever country is selected in the
    // dropdown — libphonenumber-js always trusts the embedded code over the
    // hint. Caught here, before normalizing, so the agent sees exactly what
    // mismatched rather than a number quietly saving against the wrong
    // country. The server re-checks this independently (see createLead's
    // schema) — this is a UX nicety, not the enforcement.
    if (phoneCountryMismatch(phoneNational, phoneCountry)) {
      toast.error("The phone number country code does not match the selected country.");
      return;
    }
    // Normalized to E.164 here — the only form this phone number should
    // ever be persisted or matched in, regardless of how the agent typed
    // it (see @/lib/phone's header comment for why).
    const normalizedPhone = normalizePhoneNumber(phoneNational, phoneCountry);
    if (!normalizedPhone) {
      toast.error("Please enter a valid phone number for the selected country.");
      return;
    }
    if (!email.trim()) {
      toast.error("Email address is required.");
      return;
    }
    if (!from) {
      toast.error("Departure airport (From) is required.");
      return;
    }
    if (!to) {
      toast.error("Arrival airport (To) is required.");
      return;
    }
    if (!departureDate) {
      toast.error("Departure date is required.");
      return;
    }
    if (tripType === "ROUND_TRIP" && !returnDate) {
      toast.error("Return date is required for a round trip.");
      return;
    }
    // Captured into typed locals right after the required-field checks
    // above (rather than re-reading `from`/`to`/`departureDate` inside the
    // async closure below) so TypeScript can see these are non-null —
    // matches createLead's now-required (not optional) schema fields.
    const departureAirport = from;
    const arrivalAirport = to;
    const confirmedDepartureDate = departureDate;
    startTransition(async () => {
      try {
        const result = await createLead({
          contactId: presetContact?.id,
          firstName,
          lastName,
          phone: normalizedPhone,
          phoneCountry,
          email: email.trim(),
          departureAirportId: departureAirport.id,
          arrivalAirportId: arrivalAirport.id,
          departureDate: confirmedDepartureDate,
          returnDate: returnDate || undefined,
          tripType: tripType as "ONE_WAY" | "ROUND_TRIP" | "MULTI_CITY",
          cabinClass: cabinClass as "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST",
          adults,
          children,
          infants,
          flexibleDates,
          preferredAirline: preferredAirline || undefined,
          budget: budget ? Number(budget) : undefined,
          notes: notes || undefined,
          source: source as typeof SOURCES[number],
          referredByContactId: source === "REFERRAL" ? referredByContact?.id : undefined,
          priority: priority as typeof PRIORITIES[number],
          assignedAgentId: assignedAgentId || undefined,
        });
        if (result.autoAssignedToOwner) {
          toast.success("Existing customer found", {
            description: `This contact is already owned by ${result.autoAssignedToOwner.name}. Contact ownership and Lead ownership are independent, but since this contact already has an owner, this new lead has been assigned to them instead of you. If you believe this lead should be reassigned to you, please contact your manager or supervisor.`,
            duration: 12000,
          });
        } else {
          toast.success("Lead created");
        }
        setOpen(false);
        reset();
        router.push(`/leads/${result.leadId}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to create lead");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" /> {presetContact ? "New Lead for Customer" : "New Lead"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{presetContact ? `New Lead for ${presetContact.firstName} ${presetContact.lastName}` : "Create New Lead"}</DialogTitle>
          <DialogDescription>
            {presetContact
              ? "A new travel request for this same customer — their contact record stays the same."
              : "Capture a new airline travel request. Existing customers are matched automatically by phone or email."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-8">
          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">Customer</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>First Name *</Label>
                <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} required disabled={!!presetContact} />
              </div>
              <div className="space-y-1.5">
                <Label>Last Name *</Label>
                <Input value={lastName} onChange={(e) => setLastName(e.target.value)} required disabled={!!presetContact} />
              </div>
              <div className="space-y-1.5">
                <Label>Phone *{presetContact && <span className="font-normal text-muted-foreground"> — editing adds a new number, on file alongside the existing one</span>}</Label>
                <PhoneInput
                  country={phoneCountry}
                  onCountryChange={setPhoneCountry}
                  nationalNumber={phoneNational}
                  onNationalNumberChange={setPhoneNational}
                  onBlur={() => checkDuplicate(normalizePhoneNumber(phoneNational, phoneCountry) ?? "", email)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Email *{presetContact && <span className="font-normal text-muted-foreground"> — editing adds a new address, on file alongside the existing one</span>}</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => checkDuplicate(normalizePhoneNumber(phoneNational, phoneCountry) ?? "", email)}
                  required
                />
              </div>
            </div>
            {checkingDup && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Checking for existing customer...
              </p>
            )}
            {duplicateInfo && (
              <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-foreground">
                <UserRoundSearch className="h-3.5 w-3.5 text-info shrink-0 mt-0.5" />
                <span>
                  {/* Pass 7 — must accurately describe what WILL actually
                   * happen to this new lead's ownership (createLead's own
                   * "ownerIsDifferentAgent" rule), not a vague "belongs to
                   * another user" — and must never claim a transfer that
                   * won't actually occur. */}
                  Matches existing customer <strong>{duplicateInfo.name}</strong>, linked to their existing record.
                  {duplicateInfo.ownerId && duplicateInfo.ownerId !== currentAccountId ? (
                    <> This contact is owned by <strong>{duplicateInfo.ownerName}</strong>. Contact ownership and Lead ownership are independent — but since this contact already has an owner, the new lead will be assigned to <strong>{duplicateInfo.ownerName}</strong>, not to you.</>
                  ) : duplicateInfo.ownerId ? (
                    <> You already own this contact, so the new lead will be assigned to you as usual.</>
                  ) : (
                    <> This contact has no owner yet, so the new lead will be assigned normally.</>
                  )}
                </span>
              </div>
            )}
          </section>

          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">Travel Request</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>From *</Label>
                <AirportSearchField value={from} onChange={setFrom} placeholder="Departure airport" />
              </div>
              <div className="space-y-1.5">
                <Label>To *</Label>
                <AirportSearchField value={to} onChange={setTo} placeholder="Arrival airport" />
              </div>
              <div className="space-y-1.5">
                <Label>Departure Date *</Label>
                <DatePicker value={departureDate || null} onChange={(v) => setDepartureDate(v ?? "")} minDate={new Date()} />
              </div>
              <div className="space-y-1.5">
                <Label>Return Date{tripType === "ROUND_TRIP" && " *"}</Label>
                <DatePicker
                  value={returnDate || null}
                  onChange={(v) => setReturnDate(v ?? "")}
                  disabled={tripType !== "ROUND_TRIP"}
                  minDate={departureDate ? new Date(departureDate) : new Date()}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Trip Type</Label>
                <Select value={tripType} onValueChange={handleTripTypeChange}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TRIP_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Cabin Class</Label>
                <Select value={cabinClass} onValueChange={setCabinClass}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CABIN_CLASSES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <PaxStepper label="Adults" value={adults} onChange={setAdults} min={1} />
              <PaxStepper label="Children" value={children} onChange={setChildren} />
              <PaxStepper label="Infants" value={infants} onChange={setInfants} />
            </div>

            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <Label htmlFor="flexible-dates" className="text-sm font-normal">Flexible dates</Label>
              <Switch id="flexible-dates" checked={flexibleDates} onCheckedChange={setFlexibleDates} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Preferred Airline</Label>
                <Input value={preferredAirline} onChange={(e) => setPreferredAirline(e.target.value)} placeholder="e.g. Emirates" />
              </div>
              <div className="space-y-1.5">
                <Label>Budget (USD)</Label>
                <Input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 1200" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>
          </section>

          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">CRM</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label>Source</Label>
                <Select value={source} onValueChange={(v) => { setSource(v); if (v !== "REFERRAL") setReferredByContact(null); }}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SOURCES.map((s) => <SelectItem key={s} value={s}>{leadSourceLabel(s)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {source === "REFERRAL" && (
                <div className="space-y-1.5 col-span-3">
                  <Label>Referred By</Label>
                  <ContactSearchField
                    value={referredByContact}
                    onChange={setReferredByContact}
                    excludeContactId={presetContact?.id}
                    placeholder="Search for the referring customer (optional)..."
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Assigned Agent</Label>
                {canAssignOthers ? (
                  <Select value={assignedAgentId} onValueChange={setAssignedAgentId}>
                    <SelectTrigger className="w-full"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                    <SelectContent>
                      {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.fullName}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={agents.find((a) => a.id === assignedAgentId)?.fullName ?? "You"}
                    disabled
                    className="text-muted-foreground"
                  />
                )}
              </div>
            </div>
          </section>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={isPending} className="gap-2">
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Lead
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
