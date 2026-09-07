import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getQuoteDetail } from "@/server/queries/quotes";
import { getCurrentAccount } from "@/lib/dev-session";
import { ExchangeBuilder } from "@/components/quotes/exchange-builder";
import { isExchangeProposalRevisable } from "@/lib/exchange-proposal";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Exchange itinerary workflow entry point — reached either from the
 * "Exchange" button on a charged quote's own detail page (the first-ever
 * proposal against it), or from the "New Exchange Proposal" button on an
 * existing, still-unsigned proposal's own detail page (`supersedesQuoteId`
 * set — Pass 26 versioning). Re-derives everything from the ORIGINAL quote
 * (and, for a revision, the proposal being revised) server-side — never
 * trusts anything from the client beyond which quote ids to start from —
 * and, same as the buttons that link here, is only reachable for a quote
 * that's genuinely eligible right now; a direct URL visit for an
 * ineligible quote is turned away with a clear message rather than
 * silently rendering a broken/incorrect exchange form. The actual
 * authorization boundary is sendExchangeForApproval's own server-side
 * re-check — this page's checks are the same UX nicety every other
 * eligibility check in this app already is.
 */
export default async function NewExchangePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const originalQuoteId = typeof sp.originalQuoteId === "string" ? sp.originalQuoteId : undefined;
  const supersedesQuoteId = typeof sp.supersedesQuoteId === "string" ? sp.supersedesQuoteId : undefined;
  if (!originalQuoteId) notFound();

  const actor = await getCurrentAccount();
  const viewer = actor ? { id: actor.id, role: actor.role, companyId: actor.companyId } : null;
  const original = await getQuoteDetail(originalQuoteId, viewer);
  if (!original) notFound();

  const supersedes = supersedesQuoteId ? await getQuoteDetail(supersedesQuoteId, viewer) : null;
  if (supersedesQuoteId && !supersedes) notFound();

  const eligible = supersedes
    ? supersedes.originalQuoteId === original.id && supersedes.isCurrentExchangeProposal && isExchangeProposalRevisable(supersedes.status)
    : original.status === "CHARGED";

  if (!eligible) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center space-y-3">
        <h1 className="text-lg font-semibold">{supersedes ? "This proposal can no longer be revised" : "This quote isn't eligible for exchange"}</h1>
        <p className="text-sm text-muted-foreground">
          {supersedes
            ? `${supersedes.quoteNumber} is currently ${supersedes.status.replace(/_/g, " ").toLowerCase()} — it may have already been superseded, reviewed, or signed.`
            : `Only a charged quote can be exchanged. ${original.quoteNumber} is currently ${original.status.replace(/_/g, " ").toLowerCase()}.`}
        </p>
        <Link href={`/quotes/${supersedes?.id ?? original.id}`} className="text-sm text-primary hover:underline inline-flex items-center gap-1">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to quote
        </Link>
      </div>
    );
  }

  // Reference itinerary shown read-only alongside the editable form: for a
  // revision, the PREVIOUS proposal (what's actually being replaced) is far
  // more useful context than the pre-exchange original; for the first-ever
  // proposal, it's the true original — unchanged existing behavior.
  const referenceQuote = supersedes ?? original;
  const referenceSegments = referenceQuote.itinerary?.segments ?? [];
  const tripType = referenceQuote.itinerary?.tripType ?? "ONE_WAY";

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/quotes/${referenceQuote.id}`} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Quote
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{supersedes ? "New Exchange Proposal" : "Propose Exchange"}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          For {original.contact.firstName} {original.contact.lastName} · Original quote {original.quoteNumber}
          {supersedes && <> · Replacing proposal {supersedes.quoteNumber}</>}
        </p>
      </div>

      <ExchangeBuilder
        originalQuoteId={original.id}
        originalQuoteNumber={referenceQuote.quoteNumber}
        originalSegments={referenceSegments}
        supersedesQuoteId={supersedes?.id}
        defaultTripType={tripType}
        defaultCabin={referenceSegments[0]?.cabin as "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST" | undefined ?? "ECONOMY"}
        defaultAdults={referenceQuote.adults}
        defaultChildren={referenceQuote.children}
        defaultInfants={referenceQuote.infants}
      />
    </div>
  );
}
