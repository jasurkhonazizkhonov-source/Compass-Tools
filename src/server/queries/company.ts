import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { absoluteUrl, type ResolvedCompanyBranding } from "@/lib/company-config";
import { processLogo } from "@/lib/logo-processing";

const FALLBACK_LOGO_PATH = "/logo.png";
const FALLBACK_NAME = "Compass Tools";
const FALLBACK_BRAND_COLOR = "#1c3a5e";
const FALLBACK_SIGNATURE = "Best regards,\n{{first_name}} {{last_name}}\n{{phone_number}}";

type CompanyRow = {
  id: string;
  name: string;
  website: string | null;
  phone: string | null;
  brandColor: string | null;
  logoEmailUrl: string | null;
  logoEmailData: Uint8Array | null;
  logoWebUrl: string | null;
  logoIconUrl: string | null;
  signatureTemplate: string;
} | null;

// Lazily processes the bundled static fallback logo (public/logo.png) into
// an email-sized data: URI, once per server process — a static asset that
// never changes at runtime while present, so a plain cached promise is
// enough once it succeeds. Reuses the exact same processLogo() pipeline a
// real upload goes through, rather than inlining the full ~360KB original
// file into every email.
//
// Deliberately resilient to the file being unreadable (missing, wrong
// working directory, permissions, corrupt) — this is a bundled convenience
// asset, not something the CRM's ability to render at all should ever
// depend on. Never throws: resolves to null on any failure, which callers
// treat as "no logo available," not an error. Assigning the in-flight
// promise to the cache variable BEFORE awaiting (rather than only after a
// successful result) means concurrent calls share one attempt. A FAILED
// attempt resets the cache back to null before resolving, so it is never
// permanently cached as broken: the next call (not ones already in flight)
// gets a fresh attempt instead of being stuck forever — e.g. an ops fix
// (permissions corrected, file placed) between requests is picked up
// without a process restart.
//
// A company that never uploaded its own logo — and this bundled asset
// being absent too — is a completely normal, valid, permanent state (most
// CRM deployments will have real customer companies with no logo on file
// for a while, or ever). Retrying the read on every subsequent call is
// still worthwhile (see above), but logging on every single one of those
// retries would mean every page render/email send for such a company spams
// the server log forever with what is, in the overwhelmingly common case,
// not a problem at all — the exact "exceptional filesystem error" framing
// this must NOT be. So: the "file simply isn't there" case (ENOENT) is
// logged at most once per process, at a quiet, unambiguously-informational
// level. Anything else (permission denied, a corrupt/unreadable image
// `processLogo` itself rejects, etc.) — a genuine, actionable problem, not
// an expected state — still logs every time it recurs, at `console.error`,
// so a real ops issue stays visible rather than being silently swallowed
// after the first occurrence.
let cachedFallbackLogoEmailDataUri: Promise<string | null> | null = null;
let hasLoggedMissingFallbackLogo = false;
function getFallbackLogoEmailDataUri(): Promise<string | null> {
  if (!cachedFallbackLogoEmailDataUri) {
    const logoPath = path.join(process.cwd(), "public", "logo.png");
    cachedFallbackLogoEmailDataUri = (async () => {
      try {
        const buffer = await readFile(logoPath);
        const processed = await processLogo(buffer);
        return `data:image/png;base64,${processed.email.toString("base64")}`;
      } catch (err) {
        const isMissingFile = err instanceof Error && "code" in err && err.code === "ENOENT";
        if (isMissingFile) {
          // Expected/optional — a company with no uploaded logo and no
          // bundled fallback on disk is a normal, valid state, not an
          // error. One quiet, one-time note is enough context for anyone
          // reading the logs; it must never repeat per-request.
          if (!hasLoggedMissingFallbackLogo) {
            hasLoggedMissingFallbackLogo = true;
            console.info(`No bundled fallback logo at ${logoPath} — optional; a company with no uploaded logo of its own will simply have none in its emails/signature until one is added.`);
          }
        } else {
          // Not "missing" — something actually went wrong (permissions,
          // a corrupt file, processLogo rejecting it). Worth surfacing
          // every time it recurs, not just once.
          console.error(`Static fallback logo at ${logoPath} could not be processed — emails/signatures for a company with no uploaded logo will simply omit the logo.`, err);
        }
        cachedFallbackLogoEmailDataUri = null;
        return null;
      }
    })();
  }
  return cachedFallbackLogoEmailDataUri;
}

/** Every field always has a usable value EXCEPT logoEmailUrl (see its own
 * doc comment on ResolvedCompanyBranding) — customer pages/emails never
 * need to null-check anything else before rendering. The all-null fallback
 * path (company === null) should not normally trigger (every Account has a
 * non-null companyId), but stays safe if it somehow does (a deleted/
 * orphaned reference, a test fixture, etc.) rather than breaking the page/
 * email entirely. */
