import type { LeadStatus, LeadSource, QuoteStatus, BookingStatus, Priority, PaymentChargeStatus, EnrollmentStatus, InquiryStatus, InquirySubject, CampaignStatus, MarketingSendStatus } from "@/generated/prisma/client";

export type StatusTone = "success" | "info" | "purple" | "warning" | "neutral" | "destructive";

const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-success/15 text-success border-success/30 dark:text-success",
  info: "bg-info/15 text-info border-info/30 dark:text-info",
  purple: "bg-purple/15 text-purple border-purple/30 dark:text-purple",
  warning: "bg-warning/20 text-warning-foreground border-warning/40",
  neutral: "bg-muted text-muted-foreground border-border",
  destructive: "bg-destructive/10 text-destructive border-destructive/30",
};

export function toneClass(tone: StatusTone) {
  return TONE_CLASSES[tone];
}

export const LEAD_STATUS_META: Record<LeadStatus, { label: string; tone: StatusTone }> = {
  NEW: { label: "New", tone: "info" },
  ATTEMPTING_TO_CONTACT: { label: "Attempting to Contact", tone: "warning" },
  REACHED: { label: "Reached", tone: "info" },
  IN_PROCESS: { label: "In Process", tone: "info" },
  QUOTED: { label: "Quoted", tone: "purple" },
  NOT_READY: { label: "Not Ready", tone: "neutral" },
  BOOKED: { label: "Booked", tone: "success" },
  ECONOMY: { label: "Economy", tone: "neutral" },
  NO_RESPONSE: { label: "No Response", tone: "neutral" },
  NOT_INTERESTED: { label: "Not Interested", tone: "destructive" },
  LOW_BUDGET: { label: "Low Budget", tone: "neutral" },
  BOOKED_ELSEWHERE: { label: "Booked Elsewhere", tone: "destructive" },
  OWN_POINTS: { label: "Own Points", tone: "info" },
  ACCEPTED: { label: "Accepted", tone: "success" },
};

export const QUOTE_STATUS_META: Record<QuoteStatus, { label: string; tone: StatusTone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SENT: { label: "Sent", tone: "info" },
  READ: { label: "Read", tone: "neutral" },
  VIEWED: { label: "Viewed", tone: "purple" },
  SIGNED: { label: "Signed", tone: "warning" },
  BOOKED: { label: "Booked", tone: "success" },
  CHARGED: { label: "Charged", tone: "success" },
  CANCELED: { label: "Canceled", tone: "destructive" },
  EXCHANGED: { label: "Exchanged", tone: "purple" },
  PENDING_EXCHANGE_APPROVAL: { label: "Pending Exchange Approval", tone: "warning" },
  EXCHANGE_APPROVED: { label: "Exchange Approved", tone: "success" },
  EXCHANGE_DISAPPROVED: { label: "Exchange Disapproved", tone: "destructive" },
  // Pass 26 — a proposal replaced by a newer one before anyone reviewed or
  // signed it (see Quote.isCurrentExchangeProposal/supersededByQuoteId).
  // Neutral, not destructive — nothing went wrong, the agent simply sent a
  // revised proposal; deliberately distinct from EXCHANGE_DISAPPROVED
  // (destructive — an Admin/Manager actively rejected it).
  EXCHANGE_SUPERSEDED: { label: "Superseded", tone: "neutral" },
  PENDING_CANCELLATION_APPROVAL: { label: "Pending Cancellation Approval", tone: "warning" },
  CANCELLATION_APPROVED: { label: "Cancellation Approved", tone: "warning" },
  CANCELLATION_FORM_SENT: { label: "Cancellation Form Sent", tone: "info" },
  CANCELLATION_SUBMITTED: { label: "Cancellation Submitted", tone: "purple" },
  // Pass 26 — deliberately distinct from CANCELED above, both in label
  // and tone. This is the TRUE terminal state of the formal cancellation
  // workflow (see this status's own doc comment in schema.prisma) — a
  // completed process, not a failure, and must never read as visually or
  // textually interchangeable with a quote simply discarded (CANCELED).
  // Previously "Cancelled" (a one-letter spelling variant of "Canceled")
  // with the same destructive tone — functionally indistinguishable at a
  // glance, which is exactly the bug this pass's own re-verification
  // found and fixed.
  CANCELLATION_CONFIRMED: { label: "Cancellation Done", tone: "success" },
};

export const BOOKING_STATUS_META: Record<BookingStatus, { label: string; tone: StatusTone }> = {
  PENDING_TICKETING: { label: "Pending Ticketing", tone: "warning" },
  TICKETED: { label: "Ticketed", tone: "info" },
  CONFIRMED: { label: "Confirmed", tone: "success" },
  CANCELED: { label: "Canceled", tone: "destructive" },
};

