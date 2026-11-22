"use server";

// The Server Actions of the lead queue: ONLY what a signed-in person's browser may call - join / leave the queue, read their own offer, accept or skip it. Each one is a thin
// delegate to src/server/actions/lead-queue.ts, which re-checks the signed-in account itself on every call.
//
// Why a separate file: every async export of a "use server" file is a publicly callable endpoint. lead-queue.ts also holds the distribution engine
// (distributeNewWebsiteLead / distributePendingWebsiteLeads), which trusts its caller because its legitimate callers have no signed-in user at all (the cron route, the website
// lead intake, the post-response pickup). That engine therefore lives in a plain server module, exactly as the due-task and due-sequence sweeps do (see due-work-authorization.test.ts
// and use-server-exports.test.ts), and ONLY the five functions below are registered as actions.
import { acceptLeadOffer as acceptImpl, getMyLeadOffer as getOfferImpl, joinLeadQueue as joinImpl, leaveLeadQueue as leaveImpl, skipLeadOffer as skipImpl } from "@/server/actions/lead-queue";

export async function joinLeadQueue() {
  return joinImpl();
}

export async function leaveLeadQueue() {
  return leaveImpl();
}

export async function getMyLeadOffer() {
  return getOfferImpl();
}

export async function acceptLeadOffer(leadId: string) {
  return acceptImpl(leadId);
}

export async function skipLeadOffer(leadId: string) {
  return skipImpl(leadId);
}
