import type { CardBrand } from "@/lib/card-validation";

const BRAND_STYLE: Record<CardBrand, { label: string; bg: string; fg: string }> = {
  Visa: { label: "VISA", bg: "#1a1f71", fg: "#ffffff" },
  Mastercard: { label: "MC", bg: "linear-gradient(90deg,#eb001b 0%,#eb001b 50%,#f79e1b 50%,#f79e1b 100%)", fg: "#ffffff" },
  "American Express": { label: "AMEX", bg: "#2e77bc", fg: "#ffffff" },
  Discover: { label: "DISC", bg: "#ff6000", fg: "#ffffff" },
  Unknown: { label: "CARD", bg: "#6b7280", fg: "#ffffff" },
};

/**
 * A stylized, non-infringing card-network badge (not the trademarked
 * network logos themselves) — brand-colored, legible at small sizes, used
 * both on the decorative card preview and in masked-card CRM displays.
 */
export function CardBrandLogo({ brand, className }: { brand: CardBrand; className?: string }) {
  const style = BRAND_STYLE[brand];
  return (
    <span
      className={`inline-flex items-center justify-center rounded px-2 py-0.5 text-[10px] font-bold tracking-wide ${className ?? ""}`}
      style={{ background: style.bg, color: style.fg }}
    >
      {style.label}
    </span>
  );
}