async function resolveBranding(company: CompanyRow): Promise<ResolvedCompanyBranding> {
  const fallbackLogo = absoluteUrl(FALLBACK_LOGO_PATH);
  // logoEmailUrl specifically is embedded in emails, opened by external
  // mail clients that can't reach a URL pointing back at this app's own
  // (possibly ephemeral/local) filesystem — inline actual bytes as a
  // data: URI instead. Four tiers, most to least preferred: (1) this
  // company's own uploaded logo, captured as bytes since a previous fix;
  // (2) the same company's logo uploaded BEFORE that fix (only has the old
  // file-path field) — still attempted via the old URL, for a stable
  // filesystem where it happens to still work; (3) the bundled static
  // fallback logo, inlined as a data: URI so a company with no logo
  // uploaded at all still gets *something* in email rather than a broken
  // image; (4) null, if even that bundled fallback couldn't be read (see
  // getFallbackLogoEmailDataUri — never throws) — callers omit the logo
  // from the email/signature entirely rather than rendering a broken
  // image or crashing. logoWebUrl/logoIconUrl are unaffected — those only
  // ever render inside an authenticated, same-origin CRM tab, where the
  // existing URL approach already works regardless of this file's
  // presence on disk at request time.
  const logoEmailUrl = company?.logoEmailData
    ? `data:image/png;base64,${Buffer.from(company.logoEmailData).toString("base64")}`
    : company?.logoEmailUrl
      ? absoluteUrl(company.logoEmailUrl)
      : await getFallbackLogoEmailDataUri();
  return {
    id: company?.id ?? "unknown",
    name: company?.name || FALLBACK_NAME,
    website: company?.website ?? null,
    phone: company?.phone ?? null,
    brandColor: company?.brandColor || FALLBACK_BRAND_COLOR,
    logoEmailUrl,
    logoWebUrl: absoluteUrl(company?.logoWebUrl || FALLBACK_LOGO_PATH) || fallbackLogo,
    logoIconUrl: absoluteUrl(company?.logoIconUrl || FALLBACK_LOGO_PATH) || fallbackLogo,
    signatureTemplate: company?.signatureTemplate || FALLBACK_SIGNATURE,
  };
}

const COMPANY_SELECT = {
  id: true,
  name: true,
  website: true,
  phone: true,
  brandColor: true,
  logoEmailUrl: true,
  logoEmailData: true,
  logoWebUrl: true,
  logoIconUrl: true,
  signatureTemplate: true,
} as const;

export async function getCompanyById(companyId: string): Promise<ResolvedCompanyBranding> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: COMPANY_SELECT });
  return resolveBranding(company);
}

/** For a signed-in CRM user — resolves via their own Account.companyId. */
export async function getCompanyForAccountId(accountId: string | null | undefined): Promise<ResolvedCompanyBranding> {
  if (!accountId) return resolveBranding(null);
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { companyId: true } });
  if (!account) return resolveBranding(null);
  return getCompanyById(account.companyId);
}

/** For customer-facing pages/emails reached via a Contact (no CRM session
 * — e.g. the public quote/booking pages) — resolves via the Contact's own
 * companyId directly (set at creation, see createLead in
 * src/server/actions/leads.ts). Deliberately NOT via `owner.companyId`:
 * ownerId is nullable (a brand-new unassigned lead has no owner yet), so
 * that path would silently fall back to generic product branding for any
 * customer-facing page reached before the lead's first owner is assigned. */
export async function getCompanyForContactId(contactId: string): Promise<ResolvedCompanyBranding> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { companyId: true },
  });
  if (!contact) return resolveBranding(null);
  return getCompanyById(contact.companyId);
}

/** Back-compat single-value helper for callers that only need the logo
 * (not full branding) — e.g. the shared <CompanyLogo> component. Only the
 * "email" variant can ever be null — see ResolvedCompanyBranding's doc
 * comment. */
export async function getCompanyLogoUrl(companyId: string, variant: "email" | "web" | "icon" = "web"): Promise<string | null> {
  const branding = await getCompanyById(companyId);
  return variant === "email" ? branding.logoEmailUrl : variant === "icon" ? branding.logoIconUrl : branding.logoWebUrl;
}

/** Raw (un-fallback'd) row for the Company settings admin UI — the admin
 * needs to see what's ACTUALLY stored (e.g. a genuinely empty website
 * field) rather than getCompanyById's rendering-ready fallback
 * substitutions, so the form doesn't appear to have unsaved/default values
 * that were never really set. */
export async function getCompanyRawById(companyId: string) {
  return prisma.company.findUnique({ where: { id: companyId } });
}
