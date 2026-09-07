"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canManageSystemSettings } from "@/lib/permissions";
import { validateLogoUpload, processLogo } from "@/lib/logo-processing";
import { saveLogoVariants } from "@/lib/logo-storage";

/** Every Company action is admin-only and scoped to the caller's OWN
 * company — never an arbitrary companyId from the client. Returns the
 * calling admin's own Account (which already carries companyId). */
async function assertAdmin() {
  const current = await getCurrentAccount();
  if (!canManageSystemSettings(current?.role)) {
    throw new Error("Only Admins can manage company settings");
  }
  return current!;
}

const updateCompanyInfoSchema = z.object({
  name: z.string().min(1, "Company name is required").max(200),
  website: z.string().url().max(500).optional().or(z.literal("")),
  phone: z.string().max(50).optional().or(z.literal("")),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Brand color must be a hex value like #1c3a5e")
    .optional()
    .or(z.literal("")),
});

export async function updateCompanyInfo(input: z.infer<typeof updateCompanyInfoSchema>) {
  const current = await assertAdmin();
  const data = updateCompanyInfoSchema.parse(input);

  await prisma.company.update({
    where: { id: current.companyId },
    data: {
      name: data.name,
      website: data.website || null,
      phone: data.phone || null,
      brandColor: data.brandColor || null,
    },
  });

  revalidatePath("/company");
  revalidatePath("/", "layout");
}

const updateCompanySignatureSchema = z.object({
  signatureTemplate: z.string().max(2000),
});

export async function updateCompanySignature(input: z.infer<typeof updateCompanySignatureSchema>) {
  const current = await assertAdmin();
  const data = updateCompanySignatureSchema.parse(input);

  await prisma.company.update({
    where: { id: current.companyId },
    data: { signatureTemplate: data.signatureTemplate },
  });

  revalidatePath("/company");
}

export type UploadLogoResult =
  | { ok: true; logoWebUrl: string; logoEmailUrl: string; logoIconUrl: string; transparencyApplied: boolean }
  | { ok: false; error: string };

/**
 * Accepts a raw upload (already read into a Buffer by the caller — server
 * actions receiving a `File` via FormData is the standard Next.js pattern,
 * but the actual sharp/filesystem work is kept in plain library modules so
 * it stays independently testable). Never throws past a safe, specific
 * error result: a failed upload leaves the company's existing logo (or the
 * static fallback) completely untouched — the Company page and every email/
 * booking page that reads it keeps working regardless.
 */
export async function uploadCompanyLogo(formData: FormData): Promise<UploadLogoResult> {
  const current = await assertAdmin();

  const file = formData.get("logo");
  if (!(file instanceof File)) {
    return { ok: false, error: "No file was uploaded." };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const validation = await validateLogoUpload(buffer);
  if (!validation.ok) {
    await prisma.company.update({
      where: { id: current.companyId },
      data: { logoProcessingStatus: "FAILED", logoProcessingError: validation.error },
    });
    revalidatePath("/company");
    return { ok: false, error: validation.error };
  }

  await prisma.company.update({
    where: { id: current.companyId },
    data: { logoProcessingStatus: "PROCESSING", logoProcessingError: null },
  });

  try {
    const processed = await processLogo(buffer);
    const urls = await saveLogoVariants(
      current.companyId,
      { original: processed.original, email: processed.email, web: processed.web, icon: processed.icon },
      validation.format
    );

    await prisma.company.update({
      where: { id: current.companyId },
      data: {
        logoOriginalUrl: urls.originalUrl,
        logoEmailUrl: urls.emailUrl,
        logoWebUrl: urls.webUrl,
        logoIconUrl: urls.iconUrl,
        // Stored as raw bytes too, alongside the file-path URL above —
        // emails embed this directly as a data: URI (see resolveBranding in
        // src/server/queries/company.ts) since external mail clients can't
        // reach a locally-written file the way a same-origin CRM tab can.
        logoEmailData: Uint8Array.from(processed.email),
        logoProcessingStatus: "PROCESSED",
        logoProcessingError: null,
      },
    });

    revalidatePath("/company");
    revalidatePath("/", "layout");
    return { ok: true, logoWebUrl: urls.webUrl, logoEmailUrl: urls.emailUrl, logoIconUrl: urls.iconUrl, transparencyApplied: processed.transparencyApplied };
  } catch (err) {
    // Processing failed after passing validation (e.g. a filesystem write
    // error) — preserve whatever logo URLs the company already had (never
    // clear them) and surface a clear, specific status instead of a raw
    // stack trace, per the "never break the Company page or emails/booking
    // pages" requirement.
    const message = err instanceof Error ? err.message : "Logo processing failed unexpectedly.";
    await prisma.company.update({
      where: { id: current.companyId },
      data: { logoProcessingStatus: "FAILED", logoProcessingError: message },
    });
    revalidatePath("/company");
    return { ok: false, error: message };
  }
}

/** Reverts to the static fallback logo (src/server/queries/company.ts's
 * FALLBACK_LOGO_PATH) — clears the company's own logo fields rather than
 * deleting the underlying files (the timestamped filenames mean nothing
 * else on disk gets clobbered by a future upload). */
export async function removeCompanyLogo() {
  const current = await assertAdmin();

  await prisma.company.update({
    where: { id: current.companyId },
    data: {
      logoOriginalUrl: null,
      logoEmailUrl: null,
      logoWebUrl: null,
      logoIconUrl: null,
      logoEmailData: null,
      logoProcessingStatus: "NONE",
      logoProcessingError: null,
    },
  });

  revalidatePath("/company");
  revalidatePath("/", "layout");
}
