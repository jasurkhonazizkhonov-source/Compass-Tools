"use client";

import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InlineEditField } from "@/components/crm/inline-edit-field";
import { AirportSearchField } from "@/components/crm/airport-search";
import { DatePicker } from "@/components/crm/date-picker";
import { updateLeadField } from "@/server/actions/leads";
import type { AirportOption } from "@/server/queries/reference-data";

type Airport = { id: number; iata: string; name: string; city: string; country: string; timezone: string | null } | null;

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

export function TravelRequestCard({
  leadId,
  departureAirport,
  arrivalAirport,
  departureDate,
  returnDate,
  tripType,
  cabinClass,
  adults,
  childrenCount,
  infants,
  flexibleDates,
  preferredAirline,
  budget,
  additionalNotes,
}: {
  leadId: string;
  departureAirport: Airport;
  arrivalAirport: Airport;
  departureDate: Date | null;
  returnDate: Date | null;
  tripType: string;
  cabinClass: string;
  adults: number;
  childrenCount: number;
  infants: number;
  flexibleDates: boolean;
  preferredAirline: string | null;
  budget: number | null;
  /** "Anything else we should know?" — captured verbatim from the
   * customer's own submission (Lead.notes), distinct from the agent-authored
   * threaded Notes tab (Lead.notesRel) elsewhere on this page. */
  additionalNotes: string | null;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-sm font-medium">Travel Request</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <InlineEditField<AirportOption | null>
            label="From"
            currentValue={departureAirport}
            displayValue={departureAirport ? `${departureAirport.iata} — ${departureAirport.city}` : "Not set"}
            editor={(value, setValue) => <AirportSearchField value={value} onChange={setValue} />}
            onSave={(v) => updateLeadField(leadId, { departureAirportId: v?.id ?? null })}
          />
          <InlineEditField<AirportOption | null>
            label="To"
            currentValue={arrivalAirport}
            displayValue={arrivalAirport ? `${arrivalAirport.iata} — ${arrivalAirport.city}` : "Not set"}
            editor={(value, setValue) => <AirportSearchField value={value} onChange={setValue} />}
            onSave={(v) => updateLeadField(leadId, { arrivalAirportId: v?.id ?? null })}
          />
          <InlineEditField<string>
            label="Departure Date"
            currentValue={departureDate ? format(departureDate, "yyyy-MM-dd") : ""}
            displayValue={departureDate ? format(departureDate, "MMM d, yyyy") : "Not set"}
            editor={(value, setValue) => (
              <DatePicker value={value || null} onChange={(v) => setValue(v ?? "")} />
            )}
            onSave={(v) => updateLeadField(leadId, { departureDate: v || null })}
          />
          <InlineEditField<string>
            label="Return Date"
            currentValue={returnDate ? format(returnDate, "yyyy-MM-dd") : ""}
            displayValue={returnDate ? format(returnDate, "MMM d, yyyy") : tripType === "ROUND_TRIP" ? "Not set" : "N/A"}
            editor={(value, setValue) => (
              <DatePicker value={value || null} onChange={(v) => setValue(v ?? "")} />
            )}
            onSave={(v) => updateLeadField(leadId, { returnDate: v || null })}
          />
          <InlineEditField<string>
            label="Trip Type"
            currentValue={tripType}
            displayValue={TRIP_TYPES.find((t) => t.value === tripType)?.label ?? tripType}
            editor={(value, setValue) => (
              <Select value={value} onValueChange={setValue}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TRIP_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            onSave={(v) => updateLeadField(leadId, { tripType: v as "ONE_WAY" | "ROUND_TRIP" | "MULTI_CITY" })}
          />
          <InlineEditField<string>
            label="Cabin Class"
            currentValue={cabinClass}
            displayValue={CABIN_CLASSES.find((c) => c.value === cabinClass)?.label ?? cabinClass}
            editor={(value, setValue) => (
              <Select value={value} onValueChange={setValue}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CABIN_CLASSES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            onSave={(v) => updateLeadField(leadId, { cabinClass: v as "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST" })}
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <InlineEditField<number>
            label="Adults"
            currentValue={adults}
            displayValue={adults}
            editor={(value, setValue) => (
              <Input type="number" min={1} value={value} onChange={(e) => setValue(Number(e.target.value))} />
            )}
            onSave={(v) => updateLeadField(leadId, { adults: v })}
          />
          <InlineEditField<number>
            label="Children"
            currentValue={childrenCount}
            displayValue={childrenCount}
            editor={(value, setValue) => (
              <Input type="number" min={0} value={value} onChange={(e) => setValue(Number(e.target.value))} />
            )}
            onSave={(v) => updateLeadField(leadId, { children: v })}
          />
          <InlineEditField<number>
            label="Infants"
            currentValue={infants}
            displayValue={infants}
            editor={(value, setValue) => (
              <Input type="number" min={0} value={value} onChange={(e) => setValue(Number(e.target.value))} />
            )}
            onSave={(v) => updateLeadField(leadId, { infants: v })}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <InlineEditField<string>
            label="Preferred Airline"
            currentValue={preferredAirline ?? ""}
            displayValue={preferredAirline || "Not set"}
            editor={(value, setValue) => <Input value={value} onChange={(e) => setValue(e.target.value)} />}
            onSave={(v) => updateLeadField(leadId, { preferredAirline: v || null })}
          />
          <InlineEditField<string>
            label="Budget"
            currentValue={budget != null ? String(budget) : ""}
            displayValue={budget != null ? `$${budget.toLocaleString()}` : "Not set"}
            editor={(value, setValue) => <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} />}
            onSave={(v) => updateLeadField(leadId, { budget: v ? Number(v) : null })}
          />
        </div>

        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <span className="text-sm">Flexible dates</span>
          <Switch
            checked={flexibleDates}
            onCheckedChange={(checked) => updateLeadField(leadId, { flexibleDates: checked })}
          />
        </div>

        <InlineEditField<string>
          label="Additional Information"
          currentValue={additionalNotes ?? ""}
          displayValue={additionalNotes || "Not set"}
          editor={(value, setValue) => <Textarea rows={3} value={value} onChange={(e) => setValue(e.target.value)} />}
          onSave={(v) => updateLeadField(leadId, { notes: v || null })}
        />
      </CardContent>
    </Card>
  );
}
