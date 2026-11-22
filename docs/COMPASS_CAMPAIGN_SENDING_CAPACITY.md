# Campaign sending capacity - what limits it, what was changed, what to decide

Date: 2026-11-22. Sources are Google's and the providers' own pages, read on 2026-11-22. Each figure is tagged: **[read]** = read from the official page itself; **[summary]** = from a search summary of an official page or from a page that was truncated while being read (verify before relying on it); **[not stated]** = the page does not say. Prices change: confirm on the provider's page before buying. Nothing was purchased, connected, configured or sent while preparing this.

## 1. How campaigns are sent today (from the source)

* **Transport:** the Gmail API, as the Compass Tools account that created the campaign (`sendEmail` -> `sendViaGmail`, OAuth connection of that person's own Google Workspace mailbox). There is no SMTP, SMTP relay or separate provider.
* **Shared mailbox:** the same connection sends that person's transactional CRM emails (lead notifications, quotes, confirmations). Campaign mail and everyday mail therefore consume **one** Google allowance.
* **Application limits** (`campaign-worker.ts`, environment `CAMPAIGN_SENDS_PER_MINUTE` default 20 and `CAMPAIGN_DAILY_LIMIT` default 400, both per sending account) are the CRM's own conservative guard rails, **not Google's limits**. Raising them does not raise what Google allows.
* **Counting:** from the database, per sender (all that sender's campaigns together). **Changed in this release:** the quota check and the claim of each recipient are now one transaction under a per-sender PostgreSQL advisory lock (`claimWithinQuota`), so concurrent workers or instances can never exceed a limit (the previous design could exceed the minute budget by one batch per simultaneous worker). The daily count includes sent messages and uncertain (`UNKNOWN`) ones. Defaults were **not** changed. The lock itself is verified only against an in-memory stand-in locally; the real-PostgreSQL test runs in the CI database job.
* **Not provided by the Gmail API path:** bounce notifications, spam-complaint feedback, delivery or open tracking. A rejected address returns to the sender's mailbox as an ordinary message the CRM does not read. Retries never repeat an uncertain send.

## 2. Google's published limits

| Item | Figure | Status |
| --- | --- | --- |
| Messages per user per rolling 24 h (Workspace) | **2,000**; 1,500 when sent by mail merge; 500 for trial accounts; "limits can change without notice" | [read] (Gmail sending limits in Google Workspace) |
| Total recipients per day / unique recipients per day | 10,000 / 3,000 (2,000 external) | [summary] |
| Per message | 2,000 recipients, at most 500 external; the Gmail API allows 500 recipients per message | [read] / [summary] |
| Does the limit differ for Business Starter? | The sending-limits page does **not** list a difference by edition (Business Starter is not mentioned) | [read]; confirm in the Admin console |
| Accounts that have not paid yet | Lower limits until the domain has cumulatively paid about 100 USD | [summary] |
| After the limit is reached | no new messages for up to 24 h | [read] |
| Bulk sender rules (about 5,000+ messages a day to personal Gmail addresses; once met, permanent) | SPF **and** DKIM **and** DMARC, aligned From domain, DKIM key at least 1024 bits, user-reported spam rate kept below 0.1% and never at 0.3%, **one-click unsubscribe (RFC 8058) for marketing mail**, unsubscribe honoured within 48 h; Gmail has been ramping up enforcement since November 2025 | [summary] of the Email sender guidelines and its FAQ |
| Google Workspace SMTP relay | up to 10,000 unique recipients per user per 24 h, 100 recipients per SMTP transaction, 4.6 million per 24 h and 319,444 per 10 minutes for the whole organisation; authentication by IP allow-list or SMTP authentication; limits can be lowered by Google | [read] / [summary] |
| What the relay is for | Google describes it as "intended for on-premise devices and applications that generate outbound email" and lists **direct sending from a marketing/high-volume platform** as the recommended route for campaigns | [summary] |

**Consequences.** (1) Google's published daily allowance (2,000 per user) is **five times** the CRM's 400 default, but it is shared with everything the mailbox sends, and it is a ceiling, not a target. (2) The Gmail API path is fine for small, consented lists; it is the wrong tool for large lists because it gives no bounce/complaint feedback, which the sender guidelines make you responsible for. (3) The relay raises the per-user ceiling to 10,000 unique recipients, but it is not an "upgrade" of the existing OAuth path: it needs Admin-console configuration, an authenticated or allow-listed connection and a new SMTP transport in the application, and Google itself points marketing campaigns elsewhere. (4) Do not use several mailboxes, aliases or sender rotation to multiply the allowance: that is what Google's anti-abuse systems look for.

## 3. Dedicated providers (compared on what matters here)

| | Amazon SES | Brevo | Mailgun | Twilio SendGrid |
| --- | --- | --- | --- | --- |
| Price | **0.10 USD per 1,000** emails pay-as-you-go; plans from 0.16 USD per 1,000 (Essentials) to 0.23 USD (Enterprise) plus a monthly fee on the upper plans; dedicated IP 24.95 USD a month [read] | Free plan **300 emails a day** [read]; paid plans from **9 USD a month** [read], marketing page: 5,000 emails a month at that price [summary] | Foundation 35 USD a month for 50,000 emails, Scale 90 USD for 100,000; overage from 1.30 / 1.10 USD per 1,000 [summary] | Essentials from 19.95 USD a month for 50,000-100,000 emails, Pro from 89.95 USD [summary]; some figures are from 2022, treat as historical |
| Getting started | New accounts are in a **sandbox: 200 messages per 24 h, 1 per second, verified recipients only**; production access is requested in the console, first answer within **96 h** [read] | Sign up and verify the sender domain | Sign up, verify domain | Sign up, verify domain |
| Verified domain, SPF/DKIM/DMARC | yes (identity verification) | yes | yes | yes |
| Bounces, complaints, suppression, event webhooks | Account-level suppression and event publishing (configuration sets; event destinations); bounce/complaint thresholds that trigger review are **[not stated]** on the pages read | built in for campaigns; transactional webhooks | webhooks, suppression lists | webhooks, suppression lists |
| Fit with this CRM | Cheapest and most scalable; **most engineering**: the CRM keeps its own builder, unsubscribe page and suppression, so only a send adapter plus bounce/complaint intake would be added | Easiest start; brings its own marketing tool that would duplicate the CRM's | Developer-oriented API, mid price | Mature API, price depends on volume tier |
| Regional / GDPR | choose the region; data-processing terms apply to all four | EU-based company | US company with an EU region option [not verified] | US company [not verified] |

## 4. Recommendation

1. **Immediately, with what exists (needs your decision to change any number):** keep Gmail for transactional and everyday mail and for small consented campaigns. The CRM's limits are configuration only. A cautious step would be to raise `CAMPAIGN_DAILY_LIMIT` in stages (for example 400 -> 800 -> 1,200) while watching bounces and complaints, never above what leaves room for the mailbox's other mail inside Google's 2,000. I changed no default and no production value.
2. **SMTP relay: not recommended** for campaigns: it multiplies the work and risk (admin settings, SMTP transport, authentication) for a ceiling Google itself says is not meant for marketing, and the Gmail API path would still have no bounce/complaint feedback.
3. **Longer term, for lists beyond a few thousand or any list that grows: a dedicated provider for campaigns only.** Amazon SES is the best fit on cost and scale and for a CRM that already owns its builder and unsubscribe handling; it needs an AWS account, a verified domain, production access (about four days for the first answer) and a small adapter plus bounce/complaint intake. If speed to first send matters more than cost, Brevo or Mailgun can start in a day at roughly 9-35 USD a month. This choice depends on your real list size and how much engineering you want to own.
4. **Prerequisites whichever route (independent of this code):** SPF, DKIM and DMARC for the sending domain (DNS changes are yours to approve), a warm-up plan (start small, grow gradually), a dedicated sub-domain or at least a separate From identity for marketing so campaign reputation cannot damage transactional mail, and Google Postmaster Tools monitoring.

**Done in code in this release, regardless of provider:** the one-click unsubscribe headers (`List-Unsubscribe` + `List-Unsubscribe-Post`, RFC 8058) are now sent with every campaign message, and `POST /api/public/unsubscribe` accepts the mailbox provider's one-click request (token in the URL, idempotent, recorded as `EMAIL_ONE_CLICK`, no migration). Gmail's daily-quota answer `dailyLimitExceeded` now backs a campaign off like the other quota answers instead of counting as a generic failure. The quota claim is atomic.

**Not done (needs your approval first):** creating or connecting a provider account; buying credits; DNS (SPF/DKIM/DMARC) changes; adding provider secrets; sending any real test email; changing production limits. **Not built:** a provider send adapter. It would be speculative without a chosen provider and untestable without credentials; the seam is small (`sendEmail` in `campaign-worker.ts` is the one call to replace) and it must come with bounce/complaint/suppression intake before real volume is sent.

## 5. Decisions needed

1. Real list size now and in 12 months (this decides Gmail-only versus a provider).
2. Which provider (SES for cost/scale, Brevo/Mailgun for speed) and who owns the AWS/provider account.
3. Whether to raise the daily default beyond 400 in the meantime, and to what.
4. Approval to prepare the DNS records (SPF/DKIM/DMARC) and a marketing sub-domain.
5. Approval for a single real test email to your own inbox to check the `List-Unsubscribe` header in Gmail's interface (the header is verified by unit tests only).
