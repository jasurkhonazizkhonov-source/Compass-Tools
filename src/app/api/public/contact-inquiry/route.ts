import { handlePublicInquiryPost } from "@/server/public-inquiry";
import { RATE_LIMITS } from "@/server/security/rate-limit";

// Business Flights Travel website — "Get In Touch". Rows created here are
// tagged BUSINESS_FLIGHTS_WEBSITE and appear ONLY in the Admin "Business
// Flights — Get In Touch" inbox (/get-in-touch). (The Business Flights
// website app itself writes the same kind of row directly to the database;
// the column default classifies those identically.) The CRM website's own
// contact form uses /api/public/crm-inquiry — a separate system and inbox.
// See src/server/public-inquiry.ts for the shared implementation.
export async function POST(req: Request) {
  return handlePublicInquiryPost(req, {
    source: "BUSINESS_FLIGHTS_WEBSITE",
    rateLimitEndpoint: "CONTACT_INQUIRY",
    rateLimit: RATE_LIMITS.CONTACT_INQUIRY,
  });
}
