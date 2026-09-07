import { parseGdsItinerary } from "./gds-line";
import type { ParsedSegment } from "./shared";

/**
 * Parses Sabre/SWAN-format itinerary text. Sabre "I" itinerary displays use
 * the same underlying SSR/PNR shorthand as Apollo (airline+flight+class,
 * DDMMM date, city pair, HHMM times) but more often separate the city pair
 * with a hyphen/slash (e.g. "LHR-EDI") rather than packing it into one
 * 6-letter token. The shared classifier handles both layouts and any
 * reasonable spacing variation between them.
 */
export function parseSabreItinerary(text: string, referenceYear?: number, today?: Date): ParsedSegment[] {
  return parseGdsItinerary(text, referenceYear, today);
}
