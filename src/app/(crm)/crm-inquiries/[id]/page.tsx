import { InquiryDetailView } from "@/components/get-in-touch/inquiry-detail-view";

export const dynamic = "force-dynamic";

export default async function CrmInquiryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InquiryDetailView source="CRM_WEBSITE" id={id} />;
}
