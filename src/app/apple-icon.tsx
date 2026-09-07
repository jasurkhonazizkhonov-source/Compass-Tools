import { ImageResponse } from "next/og";

// Apple's home-screen/bookmark icon convention — same mark as icon.tsx
// (open ring + gold dot — see compass-mark.tsx's comment for the full
// design rationale), at Apple's required 180x180 and with no
// corner-rounding of our own (iOS applies its own mask/rounding to
// whatever square image this returns).
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const GOLD = "#d4a24e";

export default function AppleIcon() {
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
        }}
      >
        <svg width="162" height="162" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="50.6 12.2" strokeDashoffset="56.7" />
          <circle cx="21.7" cy="12" r="1.8" fill={GOLD} />
        </svg>
      </div>
    ),
    { ...size }
  );
}
