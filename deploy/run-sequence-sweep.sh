#!/usr/bin/env bash
# OPTIONAL redundant trigger for automatic sequence sending:  GET /api/cron/sequences  (sends every sequence step that is due now).
#
#   bash deploy/run-sequence-sweep.sh
#
# You do NOT need this for sequences to be sent. The application already sends due steps itself, once a minute, from the same in-process poller that
# notifies task due times (src/instrumentation.ts), as long as DISABLE_IN_PROCESS_POLLER is not set. Use this script (with the systemd timer
# deploy/systemd/compass-tools-sequences.timer) only
#   * as a second, independent trigger (belt and braces), or
#   * when the in-process poller is deliberately switched off (DISABLE_IN_PROCESS_POLLER=true): then THIS becomes the only thing that sends sequence steps,
#     and it must run about once a minute.
# Running it alongside the poller is safe: every enrollment is claimed atomically before it is sent, so a step goes out once.
#
# The call goes through `docker compose exec` into the running app container, to its own loopback address: nothing is published and the secret
# (CRON_SECRET) is read INSIDE the container - it never appears on the host, in this script, in the process list or in a log. It prints a one-line
# summary of counts only (never a recipient, subject or error text). Not enabled by anything in the repository: an operator installs the timer deliberately.
# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need_cmd docker
check_env_file
[ -n "$(dc ps -q app)" ] || die "The app container is not running (start it with:  bash deploy/compose.sh up -d app)."

# shellcheck disable=SC2016  # the JavaScript below is for the container's Node, not this shell
dc exec -T app node -e '
  const url = "http://127.0.0.1:" + (process.env.PORT || 3000) + "/api/cron/sequences";
  fetch(url, { headers: { authorization: "Bearer " + (process.env.CRON_SECRET || "") }, signal: AbortSignal.timeout(110000) })
    .then(async (r) => {
      if (!r.ok) { console.error("sequence sweep failed: HTTP " + r.status); process.exit(1); }
      const b = await r.json();
      const n = (v) => (typeof v === "number" ? v : 0);
      console.log("sequence sweep ok: processed=" + n(b.processed) + " sent=" + n(b.sent) + " failed=" + n(b.failed));
    })
    .catch(() => { console.error("sequence sweep failed: the app did not answer"); process.exit(1); });
'
