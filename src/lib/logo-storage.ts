// Local-filesystem storage for processed company logo variants. Chosen
// because no cloud storage credentials are configured anywhere in this
// project (no AWS/Cloudinary/S3/Blob env vars — confirmed by inspection)
// and this app has no existing upload mechanism to reuse. This mirrors how
// CARD_ENCRYPTION_KEY is already an explicitly dev-only stand-in for real
// key management in this codebase: writing to public/uploads works for a
// single-instance/local deployment, but will NOT survive a serverless or
// multi-instance production deployment (an ephemeral or per-instance
// filesystem). Swap this module's writeLogoFile() for a real object-
// storage client (S3, Cloudinary, Vercel Blob, etc.) before deploying to
// such an environment — every caller only depends on getting back a
// public URL, so that swap doesn't touch anything upstream.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads", "companies");

export type LogoVariantUrls = {
  originalUrl: string;
  emailUrl: string;
  webUrl: string;
  iconUrl: string;
};

// The three processed variants are always genuinely re-encoded to PNG by
// processLogo() (sharp's .png() call), so they always get a real .png
// extension. The original buffer is preserved byte-for-byte verbatim
// (fidelity, and so an animated GIF upload isn't silently flattened) — it
// keeps its own real format's extension rather than being mislabeled.
function extensionForFormat(format: string): string {
  if (format === "jpeg" || format === "jpg") return "jpg";
  if (format === "gif") return "gif";
  if (format === "webp") return "webp";
  return "png";
}

/** Writes all four buffers for one company, cache-busted with a fresh
 * timestamp per upload so a re-upload is never served stale from a
 * browser/CDN cache under the old filename. Returns public URL paths
 * (relative to the app's own origin — resolved to absolute via
 * absoluteUrl() by callers that need one, e.g. for emails). */
export async function saveLogoVariants(
  companyId: string,
  variants: { original: Buffer; email: Buffer; web: Buffer; icon: Buffer },
  originalFormat: string
): Promise<LogoVariantUrls> {
  const dir = path.join(UPLOADS_ROOT, companyId);
  await mkdir(dir, { recursive: true });

  const stamp = Date.now();
  const originalExt = extensionForFormat(originalFormat);
  const files: Array<[string, Buffer]> = [
    [`original-${stamp}.${originalExt}`, variants.original],
    [`email-${stamp}.png`, variants.email],
    [`web-${stamp}.png`, variants.web],
    [`icon-${stamp}.png`, variants.icon],
  ];

  await Promise.all(files.map(([name, buf]) => writeFile(path.join(dir, name), buf)));

  const publicBase = `/uploads/companies/${companyId}`;
  return {
    originalUrl: `${publicBase}/original-${stamp}.${originalExt}`,
    emailUrl: `${publicBase}/email-${stamp}.png`,
    webUrl: `${publicBase}/web-${stamp}.png`,
    iconUrl: `${publicBase}/icon-${stamp}.png`,
  };
}
