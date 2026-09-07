// Cancellation Policy / Terms & Conditions content shown to the customer
// on the booking form (booking-flow.tsx) and, for the Cancellation Policy
// alone, on the cancellation confirmation page. Adapted from the business-
// provided template — every company reference is a real, already-
// configured value (Company.name/phone/website — see prisma/schema.prisma
// and ResolvedCompanyBranding), never a hardcoded or invented legal
// entity name. There is no dedicated "support email" field on Company
// today (confirmed against the actual schema before writing this), so
// this deliberately points the customer to the phone/website already on
// file rather than fabricating an email address that doesn't exist in
// the system.
//
// Structured as plain data (heading/paragraphs/list per section) rather
// than hand-written JSX so both accordions render through ONE shared
// component (legal-agreement.tsx) with consistent typography, spacing,
// and numbering — adding or editing a clause never means touching markup.

// Pass 24 — a stable identifier for the ACTUAL LEGAL TEXT below, not the
// app/deployment version. Bump this (to a new date, or `-v2`/`-v3` if
// revised more than once on the same day) any time the wording in
// getCancellationPolicySections/getTermsAndConditionsSections materially
// changes, so Booking.termsVersion (set at signing time — see
// submitBooking in server/actions/booking.ts) can later answer "which
// version of the policy did this specific customer actually see and
// accept" if the text is ever revised. Never touch historical bookings'
// stored termsVersion when bumping this — see the schema comment on
// Booking.termsVersion for why.
export const LEGAL_CONTENT_VERSION = "2026-09-05-v1";

export type LegalCompanyInfo = {
  name: string;
  phone: string | null;
  website: string | null;
};

export type LegalListItem = string;

export type LegalSubsection = {
  heading: string;
  paragraphs?: string[];
  list?: LegalListItem[];
};

export type LegalSection = {
  heading: string;
  paragraphs?: string[];
  list?: LegalListItem[];
  subsections?: LegalSubsection[];
};

/** "our support team" when no phone/website is configured, or a concrete,
 * real channel when one is — never an invented email address. */
function contactChannel(company: LegalCompanyInfo): string {
  const channels = [company.phone, company.website].filter((v): v is string => !!v);
  if (channels.length === 0) return "your travel agent";
  return channels.join(" or ");
}

export function getCancellationPolicySections(company: LegalCompanyInfo): LegalSection[] {
  const contact = contactChannel(company);
  return [
    {
      heading: "Standard Ticket Cancellation and Refunds",
      paragraphs: [
        `Before requesting a cancellation, please contact ${company.name} at ${contact} to review the options available for your specific booking. Airline and travel-provider rules — not ${company.name}'s own policy — ultimately govern whether a ticket can be refunded, exchanged, or changed, and those rules vary by fare type, route, and airline.`,
      ],
      list: [
        "Airline fare rules may limit or entirely prohibit refunds, depending on the fare class purchased.",
        "Name changes are generally not permitted. Only the passenger named on the original ticket may use it.",
        "Airline tickets and any associated service fees may be non-refundable, even when the flight itself is cancelled or changed by the airline.",
        "Where fare rules allow changes, they are generally permitted up to 48 hours before scheduled departure.",
        "Cancellation or refund requests should generally be submitted up to 72 hours before departure where the fare allows it — later requests may not be honored by the airline.",
        `Where airline rules permit a refund or exchange, ${company.name} charges a processing fee of $250 per passenger, minimum, in addition to any airline or provider fees the fare rules require.`,
        "Fees vary by airline and provider and are not set or capped by this policy — they are determined by the applicable fare rules at the time of cancellation.",
        "Depending on fare rules, a cancellation may result in a future travel credit rather than a monetary refund.",
        "Where issued, future travel credits are generally valid for up to 12 months from the original purchase date, subject to the issuing airline's own rules.",
        "No-show tickets — where the passenger does not travel and does not cancel in advance — are generally non-refundable and non-exchangeable.",
        "Tickets must be used in the sequence issued. Skipping a segment, using only part of an itinerary out of order, or \"hidden-city\" ticketing is prohibited by airline rules.",
        "Where a fare is explicitly marked non-refundable or non-changeable at the time of purchase, that condition controls regardless of the general guidance above.",
        "Unused portions of a multi-segment itinerary may be forfeited once an earlier segment has been used or missed.",
      ],
    },
    {
      heading: "Airline Rules, Itinerary Changes, and Price Changes",
      paragraphs: [
        `${company.name} acts as a travel agent and intermediary between you and the airline(s) operating your itinerary; airline logos shown during booking are for informational identification only. Air transportation itself is governed by each operating airline's own Conditions of Carriage, not by ${company.name}.`,
        "Airlines may change flight schedules or cancel flights at their own discretion, which can affect your itinerary after booking.",
        `If a disruption occurs at the airport — a delay, cancellation, or gate change — please speak with the airline's own ticketing or gate agents first, since they control real-time rebooking and re-accommodation. ${company.name} is not responsible for an airline's own operational decisions, but is available to help beyond that point.`,
        `If you believe an airline is not honoring a validly ticketed reservation, contact ${company.name} promptly at ${contact} so we can assist.`,
      ],
    },
    {
      heading: "Additional Terms",
      subsections: [
        {
          heading: "Frequent Traveler Points",
          paragraphs: [
            "Miles, points, upgrade certificates, vouchers, and other promotional incentives may or may not apply to a given booking, depending on the fare class, airline, and how the ticket was issued. Eligibility is determined solely by the operating airline's own program rules.",
          ],
        },
        {
          heading: "Frequent Flyer Accounts",
          paragraphs: [
            `Where you provide a frequent flyer number for a flight, ${company.name} will include it on the reservation on a best-efforts basis so the operating airline can apply it, subject to that airline's own rules and your authorization to use the number. Whether miles, status credit, or benefits are actually credited is determined entirely by the airline's frequent flyer program, not by ${company.name}.`,
          ],
        },
        {
          heading: "Passport, Visa, and Travel Documents",
          paragraphs: [
            "A valid passport is required for international travel. Visa requirements vary by destination, nationality, and itinerary, and may apply even for a connection or layover (transit visa).",
            "Some destinations also require proof of vaccination or other health documentation before entry.",
          ],
          list: [
            "You are responsible for confirming passport, visa, transit, and health-document requirements for every country on your itinerary, including connections.",
            "Requirements can change with little notice — always verify current requirements directly with the destination's embassy, consulate, or official government travel-advisory resources before departure.",
            "Schengen-area transit requirements may apply even for a short connection within Europe.",
          ],
        },
      ],
    },
  ];
}

