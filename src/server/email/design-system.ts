// The premium visual layer of the outbound email system. Everything that
// makes a Marketing / one-to-one / Sequence email look the way it does lives
// here, on top of the SAME tokens the transactional templates already use —
// one visual language, four deliberately different personalities:
//
//   marketing    — branded and editorial: logo header, a dark hero band that
//                  carries the subject as the title, generous body, a clean
//                  footer with the unsubscribe line.
//   personal     — a one-to-one message from an agent (Lead / Contact
//                  composer, Get in Touch replies): a quiet header, the agent's
//                  own words in plain correspondence typography, a refined
//                  signature. Nothing that reads as a mass mailing.
//   sequence     — automated correspondence: the personal layout plus the
//                  footer note and one-click unsubscribe an unattended send
//                  must carry. Subtle branding, no hero.
//   transactional / internal — still rendered by templates.ts' renderEmailCard,
//                  which shares these tokens.
//
// Email HTML is not web HTML: tables for layout, inline styles for anything
// that must survive, explicit widths, web-safe font stacks, a `<style>` block
// only as a progressive enhancement (Gmail, Apple Mail and the mobile apps
// read it; classic Outlook ignores it and keeps the inline layout, which is
// already a complete, working design). No JavaScript, no web fonts, no
// background images. Anything written between the backticks of a template
// literal below — CSS comments included — is literal text in every outbound
// email, so engineering commentary stays up here in the TS comments.
import type { ResolvedCompanyBranding } from "@/lib/company-config";

export const EMAIL_TOKENS = {
  // A soft, restrained blue-gray page background — not a plain flat gray and
  // never so dark it competes with the white content card.
  pageBackground: "#eef1f6",
  cardBackground: "#ffffff",
  cardBorder: "#e2e5eb",
  border: "#e5e7eb",
  mutedBackground: "#f9fafb",
  text: "#111827",
  textMuted: "#4b5563",
  textSubtle: "#6b7280",
  textFaint: "#6b7280",
  success: "#15803d",
  successBackground: "#ecfdf5",
  successBorder: "#a7f3d0",
  warning: "#92400e",
  warningBackground: "#fffbeb",
  warningBorder: "#fde68a",
  danger: "#b91c1c",
  dangerBackground: "#fef2f2",
  dangerBorder: "#fecaca",
  radius: "14px",
  fontFamily: "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif",
  // Premium layer
  ink: "#0f1b2d",
  inkMuted: "#9fb0c8",
  champagne: "#c9a96e",
  pageBackgroundDeep: "#e2e8f1",
  hairline: "#e6e9ef",
  bodyText: "#1f2937",
  headingFont: "Georgia,'Times New Roman',Times,serif",
} as const;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** For text placed inside an HTML attribute (alt, title) — also escapes quotes. */
export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Only http(s)/mailto links may become a button or clickable target taken
 * from author-supplied content; anything else (javascript:, data:, a relative
 * path) is rejected.
 */
export function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href.trim());
}

function parseHex(hex: string): [number, number, number] | null {
  let h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/(.)/g, "$1$1");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two hex colours (1–21), or null if either is not a hex colour. */
