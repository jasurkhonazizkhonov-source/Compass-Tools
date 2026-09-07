// The Compass Tools CRM's own icon mark — deliberately separate from
// customer/company branding (src/server/queries/company.ts's
// resolveBranding, the uploadable logo, FALLBACK_LOGO_PATH, etc.), which
// stays completely untouched by this file. This is only ever the CRM
// PRODUCT's own identity: sidebar, login screen, browser tab icon — never
// a travel agency's own branding.
//
// Pass 13 §2 — redesigned from the prior ring+two-triangle-needle mark
// (still visible in git history) to a genuinely different form, not a
// scaled-up copy of it: an open "C" arc (290° of a full ring, drawn via
// stroke-dasharray/stroke-dashoffset on a plain <circle> rather than a
// hand-computed path — simpler to reason about and guaranteed round) with
// a single gold accent dot sitting in the gap, at the 3-o'clock/"forward"
// position. Reads as both "C for Compass" and a route/position marker —
// deliberately not a literal compass needle (the prior version, and the
// exact generic-icon look this pass's own spec calls out to avoid) and not
// a generic abstract SaaS mark. The stroke is bolder (2.2 vs the previous
// 1.4) and the ring sized close to the viewBox edge (r=10 in a 24×24 box)
// specifically to address the "too small / every unused pixel hurts
// legibility" complaint through real visual WEIGHT, not just a larger
// container at the call site (both are also done — see sidebar.tsx).
//
// Colors: the CRM's brand navy (#1c3a5e — the same value already used as
// FALLBACK_BRAND_COLOR in src/lib/company-config.ts, so the product's own
// mark and a travel agency's default brand color read as one family) and a
// warm gold accent, unchanged from the prior version. currentColor is
// intentionally NOT used — the two-tone treatment is the mark's identity
// and must survive on both light and dark surfaces, not invert with the
// surrounding text color. Safe to hardcode against a light backdrop
// specifically because every call site places this inside its own
// near-white badge (bg-white/95) rather than directly on an arbitrary page
// background — see sidebar.tsx/login/page.tsx. The favicon/apple-icon
// routes (icon.tsx/apple-icon.tsx) render the same geometry inverted
// (white ring on a navy badge) since a browser tab has no such badge to
// sit inside — kept in sync deliberately, not by shared code (Next's
// dynamic-icon routes can't import a React DOM component), so any future
// geometry change must be mirrored in all three files.
const NAVY = "#1c3a5e";
const GOLD = "#d4a24e";

// One 290°-open ring: circumference of r=10 is 2πr ≈ 62.8. A 70°-wide gap
// is 62.8 × 70/360 ≈ 12.2 of arc length, leaving ≈50.6 for the visible
// dash. dashoffset centers that gap at the circle's own start point
// (3 o'clock, angle 0°) — see this file's own header comment for the
// full derivation. Shared as constants so compass-mark.tsx/icon.tsx/
// apple-icon.tsx can never silently drift out of sync with each other.
export const COMPASS_RING_RADIUS = 10;
export const COMPASS_RING_DASHARRAY = "50.6 12.2";
export const COMPASS_RING_DASHOFFSET = 56.7;

export function CompassMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Compass Tools">
      <circle
        cx="12"
        cy="12"
        r={COMPASS_RING_RADIUS}
        stroke={NAVY}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray={COMPASS_RING_DASHARRAY}
        strokeDashoffset={COMPASS_RING_DASHOFFSET}
      />
      <circle cx="21.7" cy="12" r="1.8" fill={GOLD} />
    </svg>
  );
}
