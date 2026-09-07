"use client";

import { useId } from "react";
import { User } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AirlineSearchField } from "@/components/crm/airline-search";
import { DatePicker } from "@/components/crm/date-picker";
import { useCustomerTheme } from "@/components/customer/customer-theme-provider";
import type { AirlineOption } from "@/server/queries/reference-data";

export type PassengerFormState = {
  clientId: string;
  type: "ADULT" | "CHILD" | "INFANT";
  firstName: string;
  middleName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  tsaKnownTravelerNumber: string;
  globalEntryNumber: string;
  frequentFlyerAirline: AirlineOption | null;
  frequentFlyerNumber: string;
};

const TYPE_LABEL: Record<PassengerFormState["type"], string> = {
  ADULT: "Adult",
  CHILD: "Child",
  INFANT: "Infant",
};

/** Pass 24/25 — one distinct person available for the "previous passenger"
 * autofill selector (see booking-flow.tsx's own `previousPassengerOptions`
 * doc comment for the security/dedup contract). */
export type PreviousPassengerOption = {
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
};

export function PassengerForm({
  passenger,
  index,
  onChange,
  previousPassengerOptions,
}: {
  passenger: PassengerFormState;
  index: number;
  onChange: (next: PassengerFormState) => void;
  /** Optional — omitted entirely (exchange bookings, or a customer with no
   * prior passengers) hides the selector. Selecting one is a one-shot
   * convenience: it populates this slot's fields, but this slot's own
   * `type`/`clientId` are always preserved (a previously-traveling adult
   * selected into today's CHILD slot doesn't change what fare/slot type
   * this booking charges for), and every field stays fully editable
   * afterward. */
  previousPassengerOptions?: PreviousPassengerOption[];
}) {
  const { portalContainer } = useCustomerTheme();
  // Pass 22 fix — every field below used to be a bare visual <Label> with
  // no htmlFor/id (or, for the two custom-widget fields, no
  // aria-labelledby) connecting it to its control. A screen-reader user
  // tabbing through this form previously heard no field name at all for
  // any of them. useId() gives this component instance (one per
  // passenger) a stable, unique-per-render base — safe across multiple
  // passengers on the same page and across re-renders — matching the
  // exact pattern already established for the DatePicker/AirlineSearch
  // custom widgets elsewhere in this app (see flight-segment-editor.tsx's
  // FieldSlot doc comment).
  const baseId = useId();
  const firstNameId = `${baseId}-first-name`;
  const middleNameId = `${baseId}-middle-name`;
  const lastNameId = `${baseId}-last-name`;
  const dobLabelId = `${baseId}-dob-label`;
  const genderId = `${baseId}-gender`;
  const tsaId = `${baseId}-tsa`;
  const globalEntryId = `${baseId}-global-entry`;
  const ffAirlineLabelId = `${baseId}-ff-airline-label`;
  const ffNumberId = `${baseId}-ff-number`;
  const previousPassengerId = `${baseId}-previous-passenger`;

  function set<K extends keyof PassengerFormState>(key: K, value: PassengerFormState[K]) {
    onChange({ ...passenger, [key]: value });
  }

  // Pass 24/25 — applying a previous passenger only ever touches the
  // person-identity fields; this slot's own `clientId`/`type` (which
  // ADULT/CHILD/INFANT fare this slot represents in THIS booking) are
  // always preserved, and the result stays fully editable afterward —
  // this is a one-shot fill, never a lock.
  function applyPrevious(option: PreviousPassengerOption) {
    onChange({
      ...passenger,
      firstName: option.firstName,
      middleName: option.middleName ?? "",
      lastName: option.lastName,
      dateOfBirth: option.dateOfBirth ? option.dateOfBirth.toISOString().slice(0, 10) : "",
      gender: option.gender ?? "",
      tsaKnownTravelerNumber: option.tsaKnownTravelerNumber ?? "",
      globalEntryNumber: option.globalEntryNumber ?? "",
      frequentFlyerAirline: option.frequentFlyerAirline,
      frequentFlyerNumber: option.frequentFlyerNumber ?? "",
    });
  }

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <p role="heading" aria-level={3} className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
        <User className="h-3.5 w-3.5" /> Passenger {index + 1} · {TYPE_LABEL[passenger.type]}
      </p>

      {previousPassengerOptions && previousPassengerOptions.length > 0 && (
        <div className="space-y-1.5">
          <Label htmlFor={previousPassengerId} className="text-xs font-normal text-muted-foreground">
            Autofill from a previous passenger (optional)
          </Label>
          <Select
            value=""
            onValueChange={(v) => {
              const option = previousPassengerOptions[Number(v)];
              if (option) applyPrevious(option);
            }}
          >
            <SelectTrigger id={previousPassengerId} className="w-full"><SelectValue placeholder="Select a previous passenger…" /></SelectTrigger>
            <SelectContent container={portalContainer}>
              {previousPassengerOptions.map((option, optionIndex) => (
                <SelectItem key={optionIndex} value={String(optionIndex)}>
                  {option.firstName} {option.lastName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={firstNameId}>First Name *</Label>
          <Input id={firstNameId} value={passenger.firstName} onChange={(e) => set("firstName", e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={middleNameId}>Middle Name</Label>
          <Input id={middleNameId} value={passenger.middleName} onChange={(e) => set("middleName", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={lastNameId}>Last Name *</Label>
          <Input id={lastNameId} value={passenger.lastName} onChange={(e) => set("lastName", e.target.value)} required />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label id={dobLabelId}>Date of Birth *</Label>
          <DatePicker
            value={passenger.dateOfBirth || null}
            onChange={(v) => set("dateOfBirth", v ?? "")}
            maxDate={new Date()}
            placeholder="Select date of birth"
            captionLayout="dropdown"
            portalContainer={portalContainer}
            aria-labelledby={dobLabelId}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={genderId}>Gender *</Label>
          <Select value={passenger.gender} onValueChange={(v) => set("gender", v)}>
            <SelectTrigger id={genderId} className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
            <SelectContent container={portalContainer}>
              <SelectItem value="MALE">Male</SelectItem>
              <SelectItem value="FEMALE">Female</SelectItem>
              <SelectItem value="OTHER">Other / Prefer not to say</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={tsaId}>TSA PreCheck / Known Traveler #</Label>
          <Input id={tsaId} value={passenger.tsaKnownTravelerNumber} onChange={(e) => set("tsaKnownTravelerNumber", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={globalEntryId}>Global Entry #</Label>
          <Input id={globalEntryId} value={passenger.globalEntryNumber} onChange={(e) => set("globalEntryNumber", e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label id={ffAirlineLabelId}>Frequent Flyer Airline</Label>
          <AirlineSearchField
            value={passenger.frequentFlyerAirline}
            onChange={(v) => set("frequentFlyerAirline", v)}
            portalContainer={portalContainer}
            aria-labelledby={ffAirlineLabelId}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ffNumberId}>Frequent Flyer #</Label>
          <Input id={ffNumberId} value={passenger.frequentFlyerNumber} onChange={(e) => set("frequentFlyerNumber", e.target.value)} />
        </div>
      </div>
    </div>
  );
}
