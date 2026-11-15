# CRM Gmail Connection and Sequence Enrollment Audit

Date: 2026-11-16 (work started 2026-11-15). Scope: `compass-tools-updated` only; original CRM and both websites untouched. All checks use fake data, a fake in-memory database and mocked Gmail/Google: **no email was sent, no Gmail account or Google endpoint was contacted, no database was used.** Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN.

## 1. Starting state (verified in the real source and Git before changing anything)

Branch `review/crm-verification-2026-11-13` at `8b0f42295e05b2ab66e786325cea55f65bd63906` = the remote branch tip; `main` still `5a77976`; no merge in progress; one stash untouched; untracked `docs/recovery-archive/` and two reports from another session. The previous work was present: approval dialog, `startSequenceForLead`, enrolled-leads table, status filter, poller sending sequences, no Process Due button on the sequence page.

## 2. Whose Gmail sends a sequence email (actual architecture)

There is **no shared or company-wide mailbox** and the person who clicks is not necessarily the sender. Every sequence email is sent from the Gmail connection (`GmailConnection`, one per `Account`, `accountId @unique`) of the **lead's assigned agent** (`lead.assignedAgent`, `sendEmail({ accountId: agent.id })`). An administrator enrolling an agent's lead therefore depends on **that agent's** Gmail. The Connect action only ever connects the signed-in user's own account (the OAuth callback re-derives the user from the session and requires the Google identity to equal the CRM login email). So:

- "Connect Gmail" is offered only when the viewer **is** the sending agent; otherwise the notification names the agent ("Ask Jane Doe to connect Gmail").
- **Company isolation (new, defensive):** the enrollment check refuses a lead whose assigned agent belongs to a different company than the person enrolling (`sequence-enrollment-eligibility.ts`); Gmail is not even asked.
- Tokens are never sent to the browser: the check returns a category, the agent's name and a message only (`gmail-readiness-states.test.ts` asserts no token, key or Google address appears in an answer).

## 3. What counts as "usable" (inspected, then made explicit)

`checkGmailSendReadiness(accountId, { verifyToken })` (`src/server/email/gmail-send.ts`) now returns one of:

| Code | Meaning | Advice shown |
| --- | --- | --- |
| ready (verified) | connection exists, not revoked, send scope granted, refresh token decrypts, **Google's token service issued an access token just now** | confirmation appears |
| `NOT_CONNECTED` | no connection row | connect Gmail |
| `REAUTH_REQUIRED` | revoked, `invalid_grant` on refresh (connection is then marked revoked), undecryptable token (key rotated) or OAuth client not configured | reconnect Gmail |
| `MISSING_PERMISSION` (new) | connected but Google did not grant the send scope | reconnect and allow sending |
| `TEMPORARILY_UNAVAILABLE` (new) | Google's token service failed/unreachable (not `invalid_grant`) | **no** "connect" advice: "could not be checked right now, try again" + a Check-again button |

"Connected" on a settings page is only the stored `status`; the check no longer trusts it. Not distinguished (and why): "Gmail account belongs to a different user" cannot occur because a connection is verified at connect time to equal the CRM login email, and a connection row is per account; a different **company** is covered by the new isolation rule above; "Gmail API request failed" at check time is the TEMPORARILY_UNAVAILABLE case, and at send time it is the delivery states in the retry audit.

## 4. Root cause of "failed in Sequences, still enrolled on the Lead"

Found by reading the code paths, not assumed:

