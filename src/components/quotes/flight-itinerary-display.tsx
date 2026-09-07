import { CornerDownRight, Gift, AlertTriangle, PlaneTakeoff } from "lucide-react";
import { formatDuration } from "@/lib/parsers/shared";
import { formatAirportDate, formatAirportTime } from "@/lib/airport-datetime";
import { calculateJourneyDuration, type JourneyLegInput } from "@/lib/flight-duration";
import { resolveAirlineDisplay, resolveAircraftDisplay, resolveOperatingCarrierLabel, type AirlineRef, type AircraftRef } from "@/lib/canonical-segment";
import { AirlineLogo } from "@/components/crm/airline-logo";
import { cn } from "@/lib/utils";

export type SegmentDisplay = {
  id: string;
  sequence: number;
  flightNumber: string;
  bookingClass: string | null;
  cabin: string;
  departureAt: Date;
  arrivalAt: Date;
  durationMinutes: number | null;
  airline: AirlineRef;
  airlineCodeRaw: string | null;
  aircraftType: AircraftRef;
  aircraftRaw: string | null;
  operatingCarrierName?: string | null;
  // Pass 11 Part 2 — timezone (Airport.timezone, an IANA identifier) is
  // optional/nullable only because a few call sites (e.g. the live
  // in-builder preview, before a save) may not always have it resolved
  // yet; every real DB-backed segment (via SEGMENT_SELECT) always sets
  // it. Used exclusively by calculateJourneyDuration for a timezone-aware
  // "Total journey time"/connection calculation — never read directly for
  // display formatting.
  departureAirport: { iata: string; name: string; city: string; timezone?: string | null };
  arrivalAirport: { iata: string; name: string; city: string; timezone?: string | null };
  connectionType: "LAYOVER" | "MULTI_CITY" | null;
  isExtraLeg?: boolean;
};

function EndpointBlock({
  label,
  at,
  airport,
  align,
}: {
  label: "Departure" | "Arrival";
  at: Date;
  airport: { iata: string; name: string; city: string };
  align: "left" | "right";
}) {
  return (
    <div className={cn("min-w-0", align === "right" && "sm:text-right")}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-xs text-muted-foreground mt-1">{formatAirportDate(at)}</p>
      <p className="text-2xl font-semibold tabular-nums leading-tight mt-0.5 text-foreground">{formatAirportTime(at)}</p>
      <p className="text-sm font-medium mt-1 text-foreground">
        {airport.city} <span className="text-muted-foreground">({airport.iata})</span>
      </p>
      <p className="text-xs text-muted-foreground truncate">{airport.name}</p>
    </div>
  );
}

// Part 11 — "scheduled" (this segment is scheduled to be cancelled,
// pending customer/internal confirmation — must NEVER claim it's already
// cancelled) vs "cancelled" (the true final state, once a Ticketing-area
// action has actually confirmed it). `true` is accepted as a shorthand for
// "cancelled" so existing call sites that only ever mean the final state
// don't need updating.
export type CancellationDisplayState = "scheduled" | "cancelled" | boolean | undefined;

