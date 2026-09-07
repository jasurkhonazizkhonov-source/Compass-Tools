import { parseGdsItinerary } from "./gds-line";
import type { ParsedSegment } from "./shared";

/**
 * Parses Apollo-format itinerary text, e.g.:
 *   1 BA1460Y 25SEP LHREDI SS1 600P 725P * FR E
 *   2 BA1465Y 07OCT EDILHR SS1 640A 815A * WE E
 *
 * Apollo lines typically pack the departure/arrival airports into one
 * contiguous 6-letter token. Formatting varies across agencies, so this
 * defers to the shared GDS-shorthand classifier rather than fixed column
 * positions, and reports low-confidence fields via `warnings` instead of
 * guessing.
 */
export function parseApolloItinerary(text: string, referenceYear?: number, today?: Date): ParsedSegment[] {
  return parseGdsItinerary(text, referenceYear, today);
}
