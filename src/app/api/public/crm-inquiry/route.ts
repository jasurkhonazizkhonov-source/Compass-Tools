import { handlePublicInquiryPost } from "@/server/public-inquiry";
import { RATE_LIMITS } from "@/server/security/rate-limit";

// The Compass Tools CRM website's contact form ("Get in Touch" on the CRM
// product site). Rows created here are tagged CRM_WEBSITE and appear ONLY in
// the Admin "CRM Inquiries" inbox (/crm-inquiries) — never in the Business
// Flights Get In Touch inbox, which is fed by /api/public/contact-inquiry and
// by the Business Flights website itself.
export async function POST(req: Request) {
  return handlePublicInquiryPost(req, {
    source: "CRM_WEBSITE",
    rateLimitEndpoint: "CRM_INQUIRY",
    rateLimit: RATE_LIMITS.CRM_INQUIRY,
    // This route's own form (src/components/marketing/contact-form.tsx)
    // collects a real, country-validated phone number and a honeypot field,
    // and shows a submitting/duplicate-safe UI — so, unlike
    // /api/public/contact-inquiry (a separate application this repo does not
    // control), it can safely opt into the stricter checks below.
    requirePhone: true,
    honeypot: true,
    duplicateWindowMs: 60_000,
  });
}
