import {
  parseGdsDate,
  parseGdsTime,
  resolveArrivalDate,
  resolveDayPairOffset,
  getWeekdayCode,
  minutesBetween,
  guessCabinFromBookingClass,
  type ParsedSegment,
  type ParsedFieldKey,
  type ParsedGdsTime,
  type ParsedWarning,
} from "./shared";

// Real IATA 2-char airline codes always contain at least one letter (BA,
// 5J, 9W, B6, 2P, ...) — never two digits. Requiring a letter here stops
// pure-numeric tokens like a "600P" time from being misread as an airline.
const AIRLINE_CODE_RE = "(?:[A-Z][A-Z0-9]|[0-9][A-Z])";
const AIRLINE_FLIGHT_RE = new RegExp(`^(${AIRLINE_CODE_RE})(\\d{1,4})([A-Z])?$`, "i");
const AIRLINE_ONLY_RE = new RegExp(`^${AIRLINE_CODE_RE}$`, "i");
const FLIGHT_ONLY_RE = /^(\d{1,4})([A-Z])?$/i;
// Optional trailing 2-digit year (e.g. "25SEP26") — see parseGdsDate.
const DATE_RE = /^\d{1,2}[A-Z]{3}(\d{2})?$/i;
const ROUTE_6_RE = /^[A-Z]{6}$/i;
const ROUTE_HYPHEN_RE = /^([A-Z]{3})[-/]([A-Z]{3})$/i;
const AIRPORT_3_RE = /^[A-Z]{3}$/i;
// Accepts an optional colon ("6:30P"), an A/P or AM/PM suffix (or none, for
// 24h "1830"), an optional trailing day offset with or without an explicit
// sign and with or without a digit ("725P1"/"725P+1" = arrives 1 day
// later, "1100P-1" = 1 day earlier, "1225P+" = 1 day later with no digit —
// see parseGdsTime), and an optional trailing "*" e-ticket flag glued
// directly on with no space ("1225P+*").
const TIME_RE = /^\d{1,2}:?\d{2}(?:[AP]M?)?[+-]?[1-9]?\*?$/i;
const DAY_OF_WEEK_RE = /^(MO|TU|WE|TH|FR|SA|SU)$/i;
// Compound departure/arrival day-of-week pair, e.g. "TH/FR" or "TH/WE" —
// see resolveDayPairOffset in shared.ts for how this becomes a day offset.
const DAY_PAIR_RE = /^(MO|TU|WE|TH|FR|SA|SU)\/(MO|TU|WE|TH|FR|SA|SU)$/i;
// A standalone explicit day-offset token, e.g. "+1"/"-2", appearing as its
// own token rather than fused onto the arrival time — the highest-priority
// signal when present (see the priority chain below parseGdsLine's loop).
const STANDALONE_OFFSET_RE = /^([+-])([1-9])$/;
const STATUS_RE = /^[A-Z]{2}\d{1,2}$/i;
// A booking-status token (e.g. "SS1", "HK1") is structurally identical to an
// airline+flight-number token (e.g. "SS1" could be airline "SS" flight "1").
// These are the standard IATA/GDS PNR action codes — checked with priority
// over the generic airline pattern so a real status code is never
// misread as an airline when no unambiguous airline+flight token exists on
// the line.
const KNOWN_STATUS_PREFIXES = new Set([
  "HK", "KK", "KL", "SS", "RR", "UN", "UC", "US", "TK", "HL", "HN", "HX",
  "NO", "GK", "PN", "SC", "WK", "WL", "DS", "HD", "HQ", "TL", "XL", "XX", "NN",
]);
function isKnownStatusToken(token: string): boolean {
  const m = STATUS_RE.exec(token);
  return !!m && KNOWN_STATUS_PREFIXES.has(token.slice(0, 2).toUpperCase());
}
// Common IATA equipment/aircraft-type shorthand: 2-3 digits with an
// optional trailing letter (738, 320, 77W, 32N, 788). Always surfaced as a
// raw code for the UI to resolve against the aircraft database — never
// translated to a manufacturer/model name here.
const EQUIPMENT_RE = /^\d{2,3}[A-Z]?$/i;

