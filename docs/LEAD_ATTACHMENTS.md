# Lead documents (Files tab) — stored on the VPS disk

Users can attach documents (passport copies, signed forms, itineraries …) to a **Lead**. The file bytes are stored on the **server's own
disk**, in a persistent Docker bind mount; PostgreSQL holds only metadata and ownership. A Contact's Files tab shows a read-only summary of
the documents of its Leads. Nothing is attached to outgoing emails, and none of this touches the card vault, CVV/CVC retention or payment
security.

> **This feature needs the VPS deployment.** The files live on a local disk, so a deployment without a persistent disk (Vercel,
> Cloudflare Workers) cannot accept uploads: the Files tab reports storage as unavailable there. Use the Docker/VPS stack
> (`docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md`).

## What users can do

| Role | Upload | View / open / download | Edit description | Delete |
| --- | --- | --- | --- | --- |
| Travel Agent | yes (own visible leads) | yes | **no** | **no** |
| Manager | yes | yes (team-scoped leads, as everywhere) | yes | yes |
| Admin | yes | yes | yes | yes |
| Ticketing Agent / Flight Expert / Marketing Agent | no Leads area, so no access | | | |

Every operation is **also** limited by lead visibility (`leadVisibilityWhere`): the company, the role and a Manager's team. A role alone
never grants access to a particular lead. Permissions live in `src/lib/permissions.ts` (`canUploadLeadAttachments`,
`canManageLeadAttachments`) and are enforced in the server actions and route handlers, not just hidden in the UI.

## Supported files

Allowlist only (`src/lib/attachments/policy.ts`): **PDF, JPG/JPEG, PNG, WebP, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT, CSV.**
Rejected on the server: video, audio, executables and scripts, HTML, **SVG** (can carry script), archives (ZIP/RAR/7z …), macro-enabled
Office files (.docm/.xlsm/.pptm) and anything else not listed. A name like `invoice.exe.pdf` is refused (dangerous earlier extension).

* **Size limit:** `MAX_LEAD_ATTACHMENT_SIZE_MB`, default **10 MB**, hard ceiling **25 MB** (a larger value is capped). Shown in the upload dialog.
* **Per lead:** at most 200 files.
* **Checks, in order:** extension allowlist → declared type consistent with the extension → size → while receiving: never more than the
  authorised size, exactly that size at the end, and the **actual first bytes match the file format** (PDF/JPEG/PNG/WebP/Office/text
  signatures) → re-verified when the upload is completed. A mismatch deletes the file and the record. **This is not malware scanning** —
  no file content is virus-scanned. Add a scanning step (for example ClamAV on the VPS) if the business requires it.

## Architecture

```
Upload (browser → app, same origin; the file never touches any other service)
  1. requestLeadAttachmentUpload   server action: authorise (account → role → lead visible → company), validate name/type/size,
                                   create a PENDING row with an opaque server-generated key, return the same-origin upload URL
  2. PUT /api/attachments/{id}/upload   raw file body (progress and cancel work as before). The server re-authorises, checks the
                                   declared length BEFORE reading a byte, checks disk room, then STREAMS the body to a private temp
                                   file: it is cut off at the first byte beyond the authorised size, the size is compared, the first
                                   bytes are checked against the format, the file is fsynced and published atomically under its key.
  3. completeLeadAttachmentUpload  server action: re-verify the stored file (exists, exact size, signature) → row becomes READY →
                                   audit + lead activity. Calling it twice is harmless (idempotent).
  (failure / cancel → abandonLeadAttachmentUpload; anything left PENDING is swept after 1 hour — see Maintenance)

Open / download   GET /api/attachments/{id}/file[?download=1]
  authorise (the attachment's OWN lead must be visible to the caller, same company, READY) → audit → stream from disk with the type and
  disposition chosen by the server (never by the browser). PDFs / images open in a tab; everything else downloads.

Edit description / delete   Admin & Manager only, same authorisation. Delete removes the file first, then the row (retry-safe: deleting
                            a file that is already gone succeeds).
```

* **No public URL.** Nothing serves the upload directory. There is no static route, no Next.js `public/` entry and no web-server alias;
  the only way out is the authorised download route. The directory is mounted into the `app` container (read-write) and the `tools`
  maintenance container (**read-only**) — never into PostgreSQL, cloudflared or the scheduler.
