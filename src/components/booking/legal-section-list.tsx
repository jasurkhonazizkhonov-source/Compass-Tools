import type { LegalSection } from "@/lib/legal-content";

/**
 * Pure content renderer for a list of legal sections (numbered headings,
 * paragraphs, bullet lists, indented subsections). No accordion, no state —
 * shared by the booking-form legal accordion (legal-agreement-accordion.tsx)
 * and the cancellation-flow read-only Cancellation Policy accordion, so the
 * two never drift into differently-formatted copies of the same content.
 */
export function LegalSectionList({ sections, headingLevel = 3 }: { sections: LegalSection[]; headingLevel?: 3 | 4 }) {
  const HeadingTag = headingLevel === 3 ? "h3" : "h4";
  // Subsections nest one level deeper than the top-level heading above —
  // never fixed at h4 regardless of caller, or a caller that already
  // passes headingLevel=4 (nested one level under an accordion trigger's
  // own <h3>) would produce a same-level h4-under-h4 rather than h4->h5.
  const SubHeadingTag = headingLevel === 3 ? "h4" : "h5";
  return (
    <div className="space-y-5 text-sm leading-relaxed text-muted-foreground">
      {sections.map((section, i) => (
        <section key={section.heading} aria-labelledby={`legal-section-${headingLevel}-${i}`}>
          <HeadingTag id={`legal-section-${headingLevel}-${i}`} className="font-semibold text-foreground text-[0.925rem]">
            {i + 1}. {section.heading}
          </HeadingTag>
          {section.paragraphs?.map((p, pi) => (
            <p key={pi} className="mt-1.5">
              {p}
            </p>
          ))}
          {section.list && (
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              {section.list.map((item, li) => (
                <li key={li}>{item}</li>
              ))}
            </ul>
          )}
          {section.subsections?.map((sub, si) => (
            <div key={sub.heading} className="mt-3 pl-3 border-l-2 border-border">
              <SubHeadingTag className="font-medium text-foreground text-sm">
                {i + 1}.{si + 1} {sub.heading}
              </SubHeadingTag>
              {sub.paragraphs?.map((p, pi) => (
                <p key={pi} className="mt-1">
                  {p}
                </p>
              ))}
              {sub.list && (
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {sub.list.map((item, li) => (
                    <li key={li}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
