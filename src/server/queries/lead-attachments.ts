import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { leadVisibilityWhere, type Viewer } from "@/server/visibility";
import { leadRouteLabel } from "@/lib/lead-itinerary";

// Lead documents — METADATA ONLY. Nothing here reads file bytes, and the object key (storageKey) is never selected: the browser can only
// reach a file through the authorised download route by attachment id.
//
// Authorisation is part of every query, not a step before it: an attachment is returned only if it is READY, belongs to the viewer's
// company, and its OWN Lead satisfies leadVisibilityWhere(viewer) (the single source of truth for which leads a role / manager team can
// see). Contact-level views derive from the Lead the same way, so a Contact can never be a path around Lead access.

export const ATTACHMENT_LIST_LIMIT = 100;

const ACCOUNT_NAME_SELECT = { id: true, fullName: true } as const;

export const ATTACHMENT_SAFE_SELECT = {
  id: true,
  fileName: true,
  description: true,
  fileType: true,
  fileSize: true,
  createdAt: true,
  leadId: true,
  uploadedBy: { select: ACCOUNT_NAME_SELECT },
} satisfies Prisma.AttachmentSelect;

/** The WHERE every read of a viewer's attachments starts from. */
export function visibleAttachmentWhere(viewer: Viewer): Prisma.AttachmentWhereInput {
  if (!viewer) return { id: "__no_viewer__" };
  return {
    status: "READY",
    storageKey: { not: null },
    companyId: viewer.companyId,
    lead: { is: leadVisibilityWhere(viewer) },
  };
}

export async function listLeadAttachments(leadId: string, viewer: Viewer) {
  const where: Prisma.AttachmentWhereInput = { ...visibleAttachmentWhere(viewer), leadId };
  const [items, total] = await Promise.all([
    prisma.attachment.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: ATTACHMENT_LIST_LIMIT, select: ATTACHMENT_SAFE_SELECT }),
    prisma.attachment.count({ where }),
  ]);
  return { items, total };
}

/**
 * Every document of every Lead of this Contact that the viewer may see — one query (no per-lead round trips) that reuses the same
 * visibility rule, so a Lead the viewer cannot access contributes nothing. Each row carries the Lead it was uploaded to.
 */
export async function listContactLeadAttachments(contactId: string, viewer: Viewer) {
  const where: Prisma.AttachmentWhereInput = {
    ...visibleAttachmentWhere(viewer),
    lead: { is: { AND: [leadVisibilityWhere(viewer), { contactId }] } },
  };
  const [rows, total] = await Promise.all([
    prisma.attachment.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ATTACHMENT_LIST_LIMIT,
      select: {
        ...ATTACHMENT_SAFE_SELECT,
        lead: {
          select: {
            id: true,
            tripType: true,
            departureAirport: { select: { iata: true } },
            arrivalAirport: { select: { iata: true } },
            segments: { orderBy: { sequence: "asc" }, select: { id: true, sequence: true, departureAirport: { select: { iata: true } }, arrivalAirport: { select: { iata: true } } } },
          },
        },
      },
    }),
    prisma.attachment.count({ where }),
  ]);
  const items = rows.map(({ lead, ...rest }) => ({ ...rest, leadRoute: lead ? leadRouteLabel(lead) : "—" }));
  return { items, total };
}
