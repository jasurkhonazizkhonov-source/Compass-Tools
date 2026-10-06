import { renderBrandCard } from "@/lib/marketing/og-card";

// The Open Graph / Twitter card image for every public page, at a stable URL (a file-convention opengraph-image is dropped by any page
// that declares its own `openGraph`, which every public page does). Generated from the product's own mark — see lib/marketing/og-card.tsx.
export const dynamic = "force-static";

export function GET() {
  return renderBrandCard();
}
