# CRM Commissions and Salesboard UI Audit

Date: 2026-11-15. Scope: `compass-tools-updated`. Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN.

## 1. Previous-period comparison text

**State found:** already removed in the working tree that was committed on the review branch (`src/components/crm/period-kpi.tsx` renders only the label and the value; the previous-period helpers `previousEquivalentRange` / `percentChange` remain in `lib/pay-period.ts` and are no longer used by any page). A search of the whole source for "vs previous" in non-test code finds only a code comment. **No further change was needed.**

| Check | Result |
| --- | --- |
| Commissions: no percentage change, no "vs previous", no previous pay-period dates, in any view (all/own, pay period, month, custom) | PASSED (`commissions/__tests__/page.test.tsx`) |
| Salesboard: totals and average shown with no comparison text | PASSED (`salesboard/__tests__/page.test.tsx`) |
| Figures and calculations unchanged | PASSED (`pay-period.test.ts`, page tests; `commissions.ts` queries untouched) |
| Layout | The KPI block is a label over a value, so no empty line is left behind. Not visually checked in a browser. |

## 2. Salesboard date-range picker (changed)

**State found:** Commissions already had a modern calendar popover for its custom From / To range (`src/components/commissions/range-date-fields.tsx`, enabled through `ReportRangeControls modernCalendar`). **Salesboard still used the browser's native `<input type="date">` fields** - the "outdated" control the request describes.

**Changes:**
1. `salesboard/page.tsx` now passes `modernCalendar`, so Salesboard and Commissions use the **same** date-range control (no second implementation, no new dependency; it is the app's existing `Calendar` / react-day-picker).
2. The calendar now **highlights the whole chosen range**: the first and last day are the strongly styled "selected" day, the days between are softly shaded (`inRange` modifier), in both the From and the To popover; a reversed or incomplete range highlights nothing.

**Unchanged on purpose (verified):** the form is still a plain GET form submitting `from` and `to` as `yyyy-MM-dd`; the server resolves them with the one range resolver (`lib/pay-period.ts`), so every pay-period boundary, the reversed-range warning ("showing the current pay period instead"), and the timezone rules are exactly as before. The quick ranges, the pay-period selector and the "Show" / "Apply range" buttons are identical. Dates are picked and shown as local calendar days (no UTC conversion): tested in America/Los_Angeles, Asia/Tokyo, Pacific/Kiritimati and UTC. Keyboard: arrow keys move between days, Enter picks, month navigation buttons are labelled; clicking the selected day does not blank the field.

**Apply / cancel behaviour:** the existing interaction is "pick two dates, press **Apply range**"; Escape or a click outside closes a popover without changing the field. That interaction was kept rather than inventing a second apply step.

**Mobile:** the popover is a single-month calendar; the form wraps. Not checked on a device.

## 3. Test status

| Suite | Result |
| --- | --- |
| `range-date-fields.test.tsx` (21: triggers, month navigation, exact local dates, boundaries/leap year, time zones, keyboard, required-both rule, reversed range goes to the server, opt-in markup incl. **Salesboard uses the same control**, range highlight in both popovers, nothing highlighted for reversed/incomplete ranges) | PASSED |
| Salesboard and Commissions page tests | PASSED |
| Visual review in a browser (desktop and phone) | NOT RUN - the signed-in pages need a database |