export function getTermsAndConditionsSections(company: LegalCompanyInfo): LegalSection[] {
  const contact = contactChannel(company);
  return [
    {
      heading: "Review Your Confirmation",
      paragraphs: [
        `Please review your booking confirmation carefully as soon as you receive it — names, dates, times, routing, and cabin. Contact ${company.name} at ${contact} immediately if you find any discrepancy, since airline rules make some corrections difficult or costly once travel is closer.`,
      ],
    },
    {
      heading: "Responsibility",
      paragraphs: [
        `${company.name} acts as an agent and intermediary arranging travel on your behalf with independent airlines and other travel suppliers. Except for its own service obligations to you, ${company.name} is not responsible for the acts, omissions, or operational decisions of any airline or supplier, including events outside anyone's reasonable control, such as:`,
      ],
      list: [
        "Flight delays or cancellations",
        "Mechanical issues",
        "Weather",
        "Government actions or restrictions",
        "Labor disputes or strikes",
        "Pandemics or public health emergencies",
        "Natural disasters",
        "Acts of terrorism",
        "Airline or supplier bankruptcy or default",
      ],
    },
    {
      heading: "Foreign Entry Requirements",
      paragraphs: [
        "International travel may require a valid passport, visa, proof of vaccination, or other health or transit documentation, depending on your destination, nationality, and routing.",
        "You are responsible for confirming these requirements before travel. Consult the destination's embassy, consulate, or an official government travel-advisory resource for authoritative, up-to-date requirements — including current safety and health guidance for your destination — rather than relying solely on this summary.",
      ],
    },
    {
      heading: "Credit Card Payments",
      list: [
        "You confirm that you are the cardholder, or are authorized by the cardholder, to use the payment card provided.",
        "A reservation is not guaranteed until the ticket is actually issued by the airline, even after payment information has been submitted.",
        "Payment and identity verification may be performed before a booking is confirmed or ticketed.",
        "Transactions flagged as higher-risk may require additional validation before processing.",
        "Standard fraud-prevention measures may apply to any transaction.",
        "A declined card does not automatically complete or hold a booking.",
      ],
    },
    {
      heading: "Credit Card Fees & Foreign Transactions",
      paragraphs: [
        "If your card is issued in a different currency than the booking's transaction currency, your bank — not " + company.name + " — determines the exchange rate applied and may charge a foreign-transaction or currency-conversion fee.",
        "As a result, the amount shown on your card statement may differ from the price displayed at booking. Where your itinerary is priced in a currency other than your own, that currency is always clearly identified at booking and on your confirmation — amounts are never silently converted or displayed without their currency.",
      ],
    },
    {
      heading: "Chargebacks",
      paragraphs: [
        `If you believe a charge was made in error, please contact ${company.name} at ${contact} first so we can review and resolve it directly — this is almost always faster than a card dispute.`,
      ],
      list: [
        "An improperly filed chargeback for services that were actually rendered may be formally disputed with supporting documentation.",
        "Where legally permitted, a booking associated with a fraudulent or improper chargeback may be cancelled.",
        "Services already used (e.g., a flown flight segment) generally do not qualify for a valid chargeback.",
        `${company.name} reserves all rights available under applicable law in connection with a disputed charge.`,
      ],
    },
    {
      heading: "Airline Schedule Changes & Delays",
      paragraphs: [
        "Airlines change flight schedules regularly, sometimes with limited notice — please re-check your flight times as your travel date approaches, not only at the time of booking.",
        "Travel insurance is strongly recommended to help protect against delays, cancellations, and other travel disruptions.",
      ],
      list: [
        `If a cancellation or disruption happens at the airport, speak with the airline's own ticketing or gate agents first — they control real-time re-accommodation. Contact ${company.name}'s ticketing support promptly if further assistance is needed.`,
      ],
    },
    {
      heading: "Baggage Allowance",
      paragraphs: [
        "Baggage allowances, sizing, weight limits, and fees are set entirely by the operating airline(s) and may vary by fare class, route, and frequent flyer status. Always confirm your specific allowance directly with the operating airline before travel.",
      ],
    },
    {
      heading: "Frequent Traveler Benefits",
      paragraphs: [
        "Miles, points, upgrades, and other promotional incentives may or may not apply to your booking. Eligibility is determined entirely by the relevant airline's own program rules, not by " + company.name + ".",
      ],
    },
    {
      heading: "Frequent Flyer Account Assistance",
      paragraphs: [
        `Where you provide a frequent flyer number, ${company.name} will include it on your reservation on a best-efforts basis, subject to the operating airline's own rules and your authorization. Whether the airline actually credits miles or benefits is determined solely by that airline's program.`,
      ],
    },
    {
      heading: "Cancellations & Refunds",
      paragraphs: [
        `Cancellations, changes, and refunds are governed by the applicable airline fare rules together with ${company.name}'s Cancellation Policy (see the Cancellation Policy section above) — please refer there for the applicable fees, timing, and credit terms rather than this section, so the two never state conflicting rules.`,
      ],
    },
    {
      heading: "No Name Changes",
      paragraphs: [
        "Airline tickets generally cannot be transferred to another person. Only the passenger named at the time of ticketing may travel on that ticket.",
      ],
    },
    {
      heading: "Fraudulent or Improper Booking Practices",
      paragraphs: [
        "The following practices violate airline conditions of carriage and are prohibited on any itinerary booked through " + company.name + ":",
      ],
      list: [
        "Hidden-city ticketing (booking a longer itinerary intending to disembark at a connection rather than the ticketed destination)",
        "Back-to-back ticketing used to circumvent fare rules",
        "Speculative bookings with no genuine intent to travel",
        "Fraudulent reservations, including use of unauthorized payment methods",
        "Skipping a booked segment out of sequence",
      ],
    },
    {
      heading: "Taxes & Fees",
      paragraphs: [
        "Displayed prices include the applicable fare, taxes, and fees that are represented as part of the total shown at the time of booking, in the currency shown. Depending on how a booking is structured, certain supplier-specific amounts may be processed separately by that supplier rather than by " + company.name + " directly — this does not change the total price you were quoted and agreed to.",
      ],
    },
    {
      heading: "Indemnification",
      paragraphs: [
        `To the fullest extent permitted by law, you agree to indemnify and hold ${company.name}, its owners, employees, and agents harmless from any claim, loss, or expense arising from:`,
      ],
      list: [
        "Your breach of these Terms & Conditions",
        "Information you provided that was inaccurate or incomplete",
        "Your failure to obtain required travel documents (passport, visa, health, or transit documentation)",
        "Your use of the booking for a purpose prohibited under Fraudulent or Improper Booking Practices above",
      ],
    },
  ];
}
