import { notFound } from "next/navigation";
import { Building2 } from "lucide-react";
import { getCurrentAccount } from "@/lib/dev-session";
import { canManageSystemSettings } from "@/lib/permissions";
import { getCompanyRawById, getCompanyById } from "@/server/queries/company";
import { splitFullName } from "@/lib/email-signature";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { CompanyInfoForm } from "@/components/company/company-info-form";
import { CompanyLogoPanel } from "@/components/company/company-logo-panel";
import { CompanySignatureForm } from "@/components/company/company-signature-form";

export const dynamic = "force-dynamic";

/**
 * Admin-only Company settings — branding, logo, and email signature.
 * Gated at three layers, same pattern as /users: proxy.ts (route-level
 * redirect for a non-admin), here (page-level notFound() for anything
 * that reaches the page component directly), and every server action in
 * src/server/actions/company.ts (assertAdmin() re-checked independently).
 */
export default async function CompanyPage() {
  const current = await getCurrentAccount();
  if (!canManageSystemSettings(current?.role)) notFound();

  const [raw, resolved] = await Promise.all([
    getCompanyRawById(current!.companyId),
    getCompanyById(current!.companyId),
  ]);
  if (!raw) notFound();

  const { firstName, lastName } = splitFullName(current!.fullName);

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Building2 className="h-5 w-5 text-muted-foreground" />
          Company
        </h1>
        <p className="text-sm text-muted-foreground">
          Branding, logo, and email signature for your company — applies automatically across quotes, booking pages,
          and every outgoing email. Only visible to Admins.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Company information</CardTitle>
          <CardDescription>Shown to customers on quotes, booking pages, and in email footers.</CardDescription>
        </CardHeader>
        <CardContent>
          <CompanyInfoForm
            initialName={raw.name}
            initialWebsite={raw.website ?? ""}
            initialPhone={raw.phone ?? ""}
            initialBrandColor={raw.brandColor ?? "#1c3a5e"}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logo</CardTitle>
          <CardDescription>Used across the customer quote page, booking pages, and CRM emails.</CardDescription>
        </CardHeader>
        <CardContent>
          <CompanyLogoPanel currentWebUrl={resolved.logoWebUrl} status={raw.logoProcessingStatus} error={raw.logoProcessingError} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email signature</CardTitle>
          <CardDescription>
            Applied automatically to every future email sent by any team member — no one ever needs to update their
            own signature manually.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CompanySignatureForm
            initialTemplate={raw.signatureTemplate}
            exampleFirstName={firstName || "Alex"}
            exampleLastName={lastName || "Rivera"}
            examplePhone={current!.phone ?? ""}
          />
        </CardContent>
      </Card>
    </div>
  );
}
