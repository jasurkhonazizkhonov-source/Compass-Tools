// Starting points the system itself supplies for a new Marketing campaign.
// Written the way an experienced business-aviation communications team would:
// short, specific, calm, in the second person, with no exclamation marks, no
// urgency theatre and no promotional clichés. Every starter is a draft the
// author completes — the parts they must fill in are marked [[like this]], and
// a campaign that still contains one cannot be sent (hasUnfilledPlaceholders,
// enforced on the server in sendMarketingCampaign). The system never invents
// a fare, a date, a route or a contact detail on the author's behalf.

export type CampaignStarter = {
  id: string;
  label: string;
  description: string;
  subject: string;
  html: string;
};

export const CAMPAIGN_STARTERS: CampaignStarter[] = [
  {
    id: "route-update",
    label: "Route or schedule update",
    description: "Announce a new route, a changed schedule or added capacity.",
    subject: "[[Origin]] to [[Destination]]: now available to arrange",
    html: [
      "<p>Hello,</p>",
      "<p>We now arrange travel between [[Origin]] and [[Destination]], with departures from [[Month]].</p>",
      "<p>Cabins from [[Cabin]] are available, dates can be adjusted to suit your plans, and one advisor looks after your itinerary from first enquiry to arrival.</p>",
      "<p>To discuss options, reply to this email or call [[Phone number]].</p>",
      "<p>Kind regards,<br>[[Sender name]]</p>",
    ].join(""),
  },
  {
    id: "seasonal-note",
    label: "Seasonal travel note",
    description: "A short, useful note ahead of a busy travel period.",
    subject: "Planning your [[Season]] travel",
    html: [
      "<p>Hello,</p>",
      "<p>Availability for [[Season]] is already narrowing on [[Region or route]]. If you are considering travel in that period, arranging it early gives you the widest choice of schedules and cabins.</p>",
      "<h2>What we can arrange</h2>",
      "<ul><li>Flexible itineraries, including multi-city and open-jaw routings</li><li>Business and First cabins on the carriers that suit your route</li><li>Changes and cancellations handled by one named advisor</li></ul>",
      "<p>If you would like a proposal, reply with your intended route and dates and we will respond promptly.</p>",
      "<p>Kind regards,<br>[[Sender name]]</p>",
    ].join(""),
  },
  {
    id: "fare-window",
    label: "Fare opportunity",
    description: "Share a specific fare with its conditions stated plainly.",
    subject: "[[Cabin]] to [[Destination]] from [[Fare]], travel by [[Date]]",
    html: [
      "<p>Hello,</p>",
      "<p>A [[Cabin]] fare to [[Destination]] is available from [[Fare]] for travel completed by [[Date]].</p>",
      "<p>The fare is subject to availability and to the airline's conditions, which we will confirm in writing before you decide. We would be glad to compare it with alternatives for your dates.</p>",
      "<p>To request a quotation, reply to this email or call [[Phone number]].</p>",
      "<p>Kind regards,<br>[[Sender name]]</p>",
    ].join(""),
  },
  {
    id: "client-update",
    label: "Client update",
    description: "Share a service change or news with existing clients.",
    subject: "An update on how we arrange your travel",
    html: [
      "<p>Hello,</p>",
      "<p>[[Describe the change in one or two sentences.]]</p>",
      "<p>For you, this means [[what changes, and what stays the same]]. Nothing is required from you; your existing arrangements are unaffected.</p>",
      "<p>If you have a question, reply to this email and a member of our team will respond.</p>",
      "<p>Kind regards,<br>[[Sender name]]</p>",
    ].join(""),
  },
];

const PLACEHOLDER = /\[\[[^\]]{1,80}\]\]/;

/** True while any [[placeholder]] from a starter is still present. */
export function hasUnfilledPlaceholders(...texts: string[]): boolean {
  return texts.some((t) => PLACEHOLDER.test(t));
}

/** The first unfilled placeholder's label (without the brackets), for an actionable message. */
export function firstUnfilledPlaceholder(...texts: string[]): string | null {
  for (const t of texts) {
    const m = PLACEHOLDER.exec(t);
    if (m) return m[0].slice(2, -2);
  }
  return null;
}