/**
 * Generic GDS shorthand line classifier shared by the Sabre/SWAN and Apollo
 * parsers — both formats derive from the same airline SSR/PNR shorthand
 * conventions (airline+flight+class, DDMMM date, city pair, HHMM times).
 * Fields the parser can't confidently determine are left undefined and
 * reported in `warnings`/`uncertainFields` for manual correction — never
 * guessed.
 */
export function parseGdsLine(rawLine: string, sequence: number, referenceYear: number): ParsedSegment | null {
  const line = rawLine.trim();
  if (!line) return null;

  // Strip stray leading/trailing punctuation a messy copy-paste can leave on
  // an otherwise-valid token (e.g. a trailing comma) — never touches
  // hyphens or plus/minus signs, which are meaningful inside a token
  // (route separator, time day-offset sign).
  //
  // Sabre/SWAN "I" itinerary displays routinely glue a "*" e-ticket/status
  // flag directly onto the PRECEDING token with no space at all (e.g.
  // "SYDDOH*SS1", "DUBDOH*SS1"), unlike Apollo which only ever fuses "*"
  // onto a time ("535A2*"). A whitespace-only split leaves "SYDDOH*SS1" as
  // one token that matches neither the 6-letter route pattern nor a status
  // code, silently dropping the airport pair. Splitting every token on "*"
  // (keeping the "*" itself as its own token, so the existing bare-"*"
  // e-ticket-flag handling below still applies to it) turns that one token
  // into three independently-classifiable ones — "SYDDOH", "*", "SS1" — and
  // is a no-op for tokens that never contained a "*" to begin with.
  const tokens = line
    .split(/\s+/)
    .flatMap((t) => t.split(/(\*)/).filter((part) => part.length > 0))
    .map((t) => t.replace(/^[,.;]+|[,.;]+$/g, ""));
  const warnings: ParsedWarning[] = [];
  const uncertainFields: ParsedFieldKey[] = [];

  let airlineCode: string | undefined;
  let flightNumber: string | undefined;
  let bookingClass: string | undefined;
  let departureAirport: string | undefined;
  let arrivalAirport: string | undefined;
  let departureDate: string | undefined;
  let explicitArrivalDate: string | undefined;
  let hasExplicitYear: boolean | undefined;
  let dayOfWeek: string | undefined;
  let dayOfWeekPair: { dep: string; arr: string } | undefined;
  let explicitOffsetToken: number | undefined;
  let aircraft: string | undefined;
  const times: ParsedGdsTime[] = [];
  const looseAirports: string[] = [];
  let matchedAnyToken = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];

    if (isKnownStatusToken(token)) {
      // Booking status code (SS1, HK1, ...) — checked before the airline
      // pattern since the two are structurally indistinguishable.
      matchedAnyToken = true;
      continue;
    }
    if (!airlineCode && AIRLINE_FLIGHT_RE.test(token)) {
      const m = AIRLINE_FLIGHT_RE.exec(token)!;
      airlineCode = m[1].toUpperCase();
      flightNumber = m[2];
      if (m[3]) bookingClass = m[3].toUpperCase();
      matchedAnyToken = true;
      continue;
    }
    // Reasonable variation: airline code and flight number as separate
    // tokens (e.g. "BA 1460" instead of "BA1460").
    if (!airlineCode && AIRLINE_ONLY_RE.test(token) && next && FLIGHT_ONLY_RE.test(next) && !DATE_RE.test(token)) {
      const m = FLIGHT_ONLY_RE.exec(next)!;
      airlineCode = token.toUpperCase();
      flightNumber = m[1];
      if (m[2]) bookingClass = m[2].toUpperCase();
      matchedAnyToken = true;
      i++; // consume the peeked flight-number token
      continue;
    }
    if (!departureDate && DATE_RE.test(token)) {
      const parsed = parseGdsDate(token, referenceYear);
      if (parsed) {
        departureDate = parsed;
        hasExplicitYear = /^\d{1,2}[A-Z]{3}\d{2}$/i.test(token);
        matchedAnyToken = true;
        continue;
      }
    }
    // A second, later date-shaped token on the same line is a genuine GDS
    // convention some fuller "I" itinerary displays use to spell out the
    // arrival date explicitly (e.g. Sabre/Apollo's "...2010 0400 08MAY 6...")
    // rather than leaving it to be inferred from the times — the single
    // most authoritative signal available when present, since it's a
    // literal statement of the date rather than anything derived. Takes
    // priority over every offset-inference path below.
    if (departureDate && !explicitArrivalDate && DATE_RE.test(token)) {
      const parsed = parseGdsDate(token, referenceYear);
      if (parsed) {
        explicitArrivalDate = parsed;
        matchedAnyToken = true;
        continue;
      }
    }
    if (!departureAirport && ROUTE_6_RE.test(token)) {
      departureAirport = token.slice(0, 3).toUpperCase();
      arrivalAirport = token.slice(3, 6).toUpperCase();
      matchedAnyToken = true;
      continue;
    }
    if (!departureAirport && ROUTE_HYPHEN_RE.test(token)) {
      const m = ROUTE_HYPHEN_RE.exec(token)!;
      departureAirport = m[1].toUpperCase();
      arrivalAirport = m[2].toUpperCase();
      matchedAnyToken = true;
      continue;
    }
    if (!departureAirport && AIRPORT_3_RE.test(token) && looseAirports.length < 2) {
      looseAirports.push(token.toUpperCase());
      matchedAnyToken = true;
      continue;
    }
    if (token === "*") {
      // A bare "*" in GDS shorthand marks e-ticket eligibility / a codeshare
      // flag, not a day change — day rollover is inferred from the actual
      // departure/arrival clock times below, never guessed from this marker.
      matchedAnyToken = true;
      continue;
    }
    if (explicitOffsetToken === undefined && STANDALONE_OFFSET_RE.test(token)) {
      const m = STANDALONE_OFFSET_RE.exec(token)!;
      explicitOffsetToken = (m[1] === "-" ? -1 : 1) * Number(m[2]);
      matchedAnyToken = true;
      continue;
    }
    if (!dayOfWeekPair && DAY_PAIR_RE.test(token)) {
      const m = DAY_PAIR_RE.exec(token)!;
      dayOfWeekPair = { dep: m[1].toUpperCase(), arr: m[2].toUpperCase() };
      matchedAnyToken = true;
      continue;
    }
    if (!dayOfWeek && DAY_OF_WEEK_RE.test(token)) {
      dayOfWeek = token.toUpperCase();
      matchedAnyToken = true;
      continue;
    }
    if (STATUS_RE.test(token)) {
      // Booking status code (SS1, HK1, ...) — not needed for the itinerary.
      matchedAnyToken = true;
      continue;
    }
    if (times.length < 2 && TIME_RE.test(token)) {
      const parsed = parseGdsTime(token);
      if (parsed) {
        times.push(parsed);
        matchedAnyToken = true;
        continue;
      }
    }
    // Sequence number leading the line, e.g. "1" or "2."
    if (/^\d{1,2}\.?$/.test(token) && sequence === Number(token.replace(".", ""))) {
      matchedAnyToken = true;
      continue;
    }
    if (!aircraft && EQUIPMENT_RE.test(token)) {
      aircraft = token.toUpperCase();
      matchedAnyToken = true;
      continue;
    }
  }

  if (!matchedAnyToken) return null;

  if (!departureAirport && looseAirports.length === 2) {
    departureAirport = looseAirports[0];
    arrivalAirport = looseAirports[1];
  }

  const departureTime = times[0]?.time;
  const arrivalTime = times[1]?.time;
  // GDS output puts the explicit day-offset marker on the arrival time only
  // (e.g. "600P 725P1") — it's meaningless on a departure time.
  const fusedMarkerOffset = times[1]?.dayOffset ?? 0;
  const dayPairOffset = dayOfWeekPair ? resolveDayPairOffset(dayOfWeekPair.dep, dayOfWeekPair.arr) : undefined;

  // Priority order (strongest first): a standalone explicit "+1"/"-2" token
  // > a day-offset marker fused onto the arrival time ("725P+1") > a
  // departure/arrival day-of-week pair ("TH/FR") inferred offset > (inside
  // resolveArrivalDate) the plain arrival-clock-earlier-than-departure
  // fallback. A weaker signal never overrides a stronger one that's
  // actually present — 0 is treated as "no fused-marker signal" (matching
  // resolveArrivalDate's own convention) since a bare time with no marker
  // carries no offset information either way.
  const offsetCandidates: number[] = [];
  if (explicitOffsetToken !== undefined) offsetCandidates.push(explicitOffsetToken);
  if (fusedMarkerOffset !== 0) offsetCandidates.push(fusedMarkerOffset);
  if (dayPairOffset !== undefined) offsetCandidates.push(dayPairOffset);
  const offsetConflict = new Set(offsetCandidates).size > 1;

  const effectiveOffset =
    explicitOffsetToken !== undefined ? explicitOffsetToken
    : fusedMarkerOffset !== 0 ? fusedMarkerOffset
    : dayPairOffset !== undefined ? dayPairOffset
    : 0;

  // True when NONE of the three explicit day-offset signals is present at
  // all (as opposed to a signal that happens to resolve to 0, e.g. a
  // TU/TU day-of-week pair confirming same-day — that's still a real,
  // confident signal, not an absence of one).
  const noExplicitOffsetSignal = explicitOffsetToken === undefined && fusedMarkerOffset === 0 && dayPairOffset === undefined;

  let arrivalDate: string | undefined;
  if (explicitArrivalDate) {
    // A literal arrival-date token beats every inferred/offset-derived path
    // — nothing to compute, nothing to guess.
    arrivalDate = explicitArrivalDate;
  } else if (departureDate && departureTime && arrivalTime) {
    arrivalDate = resolveArrivalDate(departureDate, departureTime, arrivalTime, effectiveOffset);
  }

  let durationMinutes: number | undefined;
  if (departureDate && departureTime && arrivalDate && arrivalTime) {
    durationMinutes = minutesBetween(departureDate, departureTime, arrivalDate, arrivalTime);
  }

  if (!airlineCode) {
    warnings.push({ field: "airline", message: "Airline code could not be determined" });
    uncertainFields.push("airline");
  }
  if (!flightNumber) {
    warnings.push({ field: "flightNumber", message: "Flight number could not be determined" });
    uncertainFields.push("flightNumber");
  }
  if (!departureAirport) {
    warnings.push({ field: "departureAirport", message: "Departure airport could not be determined" });
    uncertainFields.push("departureAirport");
  }
  if (!arrivalAirport) {
    warnings.push({ field: "arrivalAirport", message: "Arrival airport could not be determined" });
    uncertainFields.push("arrivalAirport");
  }
  if (!departureDate) {
    warnings.push({ field: "departureDate", message: "Departure date could not be determined" });
    uncertainFields.push("departureDate");
  }
  if (!departureTime) {
    warnings.push({ field: "departureTime", message: "Departure time could not be determined" });
    uncertainFields.push("departureTime");
  }
  if (!arrivalTime) {
    warnings.push({ field: "arrivalTime", message: "Arrival time could not be determined" });
    uncertainFields.push("arrivalTime");
  } else if (!arrivalDate) {
    warnings.push({ field: "arrivalDate", message: "Arrival date could not be determined" });
    uncertainFields.push("arrivalDate");
  } else if (offsetConflict) {
    // Multiple present day-offset signals disagree (e.g. a fused "+1"
    // marker vs. a day-of-week pair implying +2) — the higher-priority
    // signal was used, but this is surfaced rather than silently resolved
    // so the agent can verify/correct it.
    warnings.push({
      field: "arrivalDate",
      message: `Arrival date signals disagree (used ${effectiveOffset >= 0 ? "+" : ""}${effectiveOffset} day${Math.abs(effectiveOffset) === 1 ? "" : "s"}) — please verify`,
    });
    uncertainFields.push("arrivalDate");
  } else if (!explicitArrivalDate && noExplicitOffsetSignal && arrivalTime < departureTime) {
    // Genuinely ambiguous from the raw text alone: the arrival clock reads
    // earlier than departure, but there is no explicit day-offset marker
    // (no fused +/digit, no standalone +N/-N token, no day-of-week pair) to
    // say whether that's because a calendar day actually passed (an
    // ordinary overnight flight — real GDS output usually does mark this
    // explicitly, but not always) or because the two airports' local clocks
    // differ enough that a same-day arrival can still read "earlier" (e.g.
    // a westbound date-line crossing). This parser has no per-airport
    // timezone data to disambiguate (it deliberately never looks anything
    // up), so it defaults to same-day and — matching this parser's own
    // "never guess silently" design — flags it for the agent to confirm or
    // correct rather than picking a value with unwarranted confidence.
    warnings.push({
      field: "arrivalDate",
      message: "Arrival clock time is earlier than departure with no explicit day-change marker on the line — defaulted to the same day; please verify against the actual flight time",
    });
    uncertainFields.push("arrivalDate");
  }

  // §14: cross-check parsed day-of-week token(s) against the date(s) the
  // parser actually computed — flags a disagreement without ever blocking
  // save, since the agent can always correct either field manually.
  const depDowToken = dayOfWeekPair?.dep ?? dayOfWeek;
  if (departureDate && depDowToken && getWeekdayCode(departureDate) !== depDowToken) {
    warnings.push({
      field: "departureDate",
      message: `Departure date doesn't fall on a ${depDowToken} — please verify`,
    });
    if (!uncertainFields.includes("departureDate")) uncertainFields.push("departureDate");
  }
  if (arrivalDate && dayOfWeekPair?.arr && getWeekdayCode(arrivalDate) !== dayOfWeekPair.arr && !offsetConflict) {
    warnings.push({
      field: "arrivalDate",
      message: `Arrival date doesn't fall on a ${dayOfWeekPair.arr} — please verify`,
    });
    if (!uncertainFields.includes("arrivalDate")) uncertainFields.push("arrivalDate");
  }

  // Booking class itself is never uncertain when a token was actually
  // matched — it was read directly off the line, not guessed. Only the
  // booking-class → cabin mapping is a heuristic, and only flagged as
  // uncertain when it genuinely couldn't be resolved: an unrecognized RBD
  // letter, or no booking class present at all. A confidently-mapped cabin
  // is populated and left unflagged, so the agent isn't asked to manually
  // confirm information the GDS code already made clear.
  const cabinGuess = guessCabinFromBookingClass(bookingClass);
  if (bookingClass && !cabinGuess) {
    warnings.push({ field: "cabin", message: `Booking class "${bookingClass}" has no default cabin mapping — please select cabin manually` });
    uncertainFields.push("cabin");
  } else if (!bookingClass) {
    uncertainFields.push("cabin");
  }

  return {
    sequence,
    airlineCode,
    flightNumber,
    bookingClass,
    cabinGuess,
    departureAirport,
    arrivalAirport,
    departureDate,
    hasExplicitYear,
    departureTime,
    arrivalDate,
    arrivalTime,
    dayOfWeek,
    dayOfWeekPair,
    aircraft,
    durationMinutes,
    raw: rawLine,
    warnings,
    uncertainFields,
  };
}

