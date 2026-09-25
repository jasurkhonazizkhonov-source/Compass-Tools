import { InquiryInbox } from "@/components/get-in-touch/inquiry-inbox";

export const dynamic = "force-dynamic";

// CRM Inquiries inbox (admin-only): inquiries submitted through the Compass
// Tools CRM website's contact form. Shows ONLY source CRM_WEBSITE — never the
// Business Flights "Get In Touch" inquiries (/get-in-touch).
export default async function CrmInquiriesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <InquiryInbox source="CRM_WEBSITE" searchParams={await searchParams} />;
}
