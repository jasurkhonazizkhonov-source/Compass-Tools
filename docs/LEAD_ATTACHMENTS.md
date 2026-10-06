# Lead documents (Files tab) — Cloudflare R2

Users can attach documents (passport copies, signed forms, itineraries …) to a **Lead**. The file bytes are stored in a **private
Cloudflare R2 bucket**; PostgreSQL holds only metadata and ownership. A Contact's Files tab shows a read-only summary of the documents
of its Leads. Nothing is attached to outgoing emails, and none of this touches the card vault, CVV/CVC retention or payment security.

## What users can do

| Role | Upload | View / open / download | Edit description | Delete |
| --- | --- | --- | --- | --- |
| Travel Agent | yes (own visible leads) | yes | **no** | **no** |
| Manager | yes | yes (team-scoped leads, as everywhere) | yes | yes |
| Admin | yes | yes | yes | yes |
| Ticketing Agent / Flight Expert / Marketing Agent | no Leads area, so no access | | | |

Every operation is **also** limited by lead visibility (`leadVisibilityWhere`): the company, the role and a Manager's team. A role alone
never grants access to a particular lead. Permissions live in `src/lib/permissions.ts` (`canUploadLeadAttachments`,
`canManageLeadAttachments`) and are enforced in the server actions, not just hidden in the UI.

## Supported files

Allowlist only (`src/lib/attachments/policy.ts`): **PDF, JPG/JPEG, PNG, WebP, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT, CSV.**
Rejected on the server: video, audio, executables and scripts, HTML, **SVG** (can carry script), archives (ZIP/RAR/7z …), macro-enabled
Office files (.docm/.xlsm/.pptm) and anything else not listed. A name like `invoice.exe.pdf` is refused (dangerous earlier extension).

* **Size limit:** `MAX_LEAD_ATTACHMENT_SIZE_MB`, default **10 MB**, hard ceiling 25 MB. Shown in the upload dialog.
* **Per lead:** at most 200 files.
* **Checks, in order:** extension allowlist → declared type consistent with the extension → size → (after upload) the stored object's
  real size equals the authorised size → its first bytes match the file format (PDF/JPEG/PNG/WebP/Office/text signatures).
  A mismatch deletes the object and the record. **This is not malware scanning** — no file content is virus-scanned. Add a scanning
  step (for example a Cloudflare / ClamAV queue) if the business requires it.

## How it works

```
Upload (browser → app → R2, bytes never pass through Vercel)
  1. requestLeadAttachmentUpload  authorise (account → role → lead visible → company), validate, create a PENDING row with an opaque
                                   server-generated key, return a presigned PUT URL (5 min; type + length are signed)
  2. browser PUTs the file straight to R2
  3. completeLeadAttachmentUpload verify the stored object (exists, exact size, magic bytes) → row becomes READY → audit + lead activity
  (failure / cancel → abandonLeadAttachmentUpload; anything left PENDING is swept by the daily cron after 1 hour)

Open / download   GET /api/attachments/{id}/file[?download=1]
  authorise (the attachment's OWN lead must be visible to the caller, same company, READY) → audit → 302 to a presigned GET URL that
  expires in 60 s and forces Content-Type and Content-Disposition. PDFs / images open in a tab; everything else downloads.

Edit description / delete   Admin & Manager only, same authorisation. Delete removes the R2 object first, then the row (retry-safe).
```

* **Object keys** are opaque: `companies/{companyId}/leads/{leadId}/attachments/{attachmentId}/{128-bit random}` — no user-controlled
  text, no file name. The key is never sent to the browser; the browser only knows the attachment id.
* **File names** are untrusted: directory parts, control / bidi / separator characters removed, length capped; shown as text only;
  `Content-Disposition` is built with an ASCII fallback + RFC 5987 name (no CR/LF/quotes possible).
* **Lead isolation / IDOR:** the lead and company are derived from the attachment's database row, never from a value sent next to it.
  "Does not exist", "another lead", and "another company" all return the same 404 / generic message. Contact aggregation filters by
  **each Lead's** visibility (one query, no N+1), so a Contact can't be used to reach a Lead the viewer can't see.
* **Consistency:** upload = row PENDING → object stored → verified → READY. Delete = object, then row. Lead / Contact deletion collects
  the object keys before the database cascade and purges them afterwards; a failed purge is recorded in the audit log
  (`ATTACHMENT_STORAGE_ORPHANED`, with the opaque keys) so it can be reconciled. R2 errors are logged without keys, bucket or account.