1. **A readiness check that said "ready" when it had not verified anything.** With token verification on, any refresh error other than `invalid_grant` returned `{ ready: true, verified: false }`. A connection whose token could not be refreshed for any other reason passed the pre-check, the lead was **enrolled** (ACTIVE), the first send then failed ("Could not connect to Gmail"), and the enrollment stayed ACTIVE with a retry scheduled. Now this is `TEMPORARILY_UNAVAILABLE`, **not ready**, and nothing is enrolled.
2. **Two pages computed "status" from different inputs.** The Lead card showed the stored enrollment fields only (Active, "Step 1 of N", "Next email: ..."); the Sequence page showed the per-step send log (Failed badges). An ACTIVE enrollment with a failed attempt therefore looked healthy on the lead and failed on the sequence. Both now call one function, `deriveEnrollmentState` (`src/lib/sequence-progress.ts`); see the consistency audit.
3. **The Gmail check ran only after the user had approved** (inside enrollment), so the user went through a confirmation for something that could not start. It now runs when the sequence is chosen, before any confirmation, and again on approval (the server is the authority).
4. **An approval that failed permanently after enrolling left a FAILED row that could not be restarted in place**; the only way forward was a second enrollment. A failed enrollment can now be restarted in place (`retryEnrollmentNow`).

## 5. Behaviour now (required scenarios)

Scenario A (Gmail disconnected): choose a sequence -> `getSequenceStartReadiness` (no side effects) -> a notification in the dialog (title, whose Gmail, "No emails have been sent and this lead has not been enrolled", a Connect/Reconnect button when the viewer is the sender, or Check again for a temporary problem). No confirmation is shown, **no enrollment row, no schedule, no activity row, no email** are created.
Scenario B: after connecting, the user returns to **the same lead** (the connect action now carries a validated `/leads/<id>` return target in a cookie; the callback redirects there with the `?gmail=` result), chooses the sequence again, Gmail is re-checked for real, the confirmation "Start this email sequence?" appears with **Approve and Start / Cancel**, Approve enrolls and sends step 1 immediately when its delay allows.
If Gmail breaks between the check and the approval, the server's own check returns the same notification and nothing is created.

## 6. Files

Changed: `src/server/email/gmail-send.ts`, `src/server/email/service.ts`, `src/server/sequence-enrollment-eligibility.ts`, `src/server/actions/sequences.ts` (`getSequenceStartReadiness`, `GmailBlock`), `src/server/actions/gmail-connect.ts`, `src/server/auth/gmail-oauth-state.ts`, `src/app/api/auth/gmail/callback/route.ts`, `src/components/sequences/apply-sequence-dialog.tsx`. New: `src/components/sequences/gmail-problem-notice.tsx`.

## 7. Tests (focused)

| Suite / test names | Result |
| --- | --- |
| `src/server/email/__tests__/gmail-readiness-states.test.ts` (18): disconnected, connected, expired/revoked (`invalid_grant`, connection marked revoked), refreshable, missing send permission, Google unavailable, undecryptable/unconfigured, wrong user, no secrets in answers; send outcomes | PASSED |
| `src/server/actions/__tests__/sequences.test.ts` - "Scenario A", "Scenario B" (11): readiness changes nothing, each Gmail problem has its own message, temporary problem never says "connect Gmail", sender named for an administrator, wrong-company agent refused without asking Gmail, approval with Gmail down creates nothing, blocked attempts leave nothing to clean up, reconnect then start | PASSED |
| `src/components/sequences/__tests__/apply-sequence-gmail-check.test.tsx` (13): notification instead of confirmation, Connect Gmail returns to this lead, Reconnect, missing permission, temporary = Check again only, someone else's Gmail = no button, retry shows the confirmation then Approve starts, fresh dialog has no stale notice, button disabled while checking, Gmail breaking between check and approval | PASSED |
| `gmail-connect.test.ts` (+11), `callback/__tests__/route.test.ts` (+3): return target accepted only as `/leads/<id>`, refused for open-redirect shapes, cleared when absent, single use, tampered cookie ignored | PASSED |
| Real Google OAuth, real Gmail, real browser, real database | NOT RUN / BLOCKED (no database, no network use, no real accounts) |

## 8. Not verified / limitations

Real Google behaviour (what a revoked, expired or scope-reduced token returns exactly) is modelled from the code's own error handling, not observed. The check refreshes a token (one Google request per distinct sender, capped by `GMAIL_VERIFY_LIMIT` for bulk enrollment); a successful refresh is still no guarantee the following send is accepted (quota, content).
