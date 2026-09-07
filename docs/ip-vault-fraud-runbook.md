# IP Vault — fraud investigation runbook

For Admin/Manager/Ticketing Agent staff with IP vault access
(`canAccessIpVault`, granted the same way as `payments.reveal` — see
`docs/DEPLOYMENT.md` §7 for granting permissions to a new user).

## Where to start

Go to **IP Vault** in the sidebar (`/ip-vault`). The stats panel at the
top gives a quick read on volume: total captures, captures in the last 7
days, how many are already flagged `Suspicious`, and how many are
`High Risk` by the internal score (see "How risk scoring works" below).

## Investigating a specific booking

Open the booking (`/bookings/[id]`) and look at the **Submission IP**
field:

- A masked value (e.g. `203.x.x.x`) with a **Reveal** button means an IP
  was captured but you need to click through (a step-up-authenticated,
  audited action) to see the full address.
- **"Not captured"** with an info icon means nothing was captured for
  this booking — hover the icon for the specific reason (almost always:
  this environment has no `TRUSTED_PROXY` configured, which is a
  deployment configuration issue, not evidence of anything suspicious
  about the booking itself — see `docs/DEPLOYMENT.md` §5).
- If more than one signing event exists for this booking (e.g. it was
  later exchanged, or its cancellation was confirmed), a **"View full IP
  history"** link appears — showing every event with its own IP, in
  order.

## Searching across bookings

On `/ip-vault`, search by:

- **An exact IP address** — finds every signing event from that exact
  address, across every booking you have visibility into. Uses the
  encrypted vault's blind index, so this works without ever decrypting
  rows that don't match.
- **A signer email** (partial match) — finds every IP a given customer
  has signed from.
- **A date range** — browse everything captured in a window, with or
  without an IP/email.
- **"Suspicious only"** — everything a staff member has manually flagged,
  regardless of IP/email/date.

Every search here is itself a privileged, audited action — see the
**IP Vault Access Audit Log** at the bottom of the page (Admin-only): who
searched, when, how many results, and every denied attempt.

## How risk scoring works

Each captured event gets an internal `riskScore` (0–100), computed **at
capture time**, from `src/server/security/ip-risk.ts` — no external
IP-reputation, VPN-detection, or geolocation service is used anywhere;
every signal is derived purely from this app's own prior `IpCapture` rows
plus the manual `Suspicious` flag:

| Signal | Fires when | Weight |
|---|---|---|
| Velocity | 3+ signings from the same exact IP within 1 hour | 25 |
| Multiple emails, one IP | 2+ distinct signer emails have used this exact IP | 20 |
| Multiple IPs, one email | 2+ distinct IPs have been used by this signer email | 20 |
| Subnet fan-out | 3+ distinct signer emails have used this IP's /24 (v4) or /48 (v6) subnet | 15 |
| Previously flagged | This exact IP or signer email was manually marked Suspicious on an earlier capture | 50 |

Signals stack additively (capped at 100). A score of 50+ ("High Risk")
triggers an in-app Notification to every Admin/Manager at the company the
moment the row is captured — check **Notifications** for
"High-risk IP signing detected".

**Deliberately not a signal**: time-of-day / "signed at an unusual hour".
This app doesn't track a signer's own timezone or the business's own
operating hours, so any hardcoded hour range would be an arbitrary rule
dressed up as a real fraud signal — not built.

## Reviewing and acting on a result

1. **Select** one or more rows (checkbox column) to bulk **Flag
   Suspicious** or **Unflag** — this both marks the record for other
   investigators and feeds back into future risk scoring (a flagged
   IP/email reappearing on a new booking now scores 50+ on its own).
2. **Add a note** on any row (click the note icon/text) — free-text,
   visible to any other staff member with vault access, e.g. "Contacted
   customer, confirmed legitimate — traveling, using hotel wifi."
3. **Export to CSV** (capped at 5,000 rows per export — refine your
   search/date range if you hit the cap) for offline review or handing to
   a payment processor/chargeback dispute.
4. Click through to the linked **Booking** to see the full reservation,
   passengers, and payment details for context.

## What this tool does NOT do

- It does not block or auto-cancel a booking — every action here is
  investigative/informational. Actually stopping a suspected-fraudulent
  booking is a separate, manual decision through the normal
  booking/cancellation workflow.
- It does not look up geolocation, VPN/proxy status, or any third-party
  IP reputation — see the compliance doc and the "How risk scoring works"
  section above. If your team decides this is worth adding later, it
  requires choosing and budgeting a vendor (e.g. MaxMind, IPQualityScore,
  ipinfo.io) — nothing here calls one today.
- It is scoped to your own company's bookings only (the same row-level
  visibility every other page in this app already enforces) — it never
  shows another company's data, even to an Admin.
