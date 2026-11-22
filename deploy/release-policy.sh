#!/usr/bin/env bash
# Release-branch policy for deploy/deploy.sh. Source it, do not run it. It only DECIDES; it deploys, builds, migrates and restarts nothing.
#
# Why it exists: the default deployment path accepts only commits that are already on origin/main. Compass Tools is also released from a dedicated
# `release/<name>` branch that is deliberately never merged into main. This file is the narrow, testable rule set for that second path:
#
#   1. The branch must be named exactly release/<name> (a conservative character set). main, review/*, feature/* and anything else are refused.
#   2. The thing to deploy is an IMMUTABLE commit: the full 40-character commit id, typed by the person who approved it. A branch name, a tag, an
#      abbreviation, "latest" or HEAD is refused, so a branch that moves after approval can never change what is deployed.
#   3. That commit must be the tip of, or an ancestor of, the freshly fetched origin/<release branch>. main is never substituted.
#   4. GitHub must report every REQUIRED check run of that exact commit as completed + success (the three required jobs of .github/workflows/ci.yml;
#      the dependency audit is report-only). If GitHub cannot be asked, the answer is NO, not "probably": --ci-attested is the explicit, visible way for the
#      approver to say they checked the CI result themselves.
#
# Nothing here is ever triggered by a push. The branch name and the full SHA both have to be typed by a person on the server.

# The job names are the "name:" lines of the required jobs in .github/workflows/ci.yml; a unit test keeps this list and that file in step.
RELEASE_REQUIRED_CHECKS=(
  "Static checks (types, lint, schema, scripts, secret hygiene)"
  "Unit + real-database integration tests"
  "Docker image + Compose smoke test (plaintext private database)"
)

# release/<name>: letters, digits, dot, underscore, hyphen; no "..", no component starting with a dot, no ".lock" ending.
release_branch_name_ok() {
  local b="${1:-}"
  [[ "$b" =~ ^release/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$ ]] || return 1
  case "$b" in *..* | */.* | *.lock) return 1 ;; esac
  return 0
}

# The full, lower-case, 40-character commit id and nothing else.
full_sha_ok() { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]; }

# release_target_ok <release-branch> <full-sha>: the fetched origin/<release-branch> exists and the commit is its tip or one of its ancestors.
release_target_ok() {
  local branch="$1" target="$2"
  git rev-parse --verify --quiet "refs/remotes/origin/$branch^{commit}" >/dev/null || return 1
  git cat-file -e "$target^{commit}" 2>/dev/null || return 1
  git merge-base --is-ancestor "$target" "refs/remotes/origin/$branch"
}

# Reads GitHub's check-runs JSON on stdin; succeeds only if EVERY required check name has a newest run that is completed with conclusion success.
# Prints what is missing or not green on stderr. Needs python3 (or python).
release_ci_verdict() {
  local py="" cand
  for cand in python3 python; do
    # the first interpreter that really runs (on some systems "python3" is only a stub that exits with an error)
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import json, sys' >/dev/null 2>&1; then py="$cand"; break; fi
  done
  [ -n "$py" ] || { echo "python3 is required to read GitHub's check results" >&2; return 2; }
  "$py" -c '
import json, sys
required = sys.argv[1:]
try:
    data = json.load(sys.stdin)
    runs = data["check_runs"]
except Exception:
    sys.stderr.write("unreadable check-run answer\n")
    sys.exit(2)
bad = 0
for name in required:
    # only GitHub Actions results count: a same-named check reported by another app (for example a build service) is not CI
    mine = [r for r in runs if r.get("name") == name and (r.get("app") or {}).get("slug") == "github-actions"]
    if not mine:
        sys.stderr.write("missing: %s\n" % name)
        bad += 1
        continue
    newest = max(mine, key=lambda r: r.get("started_at") or "")
    if newest.get("status") != "completed" or newest.get("conclusion") != "success":
        sys.stderr.write("not green: %s (status=%s, conclusion=%s)\n" % (name, newest.get("status"), newest.get("conclusion")))
        bad += 1
sys.exit(1 if bad else 0)
' "${RELEASE_REQUIRED_CHECKS[@]}"
}

# owner/repo of the fetch URL of origin when it is a github.com URL (https or ssh form); prints nothing otherwise.
release_github_repo() {
  local url
  url="$(git remote get-url origin 2>/dev/null || true)"
  if [[ "$url" =~ github\.com[:/]([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)$ ]]; then
    local repo="${BASH_REMATCH[1]}"
    printf '%s' "${repo%.git}"
  fi
}

# release_ci_green <full-sha>: asks GitHub (public API, no token is sent or stored) and applies release_ci_verdict. Fails closed.
release_ci_green() {
  local sha="$1" repo body
  repo="$(release_github_repo)"
  [ -n "$repo" ] || { echo "origin is not a github.com repository, so its check results cannot be read" >&2; return 2; }
  command -v curl >/dev/null 2>&1 || { echo "curl is required to read GitHub's check results" >&2; return 2; }
  body="$(curl -fsS --max-time 30 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/commits/$sha/check-runs?per_page=100")" \
    || { echo "GitHub did not answer for $repo @ $sha (private repository, network or rate limit)" >&2; return 2; }
  printf '%s' "$body" | release_ci_verdict
}
