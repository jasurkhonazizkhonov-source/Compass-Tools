import { ImageResponse } from "next/og";

// Next.js App Router's dynamic-icon convention — generates the browser-tab
// favicon (and its <link rel="icon"> tags) at build/request time from JSX,
// so no external image tool or binary asset is needed. This is the CRM
// PRODUCT's icon only — completely separate from a travel agency's own
// uploaded logo (see src/server/queries/company.ts), which is untouched
// by this change.
//
// Pass 37 — same "bearing needle" mark as compass-mark.tsx (kept in sync
// deliberately — see that file's own comment for the full design
// rationale and the exact geometry constants), on a navy badge rather than
// the white one every in-app call site uses, since a browser tab has no
// control over its own surrounding chrome. Sized to nearly fill the 32×32
// canvas for maximum legibility at real favicon size.
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
          <polygon points="8.75,3.07 7.77,13.54 15.25,20.93" fill="white" />
          <polygon points="8.75,3.07 16.23,10.46 15.25,20.93" fill={GOLD} />
          <circle cx="12" cy="12" r="1.4" fill="#1c3a5e" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
