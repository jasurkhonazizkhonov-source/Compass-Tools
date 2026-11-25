import { isProductionEnvironment } from "@/lib/env";
import { isLeadIngestSecretConfigured } from "@/server/lead-ingest-context";

/**
 * Whether website-to-CRM requests must carry a valid v2 signature.
 *
 *   * In production (isProductionEnvironment): ALWAYS. There is no unsigned or optional mode and no setting that creates one. A production server whose
 *     LEAD_INGEST_SECRET is missing or too short cannot verify anything, so the website routes refuse every request (503, website-signature-guard.ts)
 *     instead of accepting it unverified. deploy/deploy.sh refuses to start such a configuration (scripts/website-signing-preflight.mjs).
 *   * Outside production (development, tests): only when WEBSITE_SIGNATURE_REQUIRED=true, so a local CRM can be used without a website secret. Setting
 *     the switch without a usable secret refuses requests there too: a requirement that cannot be checked is never silently dropped.
 *
 * Deployment order: the website must send v2 signatures from the moment this CRM is live (docs/WEBSITE_SIGNING_STRICT_MODE.md).
 */
export function websiteSignatureRequired(
  requiredFlag: string | undefined = process.env.WEBSITE_SIGNATURE_REQUIRED,
  production: boolean = isProductionEnvironment()
): boolean {
  return production || (requiredFlag ?? "").trim().toLowerCase() === "true";
}

/** The one line to log at startup when website requests are required to be signed but this server cannot verify any, or undefined when there is nothing to say. */
export function websiteSigningStartupProblem(): string | undefined {
  if (!websiteSignatureRequired() || isLeadIngestSecretConfigured()) return undefined;
  return "[website-signature] LEAD_INGEST_SECRET is missing or shorter than 32 characters: every website request will be refused (503) until it is set (docs/WEBSITE_SIGNING_STRICT_MODE.md)";
}