* **Opaque keys.** Files are stored as `<2 hex>/<64 hex>` (256 random bits; the first directory is the key's first two characters).
  The key never contains a customer file name, a lead id, a company id or anything the browser sent. The key is never sent to the browser;
  the browser only knows the attachment id. A key becomes a path in exactly one function (`pathForKey`), which accepts nothing but that
  shape — `..`, separators, absolute paths and drive letters cannot be expressed — and re-checks the result is inside the upload directory.
* **Safe writes.** Received into `<dir>/.tmp/` with `O_EXCL` and mode 0600, fsynced, then published with `link(2)` — atomic **and**
  exclusive, so two racing uploads of one attachment cannot both win and a half-written file is never visible under a final key.
  Directories are 0700, files 0600, owned by the application user. Reads refuse symlinks (`O_NOFOLLOW`) and anything that is not a
  regular file.
* **File names** are untrusted: directory parts, control / bidi / separator characters removed, length capped; shown as text only;
  `Content-Disposition` is built with an ASCII fallback + RFC 5987 name (no CR/LF/quotes possible). They are stored in the database only —
  never in a path.
* **Download headers.** `Content-Type` from the server's allowlist, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy:
  same-origin`, `Cache-Control: private, no-store`, and a restrictive `Content-Security-Policy` on the response itself.
* **Lead isolation / IDOR:** the lead and company are derived from the attachment's database row, never from a value sent next to it.
  "Does not exist", "another lead", and "another company" all return the same 404 / generic message. Contact aggregation filters by
  **each Lead's** visibility (one query, no N+1).
* **Errors are generic.** Browsers get messages such as "File storage is unavailable right now". Absolute paths, keys, OS error codes and
  library messages never reach a response, a log line or an audit record.
* **Consistency.** Upload = row PENDING → file stored → verified → READY. Delete = file, then row. Lead / Contact deletion collects the
  stored files' references before the database cascade and removes the files afterwards; a failed removal is recorded in the audit log
  (`ATTACHMENT_STORAGE_ORPHANED`, with the opaque keys) so it can be reconciled. A row is only removed once its file is gone or absent.
  Every removal goes through the local module, which accepts nothing but its own key shape — nothing can delete a file outside the
  upload directory.
* **Audit** (append-only `AuditLog`, entity `Attachment`): `ATTACHMENT_UPLOADED`, `_UPLOAD_REJECTED`, `_OPENED`, `_DOWNLOADED`,
  `_DESCRIPTION_UPDATED`, `_DELETED`, `_ACCESS_DENIED`, `_STORAGE_ORPHANED`. Records actor, attachment, lead, contact, company and
  outcome — never file contents, paths, keys or file names.
* **Rate limits** (per account): uploads 40 / 15 min, opens + downloads 120 / 10 min, edits + deletes 60 / 15 min.
* **Retention:** there is **no automatic deletion** of valid documents, ever (including when the disk is full). How long customer
  documents (which may include identity documents) must be kept or erased is a legal / business decision — **REQUIRES BUSINESS DECISION**.

### Database

No schema change was needed: the existing `Attachment` table (migration `20261007000100_lead_attachments_r2`, the name is historical) already
holds the opaque `storageKey`, size, type, status, lead, contact and company. The key is a local `<2 hex>/<64 hex>` key. That
migration is kept as-is because it is already part of the migration history; its name is the only trace of the old design.

## Configuration

Server-side environment variables. **None is exposed to the browser** (none starts with `NEXT_PUBLIC_`). Real values live in the
production `.env` (mode 600, git-ignored); never put them in the repository, an issue or a chat.

| Variable | Default | Purpose |
| --- | --- | --- |
| `UPLOAD_STORAGE_DIR` | `/var/lib/compass-tools/uploads` (production); `./.local-uploads` (development) | Where the app writes inside the container. `compose.yaml` sets it; leave it alone. In production the app **never creates** this directory: if the bind mount is missing, storage is reported "unavailable" instead of silently writing into the container's disposable layer. |
| `UPLOADS_HOST_DIR` | `/srv/compass-tools/uploads` | The **host** directory that is bind-mounted there (read by Compose from `.env`). Change it to use another disk/path. |
| `UPLOAD_MIN_FREE_MB` | `1024` | Free space always left on the disk for PostgreSQL, logs and Docker. Uploads are refused (HTTP 507, "storage is almost full") instead of filling the disk. |
| `MAX_LEAD_ATTACHMENT_SIZE_MB` | `10` | Largest accepted file, whole number 1–25. |

### Limits on the path to the app (read this if big uploads fail)

* **Cloudflare** (the tunnel proxies through Cloudflare): request bodies up to **100 MB** on Free/Pro plans — above the 25 MB ceiling here.
  Cloudflare also times out a request that sends nothing for 100 s; a normal upload is far inside that.
* **Next.js:** the upload route is a Route Handler under `/api/…`, which is *outside* the proxy matcher (`src/proxy.ts`). That matters:
  routes the proxy runs on get their request body buffered and capped at 10 MB (`proxyClientMaxBodySize`). A regression test pins
  `/api/*` outside the matcher, so a 25 MB file streams without whole-file buffering.
* **No other reverse proxy** sits between cloudflared and the app. If you add one (nginx/Caddy), raise its body-size limit to at least
  `MAX_LEAD_ATTACHMENT_SIZE_MB` and disable request buffering (`client_max_body_size 26m;` and `proxy_request_buffering off;` for nginx).
* **Server Actions** (`next.config.ts` `serverActions.bodySizeLimit`) do not carry the file: only small JSON (name, type, size).
* The upload must finish within **15 minutes**; a stalled or deliberately slow client is cut off.

## VPS setup (once)

The application runs as the image's `node` user, **uid/gid 1000**. The host directory must exist and be owned by that id; Compose is
configured *not* to create it (a root-owned directory would be unwritable and uploads would fail at runtime).

```bash
sudo install -d -o 1000 -g 1000 -m 0700 /srv/compass-tools/uploads
ls -ldn /srv/compass-tools/uploads        # expect: drwx------ 2 1000 1000 …
```

* Use a different location by creating it the same way and setting `UPLOADS_HOST_DIR=/that/path` in `.env`.
* Put it on a **separate volume** if you can (a mounted OVHcloud additional disk): then uploads can never fill the system disk, and the
  disk can be snapshotted/grown independently. Mount that volume at the path **before** the first start.
* Do **not** put it inside the repository checkout, under a web server's document root, or in a directory another service writes to.
* `bash deploy/deploy.sh` and `bash deploy/verify.sh` check the directory, its owner and a real write/read/delete round trip.

## Deploying to the VPS

Pushing to GitHub does **not** deploy anything, and nothing here has been deployed. `deploy/deploy.sh` only deploys commits that are on
`origin/main`, so the branch must be reviewed and merged first. Note that this branch also carries the self-hosted Docker/VPS stack itself
(it was never merged separately): if the VPS is not running yet, follow `docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` from the start and treat
the steps below as the uploads-specific part. On the VPS, as the deploy user, in the checkout:

1. Create the directory — **before** the deploy; `docker compose` refuses to start without it:
   ```bash
   sudo install -d -o 1000 -g 1000 -m 0700 /srv/compass-tools/uploads
   ```
2. Take a database backup (a separate command; the deploy does this by itself only when `--migrate` is used):
   ```bash
   bash deploy/backup-db.sh
   ```
3. Deploy (it shows what changes, rebuilds, restarts and runs `verify.sh`). This change has **no database migration**; `--migrate` is only
   needed when `deploy.sh` reports pending migrations from other changes:
   ```bash
   bash deploy/deploy.sh
   ```
4. Do the [verification](#verifying-a-deployment) below.
5. Optionally install the daily maintenance timer (see [Maintenance](#maintenance)).

### Rollback

* **App:** `bash deploy/rollback.sh <previous-version>` returns to the previous image. There is no migration to undo.
* **Files uploaded after this release exist only on the VPS disk.** An older release (which did not read the VPS disk) cannot open them: they
  show as unavailable until you roll forward again. **Do not delete the upload directory** — back it up first (below).

## Verifying a deployment

After `deploy.sh` (it runs `verify.sh`, which includes the storage checks), do this once by hand in the browser as an Admin:

1. Open a Lead → **Files** → upload a small PDF. The progress bar runs and the file appears under the lead.
2. Open it (a tab with the PDF) and Download it; compare the bytes if you like.
3. On the server, confirm a file exists and nothing exposes it:
   ```bash
   bash deploy/uploads-usage.sh                                   # counts, sizes, by backend
   sudo ls -lR /srv/compass-tools/uploads | head -20              # <2 hex>/<64 hex>, mode -rw-------, owner 1000
   ```
4. **Persistence:** recreate the container and open the file again:
   ```bash
   bash deploy/compose.sh up -d --force-recreate app
   ```
   The file must still open. (The CI smoke test does the same with a probe file.)
5. Delete the test file in the CRM; run `bash deploy/uploads-usage.sh` again — the file is gone.
6. Compare the database with the disk at any time (read-only): `bash deploy/compose.sh run --rm tools npx tsx scripts/attachments-reconcile.ts`
   — it lists attachment ids/keys that are **MISSING** (record but no file), wrong **SIZE**, **ORPHAN** (file but no record) and
   **PENDING** uploads; it prints no file names, and changes nothing. Exit code 2 = a record without a usable file.

## Disk space

The VPS disk is shared by PostgreSQL, Docker images/build cache, logs and the uploads. The application protects it, and never deletes a
valid attachment to make room.

* **Look:** `df -h` (and `bash deploy/uploads-usage.sh`, which also shows the uploads' size, totals per backend and `docker system df`).
  `verify.sh` warns above **80 %** used and fails above **95 %**.
* **The app watches too:** `GET /api/health` → `readiness.uploadStorage` is `ready`, `low_space` or `unavailable`.
* **Disk full / nearly full:** when less than `UPLOAD_MIN_FREE_MB` would remain, a new upload is refused up front (HTTP 507) with the
  message "File storage is almost full, so new files can't be added right now. Please ask an administrator." If the disk fills during a
  write (ENOSPC), the partial temp file is removed, the upload fails with the same kind of generic message, and no record is made visible.
  Existing documents are untouched and keep opening. Everything else in the CRM keeps working (PostgreSQL has its own volume, but shares
  the disk — which is exactly why the reserve exists).
* **Find the large uploads** (ids, sizes, dates — never file names; decide with the lead's owner whether a file is still needed):
  ```bash
  bash deploy/uploads-usage.sh          # includes "the 15 largest uploads"
  ```
  Deleting is always a deliberate action in the CRM (Admin/Manager), which removes the file and the record together.
* **Reduce growth:** lower `MAX_LEAD_ATTACHMENT_SIZE_MB` (affects new uploads only), prune old backups (`KEEP_DAYS`), `docker image prune`,
  and move the uploads to a bigger/separate volume (stop `app`, copy with `rsync -a`, fix ownership 1000:1000, point `UPLOADS_HOST_DIR`
  at it, start).
* **Recommended:** alert when the disk passes 80 % (OVHcloud monitoring or a cron `df`), and decide a retention policy for old leads'
  documents with the business (legal input needed for identity documents).

## Backup and restore

The database holds only **metadata**. Restoring the database alone brings back records that point at files that are not there; restoring
files alone leaves files with no records. **Back up and restore both, from the same day.**

```bash
bash deploy/backup-db.sh          # PostgreSQL dump (existing)
bash deploy/backup-uploads.sh     # the documents: verified .tar.gz, mode 600 in a 700 directory (BACKUP_DIR, KEEP_DAYS, BACKUP_AGE_RECIPIENT)
```

The daily systemd unit (`deploy/systemd/compass-tools-backup.service`) runs both, database first. `backup-uploads.sh` reads the files
inside a throw-away container as the application user (no root), skips in-flight `.tmp` files, verifies that every archive entry is
exactly a `<2 hex>/<64 hex>` file, refuses to start if the backup disk lacks room, and can encrypt with `age` (it fails closed rather than
write an unencrypted copy when `BACKUP_AGE_RECIPIENT` is set).

**A backup that lives only on the same server is lost with the server.** Copy the (encrypted) archives off the VPS —
`docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` §12.3. OVHcloud snapshots capture the disk, including the uploads and the keys in `.env`;
treat them accordingly.

**Restore** (practise it — a test restore changes nothing):

```bash
bash deploy/restore-uploads.sh /var/backups/compass-tools/uploads-<time>.tar.gz             # CHECK only: integrity + entry names
bash deploy/restore-db.sh      /var/backups/compass-tools/<db backup from the same day>      # test restore into a throw-away database

# real recovery, in this order, with the site offline:
bash deploy/restore-db.sh      <db backup> --replace         # asks you to type the database name; takes a safety backup first
bash deploy/restore-uploads.sh <uploads backup> --replace    # asks you to type RESTORE; moves current files aside, never deletes them
bash deploy/compose.sh run --rm tools npx tsx scripts/attachments-reconcile.ts   # database and disk should now agree
```

`--replace` moves the current files into `.before-restore-<time>` inside the upload directory (nothing is deleted); remove that folder
yourself once you are satisfied (the script prints the command). Encrypted `.age` archives must be decrypted first.

## Maintenance

* **Stale uploads.** An upload that never completes (browser closed, crash) leaves a PENDING row older than 1 hour and possibly a file or
  a `.tmp/*.part` file. The daily task `/api/cron/tasks` removes them: the file first, the row only after the file is gone or absent; a
  file that cannot be removed keeps its row, is retried the next day, and is audited. Leftover `.tmp/*.part` files older than 1 hour are swept in the same run.
  **On the VPS this daily task is not scheduled until you install the timer** — a one-time, deliberate step
  (`docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` §10.3, units in `deploy/systemd/compass-tools-maintenance.*`). Run it by hand any time:
  ```bash
  bash deploy/run-daily-maintenance.sh
  ```
  Normal cancellations and failures clean up immediately; this sweep only covers crashes.
* **Reconcile** (read-only) after a restore, an incident or a disk problem: `scripts/attachments-reconcile.ts` (above).

## Troubleshooting

When an upload fails the dialog says which kind of failure it was; the browser reports **stage / kind / HTTP status only** (never a URL)
to the server, which records `ATTACHMENT_UPLOAD_FAILED` in the audit log. Read it from `AuditLog`
(`action = 'ATTACHMENT_UPLOAD_FAILED'`, `metadata`).

| Symptom | Likely cause | Check / fix |
| --- | --- | --- |
| "File storage is unavailable" (503); `/api/health` → `uploadStorage: unavailable` | The bind mount is missing or not writable | `ls -ldn $UPLOADS_HOST_DIR` must be `1000 1000`; `docker compose config \| grep -A4 uploads`; `bash deploy/verify.sh` |
| `docker compose up` says the bind source does not exist | The host directory was not created | `sudo install -d -o 1000 -g 1000 -m 0700 /srv/compass-tools/uploads` |
| Every upload fails with 500/503 right after a deploy, `ls -ln` shows `0 0` (root) | Directory owned by root | `sudo chown 1000:1000 <dir> && sudo chmod 0700 <dir>` |
| "File storage is almost full" (507); `uploadStorage: low_space` | Less than `UPLOAD_MIN_FREE_MB` free | [Disk space](#disk-space): free space or move the uploads to a bigger volume |
| 413 / "didn't match what was selected" | File larger than `MAX_LEAD_ATTACHMENT_SIZE_MB`, or its size changed in transit | Check the limit; try again |
| 422 / "didn't match" | The file's real content does not match its extension (a renamed file, a corrupt PDF) | Re-export the document in the right format |
| Upload hangs then fails with status `0` through the public site only | A proxy in front of the app cuts or buffers large bodies | [Limits](#limits-on-the-path-to-the-app-read-this-if-big-uploads-fail) |
| A document opens for some leads but 404 for others | Lead visibility (Manager teams, company) — the same 404 as "does not exist" | Check the viewer's role/team; this is by design |
| Reconcile reports MISSING | A record whose file is gone (restore from a mismatched backup, manual deletion) | Restore the uploads backup from the same day as the database; never recreate files by hand |
| ORPHAN files in reconcile | Files with no record (an interrupted delete or a database restored to an older day) | Review, back up, then remove deliberately — nothing removes them automatically |

## Known limits

* No virus / malware scanning; no per-file versioning or replacement (delete + re-upload); no global Documents page.
* One server, one disk: the documents are as durable as your backups (see above). A multi-server setup would need shared storage — a
  different design.
* A Lead's list shows the newest 100 files (a count and a note appear above that).