export function contrastRatio(a: string, b: string): number | null {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return null;
  const [hi, lo] = [luminance(ra), luminance(rb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * A brand colour that is safe to use as a button background: the company's
 * own colour when it is a valid hex, otherwise the neutral ink. The label
 * colour is white or ink — whichever contrasts better with that background.
 */
export function buttonColors(brandColor: string): { background: string; text: string } {
  const background = parseHex(brandColor) ? brandColor : EMAIL_TOKENS.ink;
  const onWhite = contrastRatio(background, "#ffffff") ?? 0;
  const onInk = contrastRatio(background, EMAIL_TOKENS.ink) ?? 0;
  return { background, text: onWhite >= onInk ? "#ffffff" : EMAIL_TOKENS.ink };
}

/**
 * A bulletproof button: the padding and background live on the table cell
 * (classic Outlook ignores padding on an inline anchor), the anchor carries
 * the label. `tone: "secondary"` is an outlined variant for a second action.
 */
export function renderButton(params: { href: string; label: string; brandColor: string; tone?: "primary" | "secondary"; align?: "left" | "center" }): string {
  const { href, label, brandColor, tone = "primary", align = "left" } = params;
  const { background, text } = buttonColors(brandColor);
  const cell =
    tone === "primary"
      ? `background:${background}; border-radius:8px;`
      : `background:#ffffff; border:1px solid ${background}; border-radius:8px;`;
  const labelColor = tone === "primary" ? text : background;
  // A left-aligned table must carry no align attribute: align="left" floats it and the next paragraph wraps beside the button.
  const alignAttr = align === "center" ? " align=\"center\"" : "";
  return `<table role="presentation" class="ct-btn-table" cellpadding="0" cellspacing="0"${alignAttr} style="margin:8px 0 22px;">
    <tr>
      <td class="ct-btn-cell" style="${cell} text-align:center;">
        <a class="ct-btn-link" href="${escapeAttr(href)}" style="display:inline-block; padding:14px 30px; font-family:${EMAIL_TOKENS.fontFamily}; font-size:15px; font-weight:600; line-height:20px; color:${labelColor}; text-decoration:none; border-radius:8px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

const LONE_LINK_PARAGRAPH = /<p(?:\s[^>]*)?>\s*<a\s([^>]*)>([^<]{2,40})<\/a>\s*<\/p>/gi;

/**
 * In a marketing campaign, a paragraph that holds nothing but one short link
 * ("Explore the route") is the author's call to action — render it as a
 * button. A bare URL as the link text, a link inside running prose, and any
 * non-http(s)/mailto target stay ordinary links. The author's words and the
 * link target are never altered.
 */
export function promoteLoneLinksToButtons(html: string, brandColor: string): string {
  return html.replace(LONE_LINK_PARAGRAPH, (whole, attrs: string, text: string) => {
    const href = /href\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const label = text.trim();
    if (!href || !isSafeHref(href) || /^(https?:\/\/|www\.)/i.test(label) || label.includes("@")) return whole;
    return renderButton({ href: href.replace(/&amp;/g, "&"), label: label.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), brandColor });
  });
}

/** A short plain-text summary for the inbox preview line (the hidden preheader). */
export function summarizeForPreheader(html: string, max = 140): string {
  const text = html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Visually hidden inbox-preview text (a long run of invisible characters stops the client pulling body text after it). */
export function renderPreheader(text: string): string {
  const filler = "&#847; ".repeat(60);
  return `<div style="display:none; max-height:0; max-width:0; overflow:hidden; opacity:0; font-size:1px; line-height:1px; color:${EMAIL_TOKENS.pageBackground};">${escapeHtml(text)}${filler}</div>`;
}

/**
 * Typography for author-supplied rich text (the Marketing editor's HTML) and
 * the responsive rules for the premium shell. Class selectors in a head
 * `<style>`: the clients that ignore them fall back to their own readable
 * defaults inside the already-bounded container.
 */
export const PREMIUM_STYLE = `<style>
  img { max-width: 100%; height: auto; }
  .ct-prose { font-family: ${EMAIL_TOKENS.fontFamily}; font-size: 16px; line-height: 1.7; color: ${EMAIL_TOKENS.bodyText}; word-wrap: break-word; overflow-wrap: anywhere; }
  .ct-prose p { margin: 0 0 18px; }
  .ct-prose h1, .ct-prose h2, .ct-prose h3 { font-family: ${EMAIL_TOKENS.headingFont}; font-weight: 700; color: ${EMAIL_TOKENS.ink}; line-height: 1.3; margin: 28px 0 12px; }
  .ct-prose h1 { font-size: 26px; }
  .ct-prose h2 { font-size: 21px; }
  .ct-prose h3 { font-size: 18px; }
  .ct-prose ul, .ct-prose ol { margin: 0 0 18px; padding-left: 22px; }
  .ct-prose li { margin: 0 0 6px; }
  .ct-prose blockquote { margin: 0 0 18px; padding: 4px 0 4px 16px; border-left: 3px solid ${EMAIL_TOKENS.champagne}; color: ${EMAIL_TOKENS.textMuted}; }
  .ct-prose hr { border: 0; border-top: 1px solid ${EMAIL_TOKENS.hairline}; margin: 26px 0; }
  .ct-prose img { border: 0; border-radius: 8px; }
  .ct-prose table { max-width: 100%; }
  .ct-prose > :first-child { margin-top: 0; }
  @media only screen and (max-width: 480px) {
    .ct-pad { padding-left: 22px !important; padding-right: 22px !important; }
    .ct-hero-title { font-size: 25px !important; line-height: 1.3 !important; }
    .ct-prose { font-size: 16px !important; }
    .ct-btn-table { width: 100% !important; }
    .ct-btn-cell { display: block !important; width: 100% !important; box-sizing: border-box; }
    .ct-btn-link { display: block !important; text-align: center !important; padding-left: 12px !important; padding-right: 12px !important; }
  }
</style>`;

export type PremiumVariant = "marketing" | "personal" | "sequence";

const CARD_WIDTH: Record<PremiumVariant, number> = { marketing: 640, personal: 620, sequence: 620 };

function logoOrName(company: ResolvedCompanyBranding, width: number, height: number, nameSize: number): string {
  return company.logoEmailUrl
    ? `<img src="${escapeAttr(company.logoEmailUrl)}" alt="${escapeAttr(company.name)}" width="${width}" height="${height}" style="display:block; width:${width}px; height:${height}px; max-width:100%; object-fit:contain; object-position:left; border:0;" />`
    : `<span style="font-family:${EMAIL_TOKENS.headingFont}; font-size:${nameSize}px; font-weight:700; color:${EMAIL_TOKENS.ink}; letter-spacing:-0.01em;">${escapeHtml(company.name)}</span>`;
}

/** Company name · website · phone, wrapped safely — never invents a legal line. */
export function renderContactLine(company: ResolvedCompanyBranding): string {
  const parts = [
    company.website
      ? `<a href="${escapeAttr(company.website)}" style="color:${EMAIL_TOKENS.textSubtle}; text-decoration:none; word-break:break-all; overflow-wrap:anywhere;">${escapeHtml(company.website.replace(/^https?:\/\//, ""))}</a>`
      : null,
    company.phone ? escapeHtml(company.phone) : null,
  ].filter(Boolean);
  return parts.join(" &middot; ");
}

export function renderPremiumShell(params: {
  variant: PremiumVariant;
  company: ResolvedCompanyBranding;
  /** Already-rendered body HTML. */
  bodyHtml: string;
  /** Marketing only: the hero title (the campaign subject). */
  title?: string;
  preheader?: string;
  /** Already-rendered footer inner HTML. */
  footerHtml: string;
  /** Personal/sequence: the already-rendered signature block, placed under the body. */
  signatureHtml?: string;
}): string {
  const { variant, company, bodyHtml, title, preheader, footerHtml, signatureHtml } = params;
  const brand = parseHex(company.brandColor) ? company.brandColor : EMAIL_TOKENS.ink;
  const width = CARD_WIDTH[variant];
  const isMarketing = variant === "marketing";

  const header = isMarketing
    ? `<td class="ct-pad" style="padding:26px 40px 22px; background:#ffffff;">${logoOrName(company, 160, 68, 21)}</td>`
    : `<td class="ct-pad" style="padding:20px 32px 16px; background:#ffffff; border-bottom:1px solid ${EMAIL_TOKENS.hairline};">${logoOrName(company, 120, 50, 17)}</td>`;

  const hero =
    isMarketing && title
      ? `<tr>
      <td class="ct-pad" bgcolor="${EMAIL_TOKENS.ink}" style="background:${EMAIL_TOKENS.ink}; padding:40px 40px 38px;">
        <p style="margin:0 0 14px; font-family:${EMAIL_TOKENS.fontFamily}; font-size:11px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color:${EMAIL_TOKENS.inkMuted};">${escapeHtml(company.name)}</p>
        <h1 class="ct-hero-title" style="margin:0; font-family:${EMAIL_TOKENS.headingFont}; font-size:30px; line-height:1.25; font-weight:700; color:#ffffff; letter-spacing:-0.01em; word-wrap:break-word; overflow-wrap:anywhere;">${escapeHtml(title)}</h1>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 0;"><tr><td style="width:44px; height:2px; background:${EMAIL_TOKENS.champagne}; font-size:0; line-height:0;">&nbsp;</td></tr></table>
      </td>
    </tr>`
      : "";

  const bodyPad = isMarketing ? "38px 40px 14px" : "30px 32px 6px";
  const personalType = `font-family:${EMAIL_TOKENS.fontFamily}; font-size:15px; line-height:1.75; color:${EMAIL_TOKENS.bodyText};`;
  const marketingType = `font-family:${EMAIL_TOKENS.fontFamily}; font-size:16px; line-height:1.7; color:${EMAIL_TOKENS.bodyText};`;
  const footerAlign = isMarketing ? "center" : "left";

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
${PREMIUM_STYLE}
</head>
<body style="margin:0; padding:0; background:${EMAIL_TOKENS.pageBackground};">
${preheader ? renderPreheader(preheader) : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${EMAIL_TOKENS.pageBackground}" style="background-color:${EMAIL_TOKENS.pageBackground}; background-image:linear-gradient(180deg, ${EMAIL_TOKENS.pageBackground} 0%, ${EMAIL_TOKENS.pageBackgroundDeep} 100%);">
  <tr>
    <td align="center" style="padding:${isMarketing ? "36px" : "28px"} 12px 40px; font-family:${EMAIL_TOKENS.fontFamily};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${width}px; margin:0 auto; background:#ffffff; border:1px solid ${EMAIL_TOKENS.cardBorder}; border-radius:16px; overflow:hidden; box-shadow:0 1px 2px rgba(15,27,45,0.05), 0 12px 32px rgba(15,27,45,0.07); table-layout:fixed;">
        <tr><td style="height:4px; background:${brand}; font-size:0; line-height:0;">&nbsp;</td></tr>
        <tr>${header}</tr>
        ${hero}
        <tr>
          <td class="ct-pad" style="padding:${bodyPad}; text-align:left;">
            <div class="ct-prose" style="${isMarketing ? marketingType : personalType}">${bodyHtml}</div>
          </td>
        </tr>
        ${signatureHtml ? `<tr><td class="ct-pad" style="padding:6px 32px 32px; text-align:left;">${signatureHtml}</td></tr>` : ""}
        <tr>
          <td class="ct-pad" style="padding:22px ${isMarketing ? "40px" : "32px"}; background:${EMAIL_TOKENS.mutedBackground}; border-top:1px solid ${EMAIL_TOKENS.hairline}; text-align:${footerAlign}; font-family:${EMAIL_TOKENS.fontFamily};">
            ${footerHtml}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
