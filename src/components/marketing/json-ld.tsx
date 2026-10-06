import { serializeJsonLd } from "@/lib/marketing/seo";

/** Renders one schema.org JSON-LD block. Server component; data must come from lib/marketing/seo.ts builders (public facts only). */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
