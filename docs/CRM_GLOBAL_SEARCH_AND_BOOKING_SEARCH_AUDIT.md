# CRM Global Search and Booking Search Audit

Date: 2026-11-15. Scope: `compass-tools-updated`. Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN.

## 1. Ctrl+K / the search box: root cause and fix

**Symptom (reported):** clicking "Search leads, contacts, quotes..." or pressing Ctrl+K replaced the page with "This page couldn't load - Something went wrong loading this section. Try again."

**Reproduction (jsdom, mocked server action):** opening the dialog threw `TypeError: Cannot read properties of undefined (reading 'subscribe')` from `cmdk`. The text the user saw is `src/app/error.tsx`, the application's error boundary, which caught that render error.

**Root cause:** `CommandDialog` (`src/components/ui/command.tsx`) rendered its children - the `CommandInput`, `CommandList` and items - directly inside `DialogContent`, **without the `<Command>` component that owns cmdk's store**. cmdk's input subscribes to that store the moment it renders, so the first render after opening threw. The same file is byte-identical to the original CRM's, and no other screen uses `CommandDialog` (the other pickers use `<Command>` explicitly), so the defect has been there from the start and affected only global search. It was not a data, permission or route problem (the server action itself was fine).

**Fix (`command.tsx`, `global-search.tsx`):**
1. `CommandDialog` now wraps its children in `<Command>` (with an optional `commandProps`), and the accessible title/description moved **inside** `DialogContent` where Radix expects them.
2. `GlobalSearch` passes `shouldFilter: false`. The results are already filtered on the server; cmdk's own fuzzy filter would otherwise hide every hit that matched on something the label does not show (an email address, a phone number, an airport code, a PNR).
3. A rejected search (network drop, expired session, server error) no longer reaches the error boundary: the dialog shows "Search is unavailable right now. Check your connection and try again." and the next search works.
4. A slow answer to an older query can no longer overwrite the result of a newer one.

## 2. What global search searches (server: `src/server/queries/global-search.ts`)

| Group | Matched on | Opens |
| --- | --- | --- |
| Contacts | first/last name, email, phone | `/contacts/{id}` |
| Leads | contact name, **contact email and phone (added)**, departure/arrival airport code and city | `/leads/{id}` |
| Quotes | quote number, contact name, **contact email and phone (added)** | `/quotes/{id}` |
| Bookings | booking reference, PNR, contact name | `/bookings/{id}` |

Each group is limited to 5 results, needs at least 2 characters, and is merged with the existing row-visibility rule (`*VisibilityWhere`: company isolation; agents see only their own records; Managers their team's).

**New: which kinds each role may search (security fix).** Previously a role barred from the Leads and Contacts pages (Ticketing Agent, Flight Expert) still got every company contact and lead back from this search, and a Travel Agent - who has no Bookings area - got bookings. Each group is now searched only when the role can open that area: Contacts (`canViewContacts`), Leads (`canViewLeads`), Quotes (`canViewQuotesPage`), Bookings (`canViewBookings`). No viewer returns nothing.

| Role | Contacts | Leads | Quotes | Bookings |
| --- | --- | --- | --- | --- |
| Administrator | yes | yes | yes | yes |
| Manager | own team | own team | own team | own team |
| Travel Agent | own | own | own | **no** (no Bookings area) |
| Ticketing Agent | **no** | **no** | all (company) | all (company) |
| Flight Expert | **no** | **no** | all (company) | all (company) |
| Marketing Agent | no | no | no | no |

## 3. The Admin / Ticketing "booking search"

The code has **no separate booking-search feature**: the Bookings list has status and agent filters but no search box, and the topbar has only the global search. Bookings are searchable through the global search (reference, PNR, customer name). That path is now correct for the intended roles: Administrator and Ticketing Agent (and Manager within their team, and Flight Expert) can find bookings; a Travel Agent cannot; every result is company- and role-scoped. It is **not** routed through the Leads/Contacts search: it is its own query and its own result group. If a dedicated booking search box on the Bookings page is wanted, that is new functionality and was not added.

## 4. Search inside each section (checked, unchanged)

| Section | Search | Model queried |
| --- | --- | --- |
| Leads | `q` box (`lead-filters.tsx` -> `queries/leads.ts`) | Lead (contact name/email/phone, airports) |
| Contacts | `q` box (`contact-filters.tsx` -> `queries/contacts.ts`) | Contact |
| Tasks | `q` box | Task |
| Quotes / Bookings lists | **no search box** (status and agent filters only) | - |
| Travel Agents (Accounts directory) | no search | Account |

No section's search queries another entity's model, and nothing in the code path routes a Leads/Contacts/Quotes search to Travel Agents; the reported "searches Travel Agents" behaviour **could not be reproduced from the code** (the one place that lists agents is the "Agent" filter dropdown on those pages, which filters by assigned agent, it does not search). If it was seen in the running app, a screenshot or the exact steps are needed.

## 5. Keyboard behaviour (tested in jsdom)

Ctrl+K and Cmd+K open it; the input receives focus; Escape closes it; Enter / mouse selection on a result opens the right record and closes the dialog; arrow-key navigation, the empty-state ("Type at least 2 characters", "No results found") and the error state work. The shortcut handler is attached to the document and calls `preventDefault`; it does **not** check whether focus is in a text input, so Ctrl+K inside a form field also opens search (the same as before; it only affects Ctrl/Cmd+K, never ordinary typing).

## 6. Test status

| Suite | Result |
| --- | --- |
| `global-search.test.tsx` (7: opens from button without throwing and focuses input, Ctrl+K / Cmd+K / Escape, all groups shown even when the label does not contain the typed text, selecting a result navigates and closes, no results, rejected search handled, stale answer ignored) | PASSED |
| `global-search.test.ts` (11: visibility per role and company, role-based groups, email/phone matching, cross-company bookings) | PASSED |
| Real browser, signed in, against a database | NOT RUN - no database; the original failure was reproduced in jsdom |
| Real PostgreSQL ILIKE behaviour and ranking | NOT RUN |
