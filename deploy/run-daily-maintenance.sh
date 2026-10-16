#!/usr/bin/env bash
# Runs the application's DAILY housekeeping once, from the VPS:  GET /api/cron/tasks  (what Vercel Cron used to do).
#
#   bash deploy/run-daily-maintenance.sh
#
# It matters for Lead documents: an upload that was started and never finished (browser closed, crash) leaves a PENDING record and possibly
# a partial file. Cancellations and failures clean up immediately; this daily run is the safety net that removes what a crash left behind -
# the FILE first, the record only once the file is confirmed gone. It never touches a completed (READY) attachment.
# The same run also removes expired rate-limit counters and (as a second safety net) destroys any retained security code whose 24-hour
# window has ended. The opt-in card-number purge stays OFF unless CARD_RETENTION_DAYS is set in .env (it is not set by any file here).
#
# The call goes through `docker compose exec` into the running app container, to its own loopback address: nothing is published and the
# secret (CRON_SECRET) is read INSIDE the container - it never appears on the host, in this script, in the process list or in a log.
# The endpoint is idempotent, so running it twice (or by hand) is harmless. It prints a one-line summary of counts only.
#
# Scheduled by deploy/systemd/compass-tools-maintenance.timer (see docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md, 10.3). Not enabled by anything
# in the repository: an operator installs the timer deliberately.
# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need_cmd docker
check_env_file
[ -n "$(dc ps -q app)" ] || die "The app container is not running (docker compose up -d app)."

# shellcheck disable=SC2016  # the JavaScript below is for the container's Node, not this shell
dc exec -T app node -e '
  const url = "http://127.0.0.1:" + (process.env.PORT || 3000) + "/api/cron/tasks";
  fetch(url, { headers: { authorization: "Bearer " + (process.env.CRON_SECRET || "") }, signal: AbortSignal.timeout(120000) })
    .then(async (r) => {
      if (!r.ok) { console.error("daily maintenance failed: HTTP " + r.status); process.exit(1); }
      const b = await r.json();
      const n = (v) => (typeof v === "number" ? v : 0);
      console.log("daily maintenance ok: staleAttachmentUploadsRemoved=" + n(b.staleAttachmentUploadsRemoved) + " rateLimitCountersDeleted=" + n(b.rateLimitCountersDeleted) + " cvvRecordsDestroyed=" + n(b.cvvRecordsDestroyed));
    })
    .catch(() => { console.error("daily maintenance failed: the app did not answer"); process.exit(1); });
'
