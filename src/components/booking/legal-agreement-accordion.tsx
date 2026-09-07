import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { LegalSectionList } from "@/components/booking/legal-section-list";
import { getCancellationPolicySections, getTermsAndConditionsSections, type LegalCompanyInfo } from "@/lib/legal-content";

/**
 * The Cancellation Policy + Terms & Conditions accordions shown on the
 * booking form before the signature/submit step. Both panels can be opened
 * independently (type="multiple") without touching any passenger form
 * state elsewhere on the page — this component owns no state of its own
 * beyond Radix's internal open/closed value. The single "I agree" checkbox
 * that gates submission lives in booking-flow.tsx itself (the pre-existing
 * termsAccepted flow, extended rather than duplicated) — this component is
 * content-only.
 */
export function LegalAgreementAccordion({ company }: { company: LegalCompanyInfo }) {
  const cancellationSections = getCancellationPolicySections(company);
  const termsSections = getTermsAndConditionsSections(company);
  return (
    <Accordion type="multiple" className="w-full">
      <AccordionItem value="cancellation-policy">
        <AccordionTrigger className="text-sm font-medium">Cancellation Policy</AccordionTrigger>
        <AccordionContent>
          <div className="max-h-80 overflow-y-auto pr-2">
            {/* headingLevel=4: the accordion trigger above already renders
               as an <h3> (Radix's AccordionHeader default), so each
               section's own heading here must nest one level deeper to
               keep a correct, non-skipping heading hierarchy. */}
            <LegalSectionList sections={cancellationSections} headingLevel={4} />
          </div>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="terms-and-conditions">
        <AccordionTrigger className="text-sm font-medium">Terms &amp; Conditions</AccordionTrigger>
        <AccordionContent>
          <div className="max-h-80 overflow-y-auto pr-2">
            <LegalSectionList sections={termsSections} headingLevel={4} />
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