function addYearsIso(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

/**
 * Corrects for itineraries that cross a year boundary (GDS output has no
 * year, so each line is initially parsed against the same `referenceYear`).
 * A segment's date must never be earlier than the previous segment's — if
 * it is, the itinerary rolled into the next year and every subsequent
 * segment's year is bumped by the same cumulative offset.
 */
function correctYearRollover(segments: ParsedSegment[]): void {
  let yearOffset = 0;
  let previousDate: string | undefined;

  for (const seg of segments) {
    if (!seg.departureDate) continue;
    if (yearOffset > 0) {
      seg.departureDate = addYearsIso(seg.departureDate, yearOffset);
      if (seg.arrivalDate) seg.arrivalDate = addYearsIso(seg.arrivalDate, yearOffset);
    }
    if (previousDate && seg.departureDate < previousDate) {
      yearOffset += 1;
      seg.departureDate = addYearsIso(seg.departureDate, 1);
      if (seg.arrivalDate) seg.arrivalDate = addYearsIso(seg.arrivalDate, 1);
    }
    previousDate = seg.departureDate;

    if (seg.departureDate && seg.departureTime && seg.arrivalTime && !seg.arrivalDate) {
      seg.arrivalDate = resolveArrivalDate(seg.departureDate, seg.departureTime, seg.arrivalTime);
    }
    if (seg.departureDate && seg.departureTime && seg.arrivalDate && seg.arrivalTime) {
      seg.durationMinutes = minutesBetween(seg.departureDate, seg.departureTime, seg.arrivalDate, seg.arrivalTime);
    }
  }
}

// A standalone continuation line naming the operating carrier for a
// codeshare flight (e.g. "        OPERATED BY PAL EXPRESS"), rather than a
// segment line of its own — it has no sequence/date/route tokens, so it's
// intercepted before parseGdsLine ever sees it (which would otherwise risk
// misreading a fragment like "PAL" as a loose 3-letter airport code).
const OPERATED_BY_RE = /^OPERATED\s+BY\s+(.+)$/i;

/**
 * If the WHOLE itinerary (its earliest segment) resolved to a date already
 * before `today`, the paste almost certainly meant next year — a GDS code
 * with no year has no way to say "2027" on its own, so an unqualified date
 * that's already passed this year is the one case referenceYear's plain
 * "current calendar year" default gets wrong. Bumps every segment by the
 * same +1 year (preserves whatever relative ordering they already had,
 * trivially, since the same constant is added to each) — correctYearRollover
 * still runs afterward to handle genuine cross-segment boundary crossings on
 * top of this. Never fires if ANY segment had an explicit embedded year
 * (rule: never override what the source itinerary was already explicit
 * about) — deliberately whole-itinerary, not per-segment, since an itinerary
 * mixing an inferred date with an explicit one elsewhere is rare enough that
 * trusting the user's explicit signal everywhere is the safer default.
 */
function rollForwardIfEntirelyPast(segments: ParsedSegment[], today: Date): void {
  if (segments.some((s) => s.hasExplicitYear)) return;
  const earliest = segments.reduce<string | undefined>(
    (min, s) => (s.departureDate && (!min || s.departureDate < min) ? s.departureDate : min),
    undefined
  );
  if (!earliest || earliest >= today.toISOString().slice(0, 10)) return;
  for (const seg of segments) {
    if (seg.departureDate) seg.departureDate = addYearsIso(seg.departureDate, 1);
    if (seg.arrivalDate) seg.arrivalDate = addYearsIso(seg.arrivalDate, 1);
  }
}

/**
 * `today`, when provided, enables rollForwardIfEntirelyPast above — omitted
 * by default (and by every existing test, all of which pass an explicit
 * numeric `referenceYear` and expect it honored verbatim) so this stays
 * fully opt-in and never makes an existing deterministic test depend on the
 * real wall-clock date. The one real caller, quote-builder.tsx, passes the
 * actual current date.
 */
export function parseGdsItinerary(text: string, referenceYear: number = new Date().getFullYear(), today?: Date): ParsedSegment[] {
  const lines = text.split(/\r?\n/);
  const segments: ParsedSegment[] = [];
  let seq = 1;
  for (const line of lines) {
    const operatedByMatch = OPERATED_BY_RE.exec(line.trim());
    if (operatedByMatch) {
      const previous = segments[segments.length - 1];
      if (previous) previous.operatingCarrierName = operatedByMatch[1].trim();
      continue;
    }
    const parsed = parseGdsLine(line, seq, referenceYear);
    if (parsed) {
      parsed.sequence = seq;
      segments.push(parsed);
      seq++;
    }
  }
  if (today) rollForwardIfEntirelyPast(segments, today);
  correctYearRollover(segments);
  return segments;
}
