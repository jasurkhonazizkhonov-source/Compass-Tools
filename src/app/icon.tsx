import { ImageResponse } from "next/og";

// Next.js App Router's dynamic-icon convention — generates the browser-tab
// favicon (and its <link rel="icon"> tags) at build/request time from JSX,
// so no external image tool or binary asset is needed. This is the CRM
// PRODUCT's icon only — completely separate from a travel agency's own
// uploaded logo (see src/server/queries/company.ts), which is untouched
// by this change.
//
// Pass 13 §2 — same open-ring + gold-dot mark as compass-mark.tsx (kept in
// sync deliberately — see that file's own comment for the full design
// rationale and the exact geometry derivation), on a navy badge rather
// than the white one every in-app call site uses, since a browser tab has
// no control over its own surrounding chrome. The ring here is white
// rather than navy (navy would vanish against the navy badge) — the
// "compact mark for a small canvas" variant the badge context specifically
// calls for, sized to nearly fill the 32×32 canvas for maximum legibility
// at real favicon size.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

const GOLD = "#d4a24e";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1c3a5e",
          borderRadius: 7,
        }}
      >
        <svg width="29" height="29" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="50.6 12.2" strokeDashoffset="56.7" />
          <circle cx="21.7" cy="12" r="1.8" fill={GOLD} />
        </svg>
      </div>
    ),
    { ...size }
  );
}
