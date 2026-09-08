// The Compass Tools CRM's own icon mark — deliberately separate from
// customer/company branding (src/server/queries/company.ts's
// resolveBranding, the uploadable logo, FALLBACK_LOGO_PATH, etc.), which
// stays completely untouched by this file. This is only ever the CRM
// PRODUCT's own identity: sidebar, login screen, browser tab icon — never
// a travel agency's own branding.
//
// Pass 37 — completely redesigned, not a variation of the prior open-ring
// "C" arc + dot mark (Pass 13, still visible in git history): a bold,
// asymmetric two-tone "bearing needle" — an elongated kite silhouette,
// tilted off-axis (never perfectly upright — a static vertical diamond
// reads as a generic gem/suit symbol, not an instrument in use), split
// along its long axis into a navy half and a gold half, with a small white
// pivot dot at the exact center where the two halves meet. This is a
// solid, FILLED shape (unlike the previous thin ring stroke) specifically
// for a stronger silhouette at small sizes — the previous design's own
// biggest legibility complaint was thin-stroke weight, not just size.
// Reads as an abstract compass/bearing needle mounted on a pivot —
// deliberately not a literal compass-rose-with-cardinal-letters icon (the
// generic stock-icon look this pass's own spec calls out to avoid) and not
// a static, symmetric diamond.
//
// Colors: the CRM's existing brand navy (#1c3a5e — also FALLBACK_BRAND_COLOR
// in src/lib/company-config.ts, so the product's own mark and a travel
// agency's default brand color stay one family, unchanged from before this
// redesign) and the existing warm gold accent. currentColor is
// intentionally NOT used — the two-tone treatment is the mark's identity
// and must survive on both light and dark surfaces, not invert with
// surrounding text. Safe to hardcode against a light backdrop specifically
// because every call site places this inside its own near-white badge
// (bg-white/95) rather than directly on an arbitrary page background — see
// sidebar.tsx/login/page.tsx. The favicon/apple-icon routes
// (icon.tsx/apple-icon.tsx) render the identical geometry on a navy badge
// instead (a browser tab has no such badge to sit inside) — kept in sync
// deliberately, not by shared code (Next's dynamic-icon routes can't
// import a React DOM component), so any future geometry change must be
// mirrored in all three files.
const NAVY = "#1c3a5e";
const GOLD = "#d4a24e";

// Shared geometry constants — an elongated kite (long axis ~17.9, width
// ~8.5) centered on and rotated -20° around (12,12), split into two
// triangles along its long axis. Exported so icon.tsx/apple-icon.tsx can
// never silently drift out of sync with this file — see this file's own
// header comment for why those two can't just import this component
// directly (Satori/next/og can't render arbitrary React DOM components).
export const COMPASS_NEEDLE_TOP = "8.75,3.07";
export const COMPASS_NEEDLE_LEFT = "7.77,13.54";
export const COMPASS_NEEDLE_RIGHT = "16.23,10.46";
export const COMPASS_NEEDLE_BOTTOM = "15.25,20.93";
export const COMPASS_PIVOT_RADIUS = 1.4;

export function CompassMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Compass Tools">
      <polygon points={`${COMPASS_NEEDLE_TOP} ${COMPASS_NEEDLE_LEFT} ${COMPASS_NEEDLE_BOTTOM}`} fill={NAVY} />
      <polygon points={`${COMPASS_NEEDLE_TOP} ${COMPASS_NEEDLE_RIGHT} ${COMPASS_NEEDLE_BOTTOM}`} fill={GOLD} />
      <circle cx="12" cy="12" r={COMPASS_PIVOT_RADIUS} fill="white" />
    </svg>
  );
}
