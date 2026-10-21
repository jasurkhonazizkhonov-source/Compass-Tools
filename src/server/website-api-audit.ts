import { prisma } from "@/lib/prisma";

// Audit trail for the authenticated website API, written to the existing append-only AuditLog (entityType "Lead"). It records WHICH
// lead was created / recognised as a repeat / refused as a reused key, for which company and through which channel - never the request
// body, the customer's details, the Idempotency-Key, the credential or the connection's addresses. There is no staff actor: the caller is
// the website's backend, identified by the channel label.

export type WebsiteApiAuditAction = "WEBSITE_API_LEAD_CREATED" | "WEBSITE_API_LEAD_DUPLICATE" | "WEBSITE_API_LEAD_CONFLICT";

export async function auditWebsiteApi(params: { action: WebsiteApiAuditAction; leadId: string; companyId: string }): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: params.action,
        entityType: "Lead",
        entityId: params.leadId,
        metadata: { channel: "website-api", companyId: params.companyId },
      },
    });
  } catch {
    // Auditing must never turn a saved lead into a failed request.
    console.error("[website-api] audit write failed");
  }
}
