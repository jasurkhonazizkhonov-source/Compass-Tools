# Pay periods, Salesboard and Commissions

## The official pay-period model

Exactly **two pay periods per calendar month**, covering **every day** (no gap, no third period):

| Period | From | Through (inclusive) |
|---|---|---|
| **Period 1** | the **21st of the previous month** | the **5th** of the current month |
| **Period 2** | the **6th** | the **20th** of the current month |

So the 1st–5th belong to that month's Period 1, the 6th–20th to its Period 2, and the **21st → end of month belong to the NEXT month's Period 1**. Examples: January Period 1 = Dec 21 → Jan 5; February Period 1 = Jan 21 → Feb 5; the 28th/29th of February and the 30th/31st of any month are in the next month's Period 1.

A period has a deterministic key, e.g. `2026-11-P1` (the month in the key is the month the period **ends** in). Source: `src/lib/pay-period.ts`. Nothing about pay periods is stored: the active period is computed from today's date and an older period is just a date range, so **no table was added and no historical sale or commission is ever deleted, reset or rewritten.**

### "Reset" means "show the new period"
On the 6th and on the 21st the default view of the Salesboard and Commissions pages simply becomes the new period (the flip happens at 00:00 **business time**, see below). Nobody has to press anything. The previous period stays one click away (Previous Pay Period, the pay-period list, or a From/To range). The active commission starts at zero because no sale has been confirmed inside the new window yet — not because anything was zeroed.

## Business time zone
Boundaries are **calendar days in `America/Los_Angeles`** — the zone the CRM already uses for the Pacific clock, lead-capture times and the Salesboard's own day/week logic — never UTC and never the server's ambient zone. Conversion to instants is daylight-saving-aware (a period that spans a clock change is 23 or 25 hours different in elapsed time but still covers exactly its calendar days). A sale confirmed at 23:59 on the 5th Pacific is in Period 1 even though it is already the 6th in UTC.
**REQUIRES BUSINESS CONFIRMATION:** that payroll really cuts over at midnight Pacific. The code uses the one existing convention; it does not invent a new zone. Changing it is a one-line change to `BUSINESS_TIMEZONE`.

## What date makes a sale count
A booking counts once it is **CONFIRMED with a computed profit** (unchanged). The date it counts **on** is the moment it was last moved to CONFIRMED, read from `BookingStatusHistory` (`src/server/queries/sales-range.ts`, `SALE_AT_SQL`).

This replaces `Booking.updatedAt`, which was the previous anchor. `updatedAt` moves on **every** later save (ticket numbers, notes, the airline-confirmation email claim, a profit recompute), so with pay periods a confirmed sale would have jumped into a later period the next time anyone touched the booking and a closed period's totals would have changed after the fact. A booking confirmed before status history existed has no history row; for those `updatedAt` is kept as the fallback so nothing disappears. A booking reverted and re-confirmed counts once, on its latest confirmation. Whether the *original* confirmation or the *latest* should be used for a re-confirmed booking is a business call; the latest is used because the booking is not a sale while it is not confirmed.

Commission math is unchanged: `profit × the quote owner's commission %` (plus the existing tip logic), computed at query time from the booking and the agent's rate — never stored, so there is nothing to double count.

## Reporting UI
Both pages share one control (`ReportRangeControls`) and one resolver (`resolveReportRange`):

* quick selectors — **Current Pay Period**, **Previous Pay Period**, **Current Month**, **Previous Month** (the Salesboard also keeps **This Year** and **All Time**; old `?period=today|week|month|year|all` links still work);
* a list of the last 12 official pay periods;
* explicit **From / To** dates (inclusive of both days). Bad, reversed or half-filled dates show a message and fall back to the current pay period — they never throw and never widen the range.

The page states what is shown: *Current Pay Period — Pay Period 2 · Nov 6 – Nov 20, 2026*. On Commissions the summary is titled **Current Period Commission**, **Previous Period Commission** or **Custom Range Commission**, so a historical or custom figure is never mistaken for the active one. KPI cards compare with the previous equivalent period (a pay period vs the previous pay period, a month vs the previous month, any other range vs the same number of days before it); a previous value of zero shows "No earlier figure to compare" — never Infinity or NaN. Only metrics the data supports are shown (profit, confirmed bookings, average profit per booking, commission, tips); there is no sale-price total because the Salesboard has never measured one.

## Who sees what (date filters never change this)
* **Salesboard** — unchanged: every signed-in role, company-wide leaderboard, hidden accounts left off (in every range).
* **Commissions** — unchanged: Admin sees everyone (and may filter to one user, hidden accounts included, as before); Manager and Travel Agent see **only their own** sales whatever dates or `user=` they ask for. Another company's data is never included.

## Proof
`src/lib/__tests__/pay-period.test.ts` (every day of eight years incl. leap years; DST; year boundary; no third period), `src/server/queries/__integration__/pay-period-reporting.integration.test.ts` (REAL PostgreSQL: exact boundary instants, the 5th/6th/20th/21st, year boundary, stability after later edits, partition = whole, hidden users, other companies, per-role scope, commission math), and page tests for both screens.