export const PAYMENT_CHARGE_STATUS_META: Record<PaymentChargeStatus, { label: string; tone: StatusTone }> = {
  PENDING: { label: "Processing", tone: "warning" },
  SUCCEEDED: { label: "Succeeded", tone: "success" },
  FAILED: { label: "Failed", tone: "destructive" },
  CANCELED: { label: "Canceled", tone: "neutral" },
};

export const ENROLLMENT_STATUS_META: Record<EnrollmentStatus, { label: string; tone: StatusTone }> = {
  ACTIVE: { label: "Active", tone: "info" },
  COMPLETED: { label: "Completed", tone: "success" },
  UNSUBSCRIBED: { label: "Unsubscribed", tone: "neutral" },
  FAILED: { label: "Failed", tone: "destructive" },
};

export const INQUIRY_STATUS_META: Record<InquiryStatus, { label: string; tone: StatusTone }> = {
  NEW: { label: "New", tone: "info" },
  IN_PROGRESS: { label: "In Progress", tone: "warning" },
  REPLIED: { label: "Replied", tone: "purple" },
  RESOLVED: { label: "Resolved", tone: "success" },
  CLOSED: { label: "Closed", tone: "neutral" },
};

export const INQUIRY_STATUS_ORDER: InquiryStatus[] = ["NEW", "IN_PROGRESS", "REPLIED", "RESOLVED", "CLOSED"];

export const INQUIRY_SUBJECT_LABELS: Record<InquirySubject, string> = {
  GENERAL_INQUIRY: "General Inquiry",
  FLIGHT_REQUEST_HELP: "Flight Request Help",
  EXISTING_BOOKING: "Existing Booking",
  CORPORATE_TRAVEL: "Corporate Travel",
  OTHER: "Other",
};

export const CAMPAIGN_STATUS_META: Record<CampaignStatus, { label: string; tone: StatusTone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SENDING: { label: "Sending", tone: "warning" },
  SENT: { label: "Sent", tone: "success" },
};

export const MARKETING_SEND_STATUS_META: Record<MarketingSendStatus, { label: string; tone: StatusTone }> = {
  PENDING: { label: "Pending", tone: "neutral" },
  SENT: { label: "Sent", tone: "success" },
  FAILED: { label: "Failed", tone: "destructive" },
  SKIPPED_UNSUBSCRIBED: { label: "Skipped (Unsubscribed)", tone: "neutral" },
};

export const PRIORITY_META: Record<Priority, { label: string; tone: StatusTone }> = {
  LOW: { label: "Low", tone: "neutral" },
  MEDIUM: { label: "Medium", tone: "info" },
  HIGH: { label: "High", tone: "destructive" },
};

// Part 1 — what generated a Commission row's profit (see
// server/queries/commissions.ts's derivation). Not a Prisma enum — this is
// derived at query time from Quote.originalQuoteId/Quote.status, never
// stored — so the type is hand-declared here rather than imported from
// @/generated/prisma/client. Warning (not full destructive) for
// Cancellation: a cancelled sale still recorded real, unaltered profit —
// this label is informational, not a red-alert.
export type CommissionTransactionType = "NEW_SALE" | "EXCHANGE" | "CANCELLATION";

export const COMMISSION_TRANSACTION_TYPE_META: Record<CommissionTransactionType, { label: string; tone: StatusTone }> = {
  NEW_SALE: { label: "New Sale", tone: "neutral" },
  EXCHANGE: { label: "Exchange", tone: "info" },
  CANCELLATION: { label: "Cancellation", tone: "warning" },
};

// Display labels for LeadSource — reuses the existing enum (no duplicate
// field) but overrides two values' wording to match how this CRM actually
// talks about lead intake: PHONE reads as "Incoming Call" and OTHER reads
// as "New Request", since those are the terms staff use day to day. Every
// other value keeps its plain Title Case default (WEBSITE -> "Website",
// REFERRAL -> "Referral", etc.) via the fallback in leadSourceLabel().
const LEAD_SOURCE_LABEL_OVERRIDES: Partial<Record<LeadSource, string>> = {
  PHONE: "Incoming Call",
  OTHER: "New Request",
};

export function leadSourceLabel(source: LeadSource): string {
  return LEAD_SOURCE_LABEL_OVERRIDES[source] ?? source.charAt(0) + source.slice(1).toLowerCase();
}

export const LEAD_STATUS_ORDER: LeadStatus[] = [
  "NEW",
  "ATTEMPTING_TO_CONTACT",
  "ACCEPTED",
  "REACHED",
  "IN_PROCESS",
  "QUOTED",
  "NOT_READY",
  "BOOKED",
  "ECONOMY",
  "NO_RESPONSE",
  "NOT_INTERESTED",
  "LOW_BUDGET",
  "BOOKED_ELSEWHERE",
  "OWN_POINTS",
];
