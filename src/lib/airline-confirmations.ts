import { z } from "zod";

/**
 * Pass 23 — one airline confirmation/PNR entry on a Booking. A booking may
 * have several of these (codeshares, separate outbound/return
 * reservations, multiple tickets) — `confirmationNumber` is the only
 * required field; `airlineIata` and `eTicketNumbers` are both genuinely
 * optional (not every workflow has an e-ticket number yet at
 * confirmation-send time, and not every confirmation has a resolvable
 * airline).
 */
export const airlineConfirmationEntrySchema = z.object({
  id: z.string().min(1),
  airlineIata: z.string().trim().nullable().optional().transform((v) => (v && v.length > 0 ? v : null)),
  confirmationNumber: z.string().trim().min(1),
  eTicketNumbers: z.array(z.string().trim().min(1)).optional().default([]),
});

export type AirlineConfirmationEntry = z.infer<typeof airlineConfirmationEntrySchema>;

const storedArraySchema = z.array(airlineConfirmationEntrySchema);

/**
 * The one place that decides "what are this booking's confirmations" —
 * used by both the ticketing-form data loader and
 * sendAirlineConfirmationEmail, so the two can never disagree. Prefers the
 * new `airlineConfirmations` array whenever it's genuinely present — an
 * empty array (`[]`, distinct from SQL NULL) means an agent explicitly
 * saved zero rows and is honored as such, never resurrecting stale legacy
 * values; only a true `null` (never touched by Pass 23, or unparseable/
 * malformed data) falls back to synthesizing a single-entry array from
 * the legacy `airlineConfirmationNumber`/`ticketNumbers` fields. Malformed
 * JSON in `airlineConfirmations` is treated the same as absent — never
 * thrown — since this reads from possibly-old data, not a value this
 * process wrote.
 */
export function resolveAirlineConfirmations(booking: {
  airlineConfirmations: unknown;
  airlineConfirmationNumber: string | null;
  ticketNumbers: unknown;
}): AirlineConfirmationEntry[] {
  const parsed = storedArraySchema.safeParse(booking.airlineConfirmations);
  if (parsed.success) return parsed.data;

  if (!booking.airlineConfirmationNumber) return [];
  const legacyTickets = z.array(z.string()).safeParse(booking.ticketNumbers);
  return [
    {
      id: "legacy",
      airlineIata: null,
      confirmationNumber: booking.airlineConfirmationNumber,
      eTicketNumbers: legacyTickets.success ? legacyTickets.data.filter(Boolean) : [],
    },
  ];
}

/**
 * Backward-compatibility mirror — every save that sets `airlineConfirmations`
 * also writes these two legacy fields (first entry's confirmation number,
 * every entry's e-tickets flattened) so any as-yet-unaudited reader of the
 * old single-value fields keeps working unchanged. Never the other
 * direction — the legacy fields are never treated as authoritative once
 * `airlineConfirmations` has been saved at least once.
 */
export function toLegacyBookingFields(entries: AirlineConfirmationEntry[]): {
  airlineConfirmationNumber: string | null;
  ticketNumbers: string[];
} {
  return {
    airlineConfirmationNumber: entries[0]?.confirmationNumber ?? null,
    ticketNumbers: entries.flatMap((e) => e.eTicketNumbers),
  };
}
