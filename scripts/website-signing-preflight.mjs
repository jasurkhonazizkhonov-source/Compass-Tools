// Pre-deployment check of the website-to-CRM signing configuration (docs/WEBSITE_SIGNING_STRICT_MODE.md). Read-only: it looks only at the environment it was
// started with, changes nothing, needs no database or network, and prints variable NAMES and rules, never a value.
//
// deploy/deploy.sh runs it INSIDE the freshly built app image (`docker compose run --rm --no-deps app node scripts/website-signing-preflight.mjs`), so it sees
// exactly what the application will receive from compose and .env, before any migration or restart. Exit code 0 = safe to start; 1 = refused.
//
// Production always requires signed website requests (src/server/website-request-signature.ts), so a configuration that cannot verify them would refuse every
// website submission. This check turns that into a refused deployment instead of a broken website form.
import { pathToFileURL } from "node:url";

export const MIN_SECRET_LENGTH = 32;
/** A random 32+ character secret uses many different characters; fewer than this means a placeholder such as "xxxx..." or "0000...". */
const MIN_DISTINCT_CHARACTERS = 10;
/** Credentials that must not be reused as the signing secret: leaking or rotating one must never affect another. */
const OTHER_SECRETS = ["WEBSITE_API_KEY", "WEBSITE_API_KEY_NEXT", "CRON_SECRET", "GOOGLE_CLIENT_SECRET", "CARD_ENCRYPTION_KEY", "IP_ENCRYPTION_KEY", "IP_HASH_KEY", "GMAIL_TOKEN_ENCRYPTION_KEY"];

function secretProblems(name, value) {
  const problems = [];
  if (value !== value.trim() || /\s/.test(value)) problems.push(`${name} contains spaces or line breaks (the website and the CRM would disagree about the value)`);
  if (value.length < MIN_SECRET_LENGTH) problems.push(`${name} is shorter than ${MIN_SECRET_LENGTH} characters, so it is not used`);
  else if (new Set(value).size < MIN_DISTINCT_CHARACTERS || /change[-_ ]?me|replace[-_ ]?me|example|placeholder/i.test(value)) {
    problems.push(`${name} looks like a placeholder, not a random secret (generate one: openssl rand -base64 32)`);
  }
  return problems;
}

/** Every reason this configuration must not be deployed. An empty list means it is acceptable. */
export function websiteSigningProblems(env) {
  const problems = [];
  const secret = env.LEAD_INGEST_SECRET ?? "";
  const flag = (env.WEBSITE_SIGNATURE_REQUIRED ?? "").trim().toLowerCase();

  if (secret === "") problems.push("LEAD_INGEST_SECRET is not set: no website request could be verified and every one would be refused (503)");
  else problems.push(...secretProblems("LEAD_INGEST_SECRET", secret));

  if (flag === "") problems.push("WEBSITE_SIGNATURE_REQUIRED is not set: production configuration must state WEBSITE_SIGNATURE_REQUIRED=true");
  else if (flag !== "true") problems.push('WEBSITE_SIGNATURE_REQUIRED must be exactly "true": production has no optional-signature mode, so any other value contradicts how the application behaves');

  const previous = env.LEAD_INGEST_SECRET_PREVIOUS ?? "";
  if (previous !== "") {
    problems.push(...secretProblems("LEAD_INGEST_SECRET_PREVIOUS", previous));
    if (previous === secret) problems.push("LEAD_INGEST_SECRET_PREVIOUS equals LEAD_INGEST_SECRET: empty it unless a rotation is in progress");
  }

  for (const [name, value] of [["LEAD_INGEST_SECRET", secret], ["LEAD_INGEST_SECRET_PREVIOUS", previous]]) {
    if (value === "") continue;
    for (const other of OTHER_SECRETS) {
      if (env[other] && env[other] === value) problems.push(`${name} is the same value as ${other}: each credential needs its own value`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = websiteSigningProblems(process.env);
  if (problems.length === 0) {
    console.log("website signing preflight: OK (signed requests required, secret configured; values not shown)");
    if (process.env.LEAD_INGEST_SECRET_PREVIOUS) console.log("website signing preflight: note - a previous secret is still accepted (rotation in progress); empty LEAD_INGEST_SECRET_PREVIOUS when the website has moved");
  } else {
    for (const problem of problems) console.error(`website signing preflight: FAIL - ${problem}`);
    console.error("website signing preflight: refused. See docs/WEBSITE_SIGNING_STRICT_MODE.md.");
    process.exitCode = 1;
  }
}
