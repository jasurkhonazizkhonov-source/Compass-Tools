import { InquiryInbox } from "@/components/get-in-touch/inquiry-inbox";

export const dynamic = "force-dynamic";

// Business Flights Travel website — "Get In Touch" inbox (admin-only). Shows
// ONLY inquiries with source BUSINESS_FLIGHTS_WEBSITE. The CRM website's own
// inquiries live in the separate "CRM Inquiries" section (/crm-inquiries).
export default async function BusinessFlightsGetInTouchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <InquiryInbox source="BUSINESS_FLIGHTS_WEBSITE" searchParams={await searchParams} />;
}
