import type { InquirySource } from "@/generated/prisma/client";

// The two inbound-inquiry systems the Admin sees. They share one database
// table (ContactInquiry) but are DIFFERENT SYSTEMS with different origins:
// every list, detail page, mutation and notification is scoped by `source`,
// and this is the one place their names, routes and notification types live
// so nothing else hardcodes (and confuses) them.
export const INQUIRY_SOURCE_META: Record<
  InquirySource,
  { label: string; shortLabel: string; description: string; basePath: string; notificationType: string; notificationTitle: string }
> = {
  BUSINESS_FLIGHTS_WEBSITE: {
    label: "Business Flights — Get In Touch",
    shortLabel: "Get In Touch",
    description: "Website contact inquiries submitted through the Business Flights Travel website.",
    basePath: "/get-in-touch",
    notificationType: "NEW_INQUIRY",
    notificationTitle: "New Business Flights Get In Touch Message",
  },
  CRM_WEBSITE: {
    label: "CRM Inquiries",
    shortLabel: "CRM Inquiries",
    description: "Inquiries submitted through the Compass Tools CRM website's contact form.",
    basePath: "/crm-inquiries",
    notificationType: "NEW_CRM_INQUIRY",
    notificationTitle: "New CRM Inquiry",
  },
};

export const INQUIRY_SOURCES = Object.keys(INQUIRY_SOURCE_META) as InquirySource[];

/** Where an inquiry's detail page lives, by the inquiry's OWN source. */
export function inquiryDetailPath(source: InquirySource, inquiryId: string): string {
  return `${INQUIRY_SOURCE_META[source].basePath}/${inquiryId}`;
}