* **Audit** (append-only `AuditLog`, entity `Attachment`): `ATTACHMENT_UPLOADED`, `_UPLOAD_REJECTED`, `_OPENED`, `_DOWNLOADED`,
  `_DESCRIPTION_UPDATED`, `_DELETED`, `_ACCESS_DENIED`, `_STORAGE_ORPHANED`. Records actor, attachment, lead, contact, company and
  outcome — never file contents, signed URLs, credentials or file names.
* **Rate limits** (per account, existing limiter): uploads 40 / 15 min, opens + downloads 120 / 10 min, edits + deletes 60 / 15 min.
* **Retention:** there is **no automatic deletion**. How long customer documents (which may include identity documents) must be kept
  or erased is a legal / business decision — **REQUIRES BUSINESS DECISION**. The schema keeps `createdAt`, `status`, `companyId`,
  `leadId` so a policy can be added later.

## Configuration

Server-side environment variables. **None of them is exposed to the browser** (none starts with `NEXT_PUBLIC_`).

```
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_REGION=auto
R2_ENDPOINT=
MAX_LEAD_ATTACHMENT_SIZE_MB=10
```

| Variable | Value | Where to get it | Secret | Vercel | Local `.env` |
| --- | --- | --- | --- | --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account id | Cloudflare dashboard → **R2 Object Storage** (Account ID shown on the page / in the right sidebar) | No | Yes — Production, Preview (optional), Development | Optional (only to try uploads locally) |
| `R2_ACCESS_KEY_ID` | Access Key ID of an **R2 API token** | Dashboard → **R2 → Manage R2 API Tokens → Create API token** (shown once) | Yes | Yes — Production (and Preview only if you want previews to upload; use a separate bucket) | Optional |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key of that token | Same screen, shown **once** — store it in your password manager | **Yes** | Yes (mark **Sensitive**) | Optional |
| `R2_BUCKET_NAME` | Exact name of the private bucket | R2 → Buckets | No | Yes | Optional |
| `R2_REGION` | `auto` | Fixed value for R2 | No | Yes (`auto`) | Optional |
| `R2_ENDPOINT` | `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` (https only) | Derived from the account id; the **S3 API** URL on the bucket's Settings page. Leave unset to derive it from `R2_ACCOUNT_ID` | No | Optional | Optional |
| `MAX_LEAD_ATTACHMENT_SIZE_MB` | Whole number, 1–25 | Your choice (default 10) | No | Optional | Optional |

Uploads are enabled only when `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` and an endpoint (or `R2_ACCOUNT_ID`) are all
set. Otherwise the Files tab shows "File uploads are not set up yet" and the Upload button is disabled; nothing else is affected.

### Cloudflare setup (once per environment)

1. **Create a bucket** (R2 → Create bucket). Keep it **private**: do **not** enable the `r2.dev` public URL and do **not** attach a public
   custom domain. The application is the only authorisation layer.
2. **Create a least-privilege API token** (R2 → Manage R2 API Tokens): permission **Object Read & Write**, **scoped to this one bucket**.
   Do not use a Global / account-wide Cloudflare API key. Put the Access Key ID and Secret Access Key into the variables above.
3. **Add a CORS policy** to the bucket (Settings → CORS policy) — required because the browser uploads directly to R2:
   ```json
   [
     {
       "AllowedOrigins": ["https://www.compass-tools.com"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["content-type", "content-length"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   List only your real origin(s). Downloads need no CORS (they are top-level navigations).
4. (Recommended) add a lifecycle rule to **abort incomplete multipart uploads** after 1 day.
5. Set the variables in **Vercel → Project → Settings → Environment Variables** and redeploy. The Content-Security-Policy `connect-src`
   automatically includes the R2 endpoint origin when it is configured (`src/lib/csp.ts`).

### Local development

Either leave R2 unset (uploads disabled; everything else works) or point the variables at a **separate dev bucket** with its own
token. Never reuse the production bucket or token locally. `.env` is git-ignored; never commit credentials.

The test suite never needs R2: the storage layer (`src/server/storage/r2.ts`) is mocked, and the authorisation tests run against a
real PostgreSQL when `INTEGRATION_DATABASE_URL` is set (see `docs/DEPLOYMENT.md` §8).

## Known limits

* No virus / malware scanning; no per-file versioning or replacement (delete + re-upload); no global Documents page.
* Presigned-upload size enforcement relies on R2 honouring the signed `Content-Length`; the server also re-checks the stored size before
  a file becomes visible and removes anything that differs.
* A Lead's list shows the newest 100 files (a count and a note appear above that).
