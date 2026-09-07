"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PassengerForm, type PassengerFormState } from "@/components/booking/passenger-form";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { LegalSectionList } from "@/components/booking/legal-section-list";
import { getCancellationPolicySections, type LegalCompanyInfo } from "@/lib/legal-content";
import { confirmCancellationByCustomer } from "@/server/actions/cancellation";

export type PrefillPassenger = {
  id: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  type: "ADULT" | "CHILD" | "INFANT";
  dateOfBirth: Date | null;
  gender: string | null;
  tsaKnownTravelerNumber: string | null;
  globalEntryNumber: string | null;
};

function toFormState(p: PrefillPassenger): PassengerFormState {
  return {
    clientId: p.id,
    type: p.type,
    firstName: p.firstName,
    middleName: p.middleName ?? "",
    lastName: p.lastName,
    dateOfBirth: p.dateOfBirth ? p.dateOfBirth.toISOString().slice(0, 10) : "",
    gender: p.gender ?? "",
    tsaKnownTravelerNumber: p.tsaKnownTravelerNumber ?? "",
    globalEntryNumber: p.globalEntryNumber ?? "",
    // Not prefilled (frequent-flyer info isn't part of this pass's
    // prefill scope — see the final report) — still fully editable like
    // every other field, just starts blank.
    frequentFlyerAirline: null,
    frequentFlyerNumber: "",
  };
}

/**
 * Pass 13 §32-§35 — the customer's cancellation-signing step, resembling
 * the existing booking form's passenger-information UX (same PassengerForm
 * component, same field set) rather than a bare confirm button with no
 * passenger visibility at all. Prefilled from this quote's own already-
 * booked passengers (§33 — "the last charged quote/booking", which for a
 * cancellation IS this exact quote, already booked) but never locked —
 * every field stays a normal editable input (§34). The final signed
 * confirmation uses exactly what the customer submits here, not the
 * original prefilled values (see confirmCancellationByCustomer's own
 * persistence of the submitted passenger data).
 */
export function CancellationConfirmPanel({
  token,
  initialPassengers,
  company,
}: {
  token: string;
  initialPassengers: PrefillPassenger[];
  /** Real, already-configured Company fields — never invented placeholder
   * contact info — used to show the Cancellation Policy the customer is
   * about to act on below. Read-only here: clicking "Confirm Cancellation"
   * is itself the acknowledgement, so this deliberately adds no second
   * checkbox (that would be a duplicate agreement — see legal-content.ts's
   * module comment and the booking form's own Cancellation Policy +
   * Terms & Conditions accordion, which already carries the one checkbox
   * this booking's original terms agreement requires). Optional so any
   * existing test/story that doesn't pass it keeps working — the section
   * simply doesn't render without it.
   */
  company?: LegalCompanyInfo;
}) {
  const [passengers, setPassengers] = useState<PassengerFormState[]>(() => initialPassengers.map(toFormState));
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function updatePassenger(clientId: string, next: PassengerFormState) {
    setPassengers((prev) => prev.map((p) => (p.clientId === clientId ? next : p)));
  }

  function handleConfirm() {
    startTransition(async () => {
      try {
        await confirmCancellationByCustomer(
          token,
          passengers.map((p) => ({
            id: p.clientId,
            firstName: p.firstName,
            middleName: p.middleName || undefined,
            lastName: p.lastName,
            dateOfBirth: p.dateOfBirth || undefined,
            gender: p.gender || undefined,
            tsaKnownTravelerNumber: p.tsaKnownTravelerNumber || undefined,
            globalEntryNumber: p.globalEntryNumber || undefined,
          }))
        );
        toast.success("Cancellation confirmed");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not confirm the cancellation — please try again or contact your agent");
      }
    });
  }

  return (
    <div className="space-y-4">
      {passengers.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Passenger Information</h3>
          <p className="text-xs text-muted-foreground">
            Please review the information below and make any needed corrections before confirming.
          </p>
          {passengers.map((p, i) => (
            <PassengerForm key={p.clientId} passenger={p} index={i} onChange={(next) => updatePassenger(p.clientId, next)} />
          ))}
        </div>
      )}
      {company && (
        <Accordion type="single" collapsible className="w-full border rounded-md px-3">
          <AccordionItem value="cancellation-policy" className="border-b-0">
            <AccordionTrigger className="text-sm font-medium">Cancellation Policy</AccordionTrigger>
            <AccordionContent>
              <div className="max-h-72 overflow-y-auto pr-2">
                <LegalSectionList sections={getCancellationPolicySections(company)} headingLevel={4} />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
      <Button size="lg" className="w-full gap-2" onClick={handleConfirm} disabled={isPending}>
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
        Confirm Cancellation
      </Button>
    </div>
  );
}
