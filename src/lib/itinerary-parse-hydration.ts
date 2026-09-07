import type { EditableSegment } from "@/components/quotes/flight-segment-editor";
import type { ParsedSegment } from "@/lib/parsers/shared";
import { resolveAirportCodes, resolveAirlineCodes, resolveAircraftCodes } from "@/server/queries/reference-data";
import { calculateFlightDurationMinutes } from "@/lib/flight-duration";

/**
 * Turns the pure parser's raw `ParsedSegment[]` output (airport/airline/
 * aircraft as bare string codes) into the itinerary builder's own
 * `EditableSegment[]` shape (real `AirportOption`/`AirlineOption`/
 * `AircraftOption` records, resolved via one batched DB lookup each) and
 * defaults each connection's type from the actual time gap between
 * segments. Originally lived inline in quote-builder.tsx's own `runParse`;
 * extracted here so the Exchange itinerary builder can reuse the exact
 * same hydration logic when it gained Sabre/Apollo paste support, rather
 * than a second copy that could silently drift from this one. Everything
 * ELSE about "how a paste becomes a filled-in itinerary" (the Tabs UI, the
 * reference-year input, the parser function call itself, the resulting
 * toast) stays per-component, matching this codebase's established
 * "shared pure logic, duplicated thin UI" pattern (see exchange-builder.tsx's
 * own header comment).
 */
export async function hydrateParsedSegments(parsed: ParsedSegment[], defaultCabin: EditableSegment["cabin"]): Promise<EditableSegment[]> {
  const airportCodes = parsed.flatMap((s) => [s.departureAirport, s.arrivalAirport]).filter((c): c is string => !!c);
  const airlineCodes = parsed.map((s) => s.airlineCode).filter((c): c is string => !!c);
  const aircraftCodes = parsed.map((s) => s.aircraft).filter((c): c is string => !!c);
  const [airportMap, airlineMap, aircraftMap] = await Promise.all([
    resolveAirportCodes(airportCodes),
    resolveAirlineCodes(airlineCodes),
    resolveAircraftCodes(aircraftCodes),
  ]);

  const hydrated: EditableSegment[] = parsed.map((s) => {
    const warnings = [...s.warnings];
    const uncertainFields = [...s.uncertainFields];
    const flagField = (f: (typeof uncertainFields)[number]) => {
      if (!uncertainFields.includes(f)) uncertainFields.push(f);
    };

    const depAirport = s.departureAirport ? airportMap[s.departureAirport] : null;
    const arrAirport = s.arrivalAirport ? airportMap[s.arrivalAirport] : null;
    if (s.departureAirport && !depAirport) {
      warnings.push({ field: "departureAirport", message: `Airport code "${s.departureAirport}" not found — select manually` });
      flagField("departureAirport");
    }
    if (s.arrivalAirport && !arrAirport) {
      warnings.push({ field: "arrivalAirport", message: `Airport code "${s.arrivalAirport}" not found — select manually` });
      flagField("arrivalAirport");
    }
    const airline = s.airlineCode ? airlineMap[s.airlineCode] : null;
    if (s.airlineCode && !airline) {
      warnings.push({ field: "airline", message: `Airline code "${s.airlineCode}" not found — select manually` });
      flagField("airline");
    }
    const aircraft = s.aircraft ? aircraftMap[s.aircraft] : null;

    return {
      clientId: crypto.randomUUID(),
      departureAirport: depAirport ?? null,
      arrivalAirport: arrAirport ?? null,
      departureDate: s.departureDate ?? "",
      departureTime: s.departureTime ?? "",
      // Never silently default a genuinely-unknown arrival date to the
      // departure date — that produces a plausible-looking but wrong
      // value. Leave it empty so the amber "needs review" highlight is
      // the only thing the agent sees, not a confident-looking guess.
      arrivalDate: s.arrivalDate ?? "",
      arrivalTime: s.arrivalTime ?? "",
      airline: airline ?? null,
      airlineCodeRaw: s.airlineCode ?? "",
      flightNumber: s.flightNumber ?? "",
      bookingClass: s.bookingClass ?? "",
      // The parser's cabin guess is a generic RBD heuristic, never
      // authoritative — it's applied here only as a starting point and
      // stays flagged in uncertainFields until the agent confirms it.
      cabin: s.cabinGuess ?? defaultCabin,
      aircraft: aircraft ?? null,
      aircraftRaw: s.aircraft ?? "",
      operatingCarrierName: s.operatingCarrierName ?? "",
      warnings,
      uncertainFields,
      isExtraLeg: false,
      durationOverrideMinutes: null,
    };
  });

  // Default the connection type from the actual time gap between
  // segments: a short gap reads as a connecting/layover flight, a long
  // one (e.g. a return flight days later) reads as a separate leg. The
  // agent can always override via the connector control.
  for (let i = 1; i < hydrated.length; i++) {
    const prev = hydrated[i - 1];
    const cur = hydrated[i];
    if (prev.arrivalDate && prev.arrivalTime && cur.departureDate && cur.departureTime) {
      const gapMinutes = calculateFlightDurationMinutes(
        `${prev.arrivalDate}T${prev.arrivalTime}:00`,
        prev.arrivalAirport?.timezone,
        `${cur.departureDate}T${cur.departureTime}:00`,
        cur.departureAirport?.timezone
      );
      if (gapMinutes >= 0 && gapMinutes <= 24 * 60) {
        cur.connectionType = "LAYOVER";
      }
    }
  }

  return hydrated;
}
