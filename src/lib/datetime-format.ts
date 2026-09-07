import { format } from "date-fns";

/**
 * The single shared "absolute short timestamp" format used across every CRM
 * list/sidebar that shows a record's created/sent/viewed/signed moment
 * (Quotes list, Bookings list, etc.) — e.g. "Aug 17, 1:24 PM". Month
 * abbreviation + day, then hour:minute AM/PM, no seconds, no year, no
 * relative ("5 minutes ago") wording. Any screen that needs this exact
 * presentation should call this function rather than inlining its own
 * `format(date, "...")` call, so the two never drift apart again.
 */
export function formatShortTimestamp(date: Date): string {
  return format(date, "MMM d, h:mm a");
}
