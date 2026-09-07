"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canManageAccounts } from "@/lib/permissions";
import { getGmailConnectionState } from "@/server/queries/gmail-connection";
import { getCompanyForAccountId } from "@/server/queries/company";
import { sendEmail } from "@/server/email/service";
import { buildSequenceEmail } from "@/server/email/templates";
import type { InquiryStatus } from "@/generated/prisma/client";

/** Admin-only, same assertAdmin() pattern as accounts.ts — Get in Touch is
 * explicitly admin-only per Part 9's spec (unlike most CRM resources, no
 * other role has any access to it at all). */
async function assertAdmin() {
  const current = await getCurrentAccount();
  if (!canManageAccounts(current?.role)) {
    throw new Error("Only Admins can access Get in Touch");
  }
  return current!;
}

async function assertInquiryAccess(companyId: string, inquiryId: string) {
  const inquiry = await prisma.contactInquiry.findFirst({ where: { id: inquiryId, companyId }, select: { id: true } });
  if (!inquiry) throw new Error("Inquiry not found");
}

export async function markInquiryRead(inquiryId: string) {
  const admin = await assertAdmin();
  await assertInquiryAccess(admin.companyId, inquiryId);
  await prisma.contactInquiry.updateMany({
    where: { id: inquiryId, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath("/get-in-touch");
  revalidatePath(`/get-in-touch/${inquiryId}`);
}

const STATUS_VALUES = ["NEW", "IN_PROGRESS", "REPLIED", "RESOLVED", "CLOSED"] as const;

export async function updateInquiryStatus(inquiryId: string, status: InquiryStatus) {
  const admin = await assertAdmin();
  z.enum(STATUS_VALUES).parse(status);
  await assertInquiryAccess(admin.companyId, inquiryId);
  await prisma.contactInquiry.update({ where: { id: inquiryId }, data: { status } });
  revalidatePath("/get-in-touch");
  revalidatePath(`/get-in-touch/${inquiryId}`);
}

export async function assignInquiry(inquiryId: string, assignedAdminId: string | null) {
  const admin = await assertAdmin();
  await assertInquiryAccess(admin.companyId, inquiryId);
  if (assignedAdminId) {
    const target = await prisma.account.findFirst({ where: { id: assignedAdminId, companyId: admin.companyId, role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
    if (!target) throw new Error("Assignee must be an active Admin in your own company");
  }
  await prisma.contactInquiry.update({ where: { id: inquiryId }, data: { assignedAdminId } });
  revalidatePath("/get-in-touch");
  revalidatePath(`/get-in-touch/${inquiryId}`);
}

export async function addInquiryNote(inquiryId: string, body: string) {
  const admin = await assertAdmin();
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Note cannot be empty");
  await assertInquiryAccess(admin.companyId, inquiryId);
  await prisma.inquiryNote.create({ data: { inquiryId, authorId: admin.id, body: trimmed } });
  revalidatePath(`/get-in-touch/${inquiryId}`);
}

const inquiryEmailSchema = z.object({
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
});

/**
 * Item 9 — the Get in Touch detail page's internal email composer,
 * replacing the old plain `mailto:` Email button. Reuses buildSequenceEmail
 * exactly like sendLeadEmail (leads.ts) does — same plain-text-body-to-HTML
 * rendering, same "sender is always the acting admin's own connected
 * Gmail, no fallback" behavior, same EmailLog/error-handling shape.
 *
 * Pass 15 correction — this comment previously claimed sendLeadEmail's `to`
 * param was only syntactically validated and not cross-checked against the
 * lead's own contact email, calling it "a related, pre-existing gap, out of
 * scope." Re-verified against the current code: that gap no longer exists —
 * sendLeadEmail (leads.ts) already derives `allowedRecipients` from the
 * lead's own `contact.primaryEmail`/`contact.emails` and passes it into
 * sendCrmEmail, which throws RecipientNotAllowedError before any Gmail call
 * if `to` contains anything outside that set (see crm-email.ts's own header
 * comment for the original Pass 6 fix). This function stays marginally
 * stricter still — the recipient is never taken from client input at all,
 * always re-read from the inquiry row itself — but both paths are equally
 * safe against sending to an attacker-controlled address today.
 */
export async function sendInquiryEmail(inquiryId: string, input: z.infer<typeof inquiryEmailSchema>) {
  const admin = await assertAdmin();
  const data = inquiryEmailSchema.parse(input);

  const inquiry = await prisma.contactInquiry.findFirst({
    where: { id: inquiryId, companyId: admin.companyId },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  if (!inquiry) throw new Error("Inquiry not found");

  const gmailStatus = await getGmailConnectionState(admin.id);
  if (gmailStatus === "REVOKED") {
    throw new Error("Your Gmail connection needs to be reconnected before you can send email. Go to your account menu to reconnect.");
  }
  if (gmailStatus !== "CONNECTED") {
    throw new Error("Connect your Gmail account before sending email. Go to your account menu to connect Gmail.");
  }

  const company = await getCompanyForAccountId(admin.id);
  const { subject, html } = buildSequenceEmail({
    subject: data.subject,
    bodyText: data.body,
    agent: { fullName: admin.fullName, email: admin.email, phone: admin.phone },
    company,
  });

  const result = await sendEmail({
    accountId: admin.id,
    to: inquiry.email,
    subject,
    html,
    senderName: admin.fullName,
    replyTo: admin.email,
  });

  await prisma.emailLog.create({
    data: {
      type: "INQUIRY_EMAIL",
      subject,
      fromEmail: admin.email,
      toEmail: inquiry.email,
      status: result.ok ? "SENT" : "FAILED",
      errorMessage: result.ok ? undefined : result.error,
      messageId: result.ok ? result.messageId : undefined,
      contactInquiryId: inquiryId,
    },
  });

  if (!result.ok) {
    throw new Error(result.error || "Failed to send email");
  }

  revalidatePath(`/get-in-touch/${inquiryId}`);
  return { ok: true as const };
}

/** Part 3 — Admin-only permanent deletion, same assertAdmin()/
 * assertInquiryAccess() company-scoped guard as every other action in this
 * file. Cascades to the inquiry's own InquiryNote rows and any
 * Notification pointing at it (schema onDelete: Cascade). */
export async function deleteInquiry(inquiryId: string) {
  const admin = await assertAdmin();
  await assertInquiryAccess(admin.companyId, inquiryId);
  await prisma.contactInquiry.delete({ where: { id: inquiryId } });
  revalidatePath("/get-in-touch");
}
