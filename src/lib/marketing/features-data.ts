import type { LucideIcon } from "lucide-react";
import { Users2, FileText, PlaneTakeoff, Contact2, Mail, Repeat2, BarChart3 } from "lucide-react";

// Single source of truth for the /features overview page and every
// /features/[slug] detail page — one typed data array instead of seven
// near-duplicate page files. Every capability listed here maps to a real,
// existing part of the Compass Tools CRM (verified against the actual
// implementation before writing this copy) — nothing here is aspirational
// or planned-but-unbuilt.
export type MarketingFeature = {
  slug: string;
  navLabel: string;
  headline: string;
  summary: string;
  description: string;
  icon: LucideIcon;
  bullets: string[];
};

export const MARKETING_FEATURES: MarketingFeature[] = [
  {
    slug: "leads",
    navLabel: "Lead Management",
    headline: "Every inquiry, tracked from first contact to first quote",
    summary: "Capture leads from your website or enter them manually, then route them to the right agent automatically.",
    description:
      "New flight requests from your website arrive in the CRM automatically and enter a fair distribution queue, so the next available agent gets the next lead — no manual assignment, no leads sitting untouched. Agents can pause and resume accepting leads, and the queue remembers their place. Every lead keeps a full activity timeline: status changes, notes, tasks, and every quote built from it.",
    icon: Users2,
    bullets: [
      "Automatic distribution to available agents, in fair rotation",
      "Website flight requests flow in without manual data entry",
      "Full activity history — notes, tasks, and status changes in one timeline",
      "Reassign a lead and its quotes follow the new owner automatically",
    ],
  },
  {
    slug: "quotes",
    navLabel: "Quote & Itinerary Management",
    headline: "Build a professional fare quote in minutes",
    summary: "Paste a GDS itinerary or build one manually, then send a branded quote your customer can act on immediately.",
    description:
      "The itinerary builder understands real GDS output, so agents can paste a fare and have flights, aircraft, and airline details fill in automatically. Every quote sent to a customer includes your company's own branding and a secure link — no CRM login required on their end — where they can review the itinerary and continue straight to booking.",
    icon: FileText,
    bullets: [
      "Parses pasted GDS itineraries into structured flight segments",
      "Airline logos and aircraft details shown automatically where available",
      "Branded, secure customer-facing quote pages — no login needed",
      "Quote status updates automatically as a customer views and acts on it",
    ],
  },
  {
    slug: "customer-management",
    navLabel: "Customer Management",
    headline: "One record per customer, not one per trip",
    summary: "Contacts hold every phone number, email address, lead, quote, and booking a customer has ever had with you.",
    description:
      "Repeat customers are matched automatically by phone or email, so a returning traveler's new inquiry lands on their existing contact record instead of starting from scratch. Contact ownership is separate from any one lead, so reassigning a customer to a different agent carries their full history — and any open quotes — with them correctly.",
    icon: Contact2,
    bullets: [
      "Automatic duplicate matching by phone or email",
      "Full history of leads, quotes, and bookings on one record",
      "Bulk import for onboarding an existing customer list",
      "Ownership and reassignment rules that keep history intact",
    ],
  },
  {
    slug: "bookings",
    navLabel: "Booking Management",
    headline: "From signed quote to ticketed booking",
    summary: "Track a booking's status accurately from the moment a customer signs through ticketing and confirmation.",
    description:
      "Once a customer completes a secure booking form, the record moves through the same statuses your team already tracks manually — Signed, Booked, Charged — automatically as your team updates ticketing status. Airline confirmation numbers are sent to the customer only when your team explicitly does so, never automatically, keeping communication accurate and intentional.",
    icon: PlaneTakeoff,
    bullets: [
      "Secure customer-facing booking and signature flow",
      "Status automation tied to real ticketing events",
      "Manual, deliberate airline confirmation emails — never automatic",
      "Full record of foreign-currency pricing alongside internal reporting",
    ],
  },
  {
    slug: "email",
    navLabel: "Email Communication",
    headline: "Send from your own inbox, logged where your team can see it",
    summary: "Connect your Gmail account and send quotes, confirmations, and updates without leaving the CRM.",
    description:
      "Agents connect their own Gmail account once, then send quote emails, booking confirmations, and customer replies directly from the CRM — every email sent from the agent's own address, with your company's logo and signature applied automatically. Every send is logged against the relevant lead, contact, or booking.",
    icon: Mail,
    bullets: [
      "Send as yourself — every email comes from the agent's own connected Gmail",
      "Company logo and signature applied automatically",
      "Every send logged against the right customer record",
      "Support for multiple customer email addresses per contact",
    ],
  },
  {
    slug: "sequences",
    navLabel: "Automated Follow-Up",
    headline: "Consistent follow-up, without a manual reminder for every lead",
    summary: "Enroll leads in a multi-step email sequence and let scheduled follow-ups send automatically.",
    description:
      "Build a sequence of timed follow-up emails once, then enroll individual leads or apply it in bulk. Sequences respect unsubscribe requests automatically and stop cleanly once a lead responds or converts, so customers never receive follow-up messages that no longer make sense.",
    icon: Repeat2,
    bullets: [
      "Multi-step, time-delayed email sequences",
      "Enroll leads individually or in bulk",
      "Automatic unsubscribe handling",
      "Visibility into every enrollment's current step and status",
    ],
  },
  {
    slug: "analytics",
    navLabel: "Sales Visibility",
    headline: "See performance across the team, in your own currency",
    summary: "A sales board and commission view keep everyone aligned on what's actually closing.",
    description:
      "Admins and managers get a real-time view of leads, quotes, and bookings across the whole team, plus a commission and sales board scoped to the roles allowed to see it. Internal profit and commission figures are always tracked in a single reporting currency, kept clearly separate from the original currency shown to customers.",
    icon: BarChart3,
    bullets: [
      "Team-wide sales board with role-based visibility",
      "Commission tracking kept in one consistent reporting currency",
      "Dashboard overview of lead volume, status, and trends",
      "Historical data preserved even as team assignments change",
    ],
  },
];

export function getFeatureBySlug(slug: string): MarketingFeature | undefined {
  return MARKETING_FEATURES.find((f) => f.slug === slug);
}