function FlightSegmentCard({ segment, customerFacing, cancellationState, isNonstop }: { segment: SegmentDisplay; customerFacing?: boolean; cancellationState?: CancellationDisplayState; isNonstop?: boolean }) {
  const isCancelled = !!cancellationState;
  const isScheduled = cancellationState === "scheduled";
  const airline = resolveAirlineDisplay(segment.airline, segment.airlineCodeRaw);
  const airlineLabel = airline.name;
  const airlineCode = airline.code;
  // No known aircraft type or raw GDS text at all — this area is simply
  // left blank everywhere (no "unavailable" placeholder text), internal
  // CRM views included. Aircraft info only ever renders when real data
  // exists; resolveAircraftDisplay's own fallback string is never reached.
  const hasNoAircraftData = !segment.aircraftType?.displayName && !segment.aircraftRaw;
  const aircraftDisplay = hasNoAircraftData ? "" : resolveAircraftDisplay(segment.aircraftType, segment.aircraftRaw);
  const operatingCarrierLabel = resolveOperatingCarrierLabel(segment.operatingCarrierName);
  // "Flight duration" — this ONE leg's own scheduled flying time, never to
  // be confused with the group-level "Total journey time" shown in
  // TotalJourneySummary above it.
  const duration = segment.durationMinutes != null ? formatDuration(segment.durationMinutes) : null;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card overflow-hidden",
        segment.isExtraLeg && customerFacing && "ring-1 ring-success/40",
        isCancelled && "border-destructive/40 opacity-75"
      )}
    >
      {isCancelled && (
        <div className="flex items-center gap-2 bg-destructive/10 border-b border-destructive/30 px-4 py-2.5">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
          <div>
            <p className="text-xs font-semibold text-destructive uppercase tracking-wide">{isScheduled ? "Scheduled for Cancellation" : "Cancellation Confirmed"}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {isScheduled
                ? "This flight segment is scheduled to be cancelled, pending confirmation. It has not been cancelled yet."
                : "This flight segment has been cancelled and is no longer part of your active itinerary."}
            </p>
          </div>
        </div>
      )}
      {segment.isExtraLeg && customerFacing && (
        <div className="flex items-center gap-2 bg-success/10 border-b border-success/30 px-4 py-2.5">
          <Gift className="h-4 w-4 text-success shrink-0" />
          <div>
            <p className="text-xs font-semibold text-success uppercase tracking-wide">Bonus Flight — Included at no additional charge</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              This bonus flight is included in your package at the same price. Optional: if you do not wish to use it, it can be reviewed with your agent — it will not affect your main flight itinerary.
            </p>
          </div>
        </div>
      )}
      {segment.isExtraLeg && !customerFacing && (
        <div className="flex items-center gap-1.5 bg-info/10 border-b border-info/30 px-4 py-1.5">
          <span className="text-[11px] font-semibold text-info uppercase tracking-wide">Extra Leg</span>
        </div>
      )}
      <div className="border-b bg-muted/40 px-4 py-2.5 text-sm space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          {aircraftDisplay && <span className="text-xs text-muted-foreground truncate">{aircraftDisplay}</span>}
          <div className="flex items-center gap-1.5 shrink-0">
            {isNonstop && (
              <span className="rounded-full bg-success/10 text-success border border-success/20 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide">
                Nonstop
              </span>
            )}
            <span className="rounded-full bg-background border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-foreground">
              {segment.cabin.replace("_", " ")}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <AirlineLogo
            name={airlineLabel}
            iata={segment.airline?.iata}
            icao={segment.airline?.icao}
            // Bug fix (found live, via a genuinely fresh database with no
            // curated Airline.logoUrl rows): this previously read the RAW
            // `segment.airline?.logoUrl` database column directly, silently
            // discarding the CDN-fallback value `resolveAirlineDisplay()`
            // (canonical-segment.ts) already computed into `airline.logoUrl`
            // above (line 63) — the exact same fallback the email path
            // (segment-mapper.ts) already correctly uses. On the old shared
            // dev database this was masked because ~1,120 airlines already
            // had a manually-backfilled logoUrl column value; on a fresh
            // database (or any newly self-healed Airline row) every logo
            // silently fell back to the boxed-code display instead of the
            // real CDN logo, even though the fallback logic existed and
            // worked correctly — it just was never being read from here.
            logoUrl={airline.logoUrl}
            size={24}
          />
          <span className="font-medium text-foreground truncate max-w-[160px] sm:max-w-none">{airlineLabel}</span>
          <span className="text-muted-foreground shrink-0">
            {airlineCode} {segment.flightNumber}
          </span>
          {operatingCarrierLabel && (
            <span className="text-[11px] text-muted-foreground shrink-0 basis-full sm:basis-auto">{operatingCarrierLabel}</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-3 px-4 py-4">
        <EndpointBlock label="Departure" at={segment.departureAt} airport={segment.departureAirport} align="left" />
        <div className="flex sm:flex-col items-center gap-2 sm:gap-1 px-0 sm:px-1">
          <div className="hidden sm:block h-px w-10 bg-border" />
          <div className="flex-1 sm:hidden h-px bg-border" />
          {duration && (
            <span className="text-[11px] font-medium text-muted-foreground whitespace-nowrap text-center">
              <span className="block text-muted-foreground/70">Flight duration</span>
              {duration}
            </span>
          )}
          <div className="hidden sm:block h-px w-10 bg-border" />
          <div className="flex-1 sm:hidden h-px bg-border" />
        </div>
        <EndpointBlock label="Arrival" at={segment.arrivalAt} airport={segment.arrivalAirport} align="right" />
      </div>
    </div>
  );
}

function LayoverConnector({ city, minutes }: { city: string; minutes: number }) {
  return (
    <div className="relative flex items-center gap-3 py-2.5 pl-[19px]">
      <div className="absolute left-[19px] top-0 bottom-0 w-px bg-border" aria-hidden />
      <div className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full bg-info/15 text-info ring-4 ring-background shrink-0">
        <CornerDownRight className="h-3 w-3" />
      </div>
      <div className="rounded-full border border-info/25 bg-info/10 px-3 py-1 text-xs">
        <span className="font-semibold text-foreground">Connection</span>
        <span className="text-muted-foreground"> — {formatDuration(minutes)} layover in {city}</span>
      </div>
    </div>
  );
}

/** "Atlanta (ATL) → London (LHR) — 15h 30m total journey time — 1
 * connection · Copenhagen (CPH)" — the prominent summary that must appear
 * at the top of every directional itinerary (Outbound/Return/each
 * multi-city leg), computed via the ONE centralized, timezone-aware
 * calculateJourneyDuration helper — never a naive sum of displayed
 * strings, never hardcoded. */
