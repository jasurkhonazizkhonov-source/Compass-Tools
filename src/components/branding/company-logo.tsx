// Server Component — reads the signed-in staff member's own Company logo
// once and renders it cropped/compact via CSS rather than a manually-
// cropped image file, so there's exactly one logo asset per company and
// one place that decides how it's sized wherever it appears. Consumers
// pick a `variant` for context-appropriate framing; the underlying image
// is the same file either way. Used only in internal CRM chrome (an
// authenticated context) — customer-facing pages resolve branding via the
// specific record's own company instead (getCompanyForContactId) since
// there's no signed-in account to derive it from there.
import { getCurrentAccount } from "@/lib/dev-session";
import { getCompanyForAccountId } from "@/server/queries/company";
import { cn } from "@/lib/utils";

const VARIANT_CLASS: Record<"header" | "compact", string> = {
  // A fixed height + `w-auto` + object-contain scales the logo to a
  // sensible size while preserving its real aspect ratio exactly, so it
  // never gets stretched, squashed, or clipped regardless of where it's
  // placed.
  header: "h-9 w-auto object-contain object-center",
  compact: "h-6 w-auto object-contain object-center",
};

export async function CompanyLogo({
  variant = "header",
  className,
}: {
  variant?: "header" | "compact";
  className?: string;
}) {
  const current = await getCurrentAccount();
  const company = await getCompanyForAccountId(current?.id);
  // eslint-disable-next-line @next/next/no-img-element -- local/DB-referenced static asset, no remote-image optimization needed
  return <img src={company.logoWebUrl} alt={company.name} className={cn(VARIANT_CLASS[variant], className)} />;
}
