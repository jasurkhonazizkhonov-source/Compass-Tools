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
    // The Business Flights website's SERVER posts here for the visitor: this connection is that server, not the visitor. Only a verified signed
    // visitor context (x-ct-visitor-context/-signature, LEAD_INGEST_SECRET) may supply the visitor's IP/location; without one nothing is recorded.
    serverToServer: true,
    // Idempotent contact submissions: the website sends a per-submission key (`submissionId`). A repeat of the same message (double click, retry after
    // a timeout, a lost answer) lands on the same row and is answered `{ ok: true, duplicate: true }`; a website that sends no key behaves as before.
    // Only a keyed submission takes the idempotent path; a submission without a key is stored exactly as before (no content-based de-duplication).
    acceptSubmissionId: true,
  });
}