function TotalJourneySummary({ group, journey }: { group: SegmentDisplay[]; journey: ReturnType<typeof calculateJourneyDuration> }) {
  if (!journey) return null;
  const first = group[0];
  const last = group[group.length - 1];
  const connectionCities = group.slice(0, -1).map((seg) => seg.arrivalAirport.city);

  return (
    <div className="rounded-lg border bg-primary/5 border-primary/15 px-4 py-3 mb-3">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <PlaneTakeoff className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden />
        <span>
          {first.departureAirport.city} ({first.departureAirport.iata}) → {last.arrivalAirport.city} ({last.arrivalAirport.iata})
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        <span className="font-semibold text-foreground">{formatDuration(journey.totalJourneyMinutes)}</span> total journey time
        {connectionCities.length > 0 ? (
          <> · {connectionCities.length} connection{connectionCities.length > 1 ? "s" : ""} · {connectionCities.join(", ")}</>
        ) : (
          <> · Nonstop</>
        )}
      </p>
    </div>
  );
}

/** Maps a display segment into the shape calculateJourneyDuration expects
 * — the one conversion point between this component's own prop type and
 * the shared duration-calculation module. */
function toJourneyLegInput(seg: SegmentDisplay): JourneyLegInput {
  return {
    departureAt: seg.departureAt,
    arrivalAt: seg.arrivalAt,
    departureTimezone: seg.departureAirport.timezone,
    arrivalTimezone: seg.arrivalAirport.timezone,
    durationMinutes: seg.durationMinutes,
  };
}

/** Groups consecutive segments: a LAYOVER connection keeps segments visually
 * joined as one journey; anything else (first segment, or an explicit
 * MULTI_CITY connection) starts a new, clearly separated leg. */
function groupSegments(segments: SegmentDisplay[]): SegmentDisplay[][] {
  const groups: SegmentDisplay[][] = [];
  for (const seg of segments) {
    if (seg.connectionType === "LAYOVER" && groups.length > 0) {
      groups[groups.length - 1].push(seg);
    } else {
      groups.push([seg]);
    }
  }
  return groups;
}

export function FlightItineraryDisplay({
  segments,
  customerFacing,
  cancelledSegmentIds,
  cancellationState = "cancelled",
}: {
  segments: SegmentDisplay[];
  /** True on customer-facing pages (View Deal, booking form) — shows Extra
   * Leg segments as a labeled "Bonus Flight" callout. False/omitted for
   * internal CRM views, where an Extra Leg segment gets a plain internal
   * "Extra Leg" tag instead. Never set true for the initial quote email —
   * that surface excludes Extra Leg segments entirely before this
   * component ever sees them. */
  customerFacing?: boolean;
  /** Cancellation workflow — segment ids that have a cancellation against
   * them (either scheduled/pending, or actually confirmed — see
   * `cancellationState`), rendered with a red warning banner in the middle
   * of an otherwise-normal itinerary. Never assume "cancelled" means every
   * segment — only ids present in this set are marked. */
  cancelledSegmentIds?: Set<string>;
  /** Part 11 — whether the ids above are only "scheduled to be cancelled,
   * pending confirmation" (never claims it's already done) or genuinely
   * "cancelled" (the true final state). Defaults to "cancelled" to match
   * every existing call site, which only ever meant the final state. */
  cancellationState?: "scheduled" | "cancelled";
}) {
  const groups = groupSegments(segments);
  const isMultiLeg = groups.length > 1;

  return (
    <div className="space-y-6">
      {groups.map((group, gi) => (
        <div
          key={group[0].id}
          className={cn(isMultiLeg && "space-y-2", isMultiLeg && gi > 0 && "pt-6 mt-2 border-t border-dashed")}
        >
          {isMultiLeg && (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1">
              <span className="text-xs font-semibold text-primary">Flight {gi + 1}</span>
              <span className="text-xs text-muted-foreground">
                {group[0].departureAirport.iata} → {group[group.length - 1].arrivalAirport.iata}
              </span>
            </div>
          )}
          <div>
            {(() => {
              // Pass 11 Part 2 — ONE timezone-aware calculation for this
              // whole group, reused for both the Total Journey Summary
              // header and every connection gap below it. Replaces the
              // previous naive `Date.getTime()` subtraction on the
              // airport-local-encoded-as-UTC departureAt/arrivalAt fields,
              // which was wrong across a timezone-changing connection.
              const journey = calculateJourneyDuration(group.map(toJourneyLegInput));
              return (
                <>
                  <TotalJourneySummary group={group} journey={journey} />
                  {group.map((seg, i) => {
                    const prevLeg = i > 0 ? journey?.legs[i - 1] : null;
                    const connectionMinutes = prevLeg?.connectionMinutesAfter ?? null;
                    const prev = i > 0 ? group[i - 1] : null;
                    return (
                      <div key={seg.id}>
                        {prev && connectionMinutes != null && connectionMinutes >= 0 && (
                          <LayoverConnector city={prev.arrivalAirport.city} minutes={connectionMinutes} />
                        )}
                        <FlightSegmentCard
                          segment={seg}
                          customerFacing={customerFacing}
                          cancellationState={cancelledSegmentIds?.has(seg.id) ? cancellationState : undefined}
                          isNonstop={group.length === 1}
                        />
                      </div>
                    );
                  })}
                </>
              );
            })()}
          </div>
        </div>
      ))}
    </div>
  );
}
