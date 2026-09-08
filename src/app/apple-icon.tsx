import { ImageResponse } from "next/og";

// Apple's home-screen/bookmark icon convention — same "bearing needle"
// mark as icon.tsx (see compass-mark.tsx's comment for the full design
// rationale and geometry constants), at Apple's required 180x180 and with
// no corner-rounding of our own (iOS applies its own mask/rounding to
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
          <polygon points="8.75,3.07 7.77,13.54 15.25,20.93" fill="white" />
          <polygon points="8.75,3.07 16.23,10.46 15.25,20.93" fill={GOLD} />
          <circle cx="12" cy="12" r="1.4" fill="#1c3a5e" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
