import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { QuoteBuilder } from "@/components/quotes/quote-builder";
import { getCurrentAccount } from "@/lib/dev-session";
import { leadAccessForQuoting } from "@/server/visibility";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function NewQuotePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const leadId = typeof sp.leadId === "string" ? sp.leadId : undefined;
  if (!leadId) notFound();

  const actor = await getCurrentAccount();
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...leadAccessForQuoting(actor) },
    include: { contact: true, departureAirport: true, arrivalAirport: true },
  });
  if (!lead) notFound();

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/leads/${lead.id}`} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Lead
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New Fare Quote</h1>
        <p className="text-sm text-muted-foreground mt-1">
          For {lead.contact.firstName} {lead.contact.lastName} · {lead.departureAirport?.iata ?? "?"} → {lead.arrivalAirport?.iata ?? "?"}
        </p>
      </div>

      <QuoteBuilder
        leadId={lead.id}
        defaultTripType={lead.tripType}
        defaultCabin={lead.cabinClass}
        defaultAdults={lead.adults}
        defaultChildren={lead.children}
        defaultInfants={lead.infants}
      />
    </div>
  );
}
