import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

export async function logActivity(params: {
  contactId?: string;
  leadId?: string;
  quoteId?: string;
  bookingId?: string;
  actorId?: string | null;
  type: string;
  description: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.activity.create({
    data: {
      contactId: params.contactId,
      leadId: params.leadId,
      quoteId: params.quoteId,
      bookingId: params.bookingId,
      actorId: params.actorId ?? undefined,
      type: params.type,
      description: params.description,
      metadata: params.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}
