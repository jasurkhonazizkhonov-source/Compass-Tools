import { ImageResponse } from "next/og";
import { PRODUCT_NAME } from "@/lib/company-config";
import { OG_SIZE } from "@/lib/marketing/seo";

// The 1200×630 brand card shown when a public Compass Tools page is shared (Open Graph / Twitter). Drawn from the product's own mark
// and colours (compass-mark.tsx / icon.tsx — keep the geometry in sync) so a link preview never shows another business's artwork:
// public/logo.png is the default travel agency's own logo (used for that agency's customer emails), not the product's.
// Text only states what the site itself says: the product name and what it is.

const NAVY = "#1c3a5e";
const GOLD = "#d4a24e";

export function renderBrandCard() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 96px",
          background: NAVY,
          color: "white",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ display: "flex", width: 168, height: 168, alignItems: "center", justifyContent: "center", background: "white", borderRadius: 36 }}>
            <svg width="132" height="132" viewBox="0 0 24 24" fill="none">
              <polygon points="8.75,3.07 7.77,13.54 15.25,20.93" fill={NAVY} />
              <polygon points="8.75,3.07 16.23,10.46 15.25,20.93" fill={GOLD} />
              <circle cx="12" cy="12" r="1.4" fill="white" />
            </svg>
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginLeft: 48 }}>
            <div style={{ display: "flex", fontSize: 96, fontWeight: 700, letterSpacing: -2 }}>{PRODUCT_NAME}</div>
            <div style={{ display: "flex", width: 120, height: 6, background: GOLD, marginTop: 20 }} />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 64, color: "#dbe4ef", fontSize: 44, lineHeight: 1.35 }}>
          <div style={{ display: "flex" }}>One CRM for every lead, quote and booking.</div>
          <div style={{ display: "flex" }}>Built for travel agencies.</div>
        </div>
      </div>
    ),
    { ...OG_SIZE }
  );
}
