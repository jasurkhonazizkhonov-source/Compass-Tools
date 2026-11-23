// How a lead's date flexibility is shown to staff (the lead page's Travel Request card and the "new flight request" e-mails): in the customer's own terms, not as a bare Yes/No.
//
// The data: `flexibleDates` (Boolean, as ever) and `dateFlexibilityDays` (the website form's choice: 0 = exact dates, 1-3 = days either side; null = not stated, which is every older lead,
// a lead typed in by staff, and a request from an old website bundle that only had a checkbox). Nothing is invented: a flexible lead with no number says only "Flexible".

export const MAX_DATE_FLEXIBILITY_DAYS = 3;

/** True for a stored/received value the database CHECK would accept (an integer 0-3). */
export function isValidDateFlexibilityDays(value: unknown): value is 0 | 1 | 2 | 3 {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_DATE_FLEXIBILITY_DAYS;
}

/**
 * "Exact dates", "± 1 day", "± 2 days", "± 3 days", or "Flexible" (flexible, number not stated). Null when nothing about flexibility is known
 * (not flexible and no number): the caller then shows no row, as before.
 */
export function describeLeadFlexibility(flexibleDates: boolean, dateFlexibilityDays: number | null | undefined): string | null {
  if (isValidDateFlexibilityDays(dateFlexibilityDays)) {
    if (dateFlexibilityDays === 0) return "Exact dates";
    return `± ${dateFlexibilityDays} day${dateFlexibilityDays === 1 ? "" : "s"}`;
  }
  return flexibleDates ? "Flexible" : null;
}

/**
 * What a staff edit of the "Flexible dates" switch does to the stored choice, so the two never contradict each other:
 *   switched ON  while the choice is "exact dates" (0)  -> flexible, number no longer known       (null)
 *   switched OFF while the choice is 1-3 days            -> exact dates                            (0)
 *   anything else                                        -> unchanged
 */
export function flexibilityDaysAfterToggle(nowFlexible: boolean, current: number | null): number | null {
  if (nowFlexible && current === 0) return null;
  if (!nowFlexible && current !== null && current > 0) return 0;
  return current;
}
