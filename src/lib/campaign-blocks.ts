// Block-based campaign design: the data model, validation, personalization and the email-safe HTML it is rendered to. Pure (no database, no DOM), so the same code
// drives the builder's live preview, the server-side save and the per-recipient send, and is unit-tested.
//
// The rendered HTML is only the campaign BODY: the branded shell, the company address and the mandatory unsubscribe footer are added around it by
// buildMarketingCampaignEmail, and the result is cleaned by sanitizeCampaignHtml on save and again at send time. A design therefore can never remove the unsubscribe link.

export type BlockAlign = "left" | "center" | "right";

export type CampaignBlock =
  | { id: string; type: "heading"; text: string; level: 1 | 2 | 3; align: BlockAlign }
  | { id: string; type: "text"; text: string; align: BlockAlign }
  | { id: string; type: "image"; src: string; alt: string; href: string; widthPercent: number }
  | { id: string; type: "button"; label: string; url: string; align: BlockAlign; color: string }
  | { id: string; type: "divider" }
  | { id: string; type: "spacer"; height: number };

export type CampaignDesign = { version: 1; accent: string; blocks: CampaignBlock[] };

export const MAX_BLOCKS = 60;
export const MAX_TEXT_LENGTH = 5_000;
export const MAX_URL_LENGTH = 2_048;
const GMAIL_CLIP_BYTES = 102_000; // Gmail clips messages larger than ~102 KB

export const DEFAULT_ACCENT = "#1d4ed8";

// ───────────── URL validation (buttons, linked images, image sources) ─────────────

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/** Only absolute http(s) URLs with a host and no embedded credentials. javascript:, data:, vbscript:, file:, mailto: and relative links are all refused. */
export function validateCampaignUrl(raw: string, label = "Link"): UrlCheck {
  const value = (raw ?? "").trim();
  if (!value) return { ok: false, error: `${label} is required.` };
  if (value.length > MAX_URL_LENGTH) return { ok: false, error: `${label} is too long.` };
   
  if (/[\u0000- \u007f"'<>\\`]/.test(value)) return { ok: false, error: `${label} contains characters that are not allowed.` };
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, error: `${label} must be a full web address starting with https://` };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: `${label} must start with http:// or https://` };
  if (!u.hostname || !u.hostname.includes(".")) return { ok: false, error: `${label} must include a website name.` };
  if (u.username || u.password) return { ok: false, error: `${label} must not contain a username or password.` };
  return { ok: true, url: u.toString() };
}

export function isSafeColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

// ───────────── personalization ─────────────

export type PersonalizationVars = { firstName?: string | null; lastName?: string | null; email?: string | null };

export const PERSONALIZATION_FIELDS = ["firstName", "lastName", "fullName", "email"] as const;
const TOKEN = /\{\{\s*([A-Za-z]+)\s*(?:\|([^}]*))?\}\}/g;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fieldValue(name: string, vars: PersonalizationVars): string {
  const first = (vars.firstName ?? "").trim();
  const last = (vars.lastName ?? "").trim();
  switch (name) {
    case "firstName": return first;
    case "lastName": return last;
    case "fullName": return [first, last].filter(Boolean).join(" ");
    case "email": return (vars.email ?? "").trim();
    default: return "";
  }
}

/** Replaces {{field}} / {{field|fallback}} using the recipient's own data, HTML-escaped. A missing or empty value uses the fallback, or nothing - never the literal token. */
export function personalizeHtml(html: string, vars: PersonalizationVars): string {
  return html.replace(TOKEN, (_m, name: string, fallback?: string) => {
    const v = fieldValue(name, vars);
    // The recipient's value is escaped here. The fallback was typed by the author inside already-escaped HTML, so it is used as written (and the sanitizer
    // that runs before every send is the backstop for hand-written HTML).
    return v ? escapeHtml(v) : (fallback ?? "").trim();
  });
}

/** Plain-text version (subjects, preview lines). Not HTML-escaped. */
export function personalizeText(text: string, vars: PersonalizationVars): string {
  return text.replace(TOKEN, (_m, name: string, fallback?: string) => fieldValue(name, vars) || (fallback ?? "").trim());
}

export function unknownTokens(text: string): string[] {
  const bad = new Set<string>();
  for (const m of text.matchAll(TOKEN)) if (!(PERSONALIZATION_FIELDS as readonly string[]).includes(m[1])) bad.add(m[1]);
  return [...bad];
}

/** Sample data for the preview and test send, so the author sees what a real recipient sees. */
export const SAMPLE_RECIPIENT: PersonalizationVars = { firstName: "Alex", lastName: "Morgan", email: "alex.morgan@example.com" };

// ───────────── rendering ─────────────

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;font-family:${FONT};font-size:16px;line-height:1.6;color:#1f2937;">${escapeHtmlKeepTokens(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// Author text is escaped, but {{tokens}} are kept as written so they can be personalized later (token names/fallbacks hold no markup after escaping).
function escapeHtmlKeepTokens(s: string): string {
  return escapeHtml(s).replace(/\{\{\s*([A-Za-z]+)\s*(?:\|([^}]*))?\}\}/g, (m) => m);
}

export function renderBlock(block: CampaignBlock, accent: string): string {
  switch (block.type) {
    case "heading": {
      const size = block.level === 1 ? 28 : block.level === 2 ? 22 : 18;
      return `<h${block.level} style="margin:0 0 14px;font-family:${FONT};font-size:${size}px;line-height:1.3;color:#111827;text-align:${block.align};">${escapeHtmlKeepTokens(block.text)}</h${block.level}>`;
    }
    case "text":
      return paragraphs(block.text).replace(/<p style="/g, `<p style="text-align:${block.align};`);
    case "image": {
      const pct = Math.min(100, Math.max(10, Math.round(block.widthPercent)));
      const img = `<img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}" width="${pct === 100 ? 560 : Math.round(5.6 * pct)}" style="display:block;width:100%;max-width:${pct}%;height:auto;border:0;margin:0 auto;">`;
      const linked = block.href ? `<a href="${escapeHtml(block.href)}" target="_blank">${img}</a>` : img;
      return `<div style="margin:0 0 14px;text-align:center;">${linked}</div>`;
    }
    case "button": {
      const color = isSafeColor(block.color) ? block.color : accent;
      return `<table role="presentation" align="${block.align}" cellpadding="0" cellspacing="0" style="margin:0 0 18px;border-collapse:separate;"><tr><td bgcolor="${color}" style="background-color:${color};border-radius:8px;"><a href="${escapeHtml(block.url)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:16px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;">${escapeHtmlKeepTokens(block.label)}</a></td></tr></table>`;
    }
    case "divider":
      return `<hr style="border:0;border-top:1px solid #e5e7eb;margin:20px 0;">`;
    case "spacer":
      return `<div style="height:${Math.min(120, Math.max(4, Math.round(block.height)))}px;line-height:${Math.min(120, Math.max(4, Math.round(block.height)))}px;font-size:0;">&nbsp;</div>`;
  }
}

/** Renders the body fragment. Output keeps {{tokens}}; personalizeHtml resolves them per recipient. */
export function renderDesignToHtml(design: CampaignDesign): string {
  const accent = isSafeColor(design.accent) ? design.accent : DEFAULT_ACCENT;
  return design.blocks.map((b) => renderBlock(b, accent)).join("\n");
}

// ───────────── validation ─────────────

export type DesignIssue = { blockId: string | null; severity: "error" | "warning"; message: string };

export function validateDesign(design: unknown, subject: string): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const err = (blockId: string | null, message: string) => issues.push({ blockId, severity: "error", message });
  const warn = (blockId: string | null, message: string) => issues.push({ blockId, severity: "warning", message });
  if (!subject || !subject.trim()) err(null, "Add a subject line.");
  for (const t of unknownTokens(subject ?? "")) err(null, `The subject uses an unknown field {{${t}}}. Use firstName, lastName, fullName or email.`);
  const d = design as CampaignDesign | null;
  if (!d || d.version !== 1 || !Array.isArray(d.blocks)) return [...issues, { blockId: null, severity: "error", message: "The design is not valid." }];
  if (d.blocks.length === 0) err(null, "Add at least one block.");
  if (d.blocks.length > MAX_BLOCKS) err(null, `A campaign can have at most ${MAX_BLOCKS} blocks.`);
  if (!isSafeColor(d.accent)) err(null, "The accent colour must be a hex colour such as #1d4ed8.");
  const ids = new Set<string>();
  for (const b of d.blocks) {
    if (!b || typeof b !== "object" || typeof b.id !== "string") { err(null, "A block is malformed."); continue; }
    if (ids.has(b.id)) err(b.id, "Two blocks share the same id.");
    ids.add(b.id);
    switch (b.type) {
      case "heading":
      case "text": {
        if (!b.text?.trim()) err(b.id, `${b.type === "heading" ? "Heading" : "Text"} block is empty.`);
        if ((b.text?.length ?? 0) > MAX_TEXT_LENGTH) err(b.id, `Text is longer than ${MAX_TEXT_LENGTH} characters.`);
        for (const t of unknownTokens(b.text ?? "")) err(b.id, `Unknown field {{${t}}}. Use firstName, lastName, fullName or email.`);
        if (/\[\[[^\]]+\]\]/.test(b.text ?? "")) err(b.id, "Replace the [[placeholder]] with real content.");
        break;
      }
      case "button": {
        if (!b.label?.trim()) err(b.id, "The button needs a label.");
        const u = validateCampaignUrl(b.url, "Button link");
        if (!u.ok) err(b.id, u.error);
        if (!isSafeColor(b.color)) err(b.id, "The button colour must be a hex colour.");
        break;
      }
      case "image": {
        const u = validateCampaignUrl(b.src, "Image address");
        if (!u.ok) err(b.id, u.error);
        else if (!u.url.startsWith("https://")) warn(b.id, "Use an https:// image address; some mail apps block http images.");
        if (!b.alt?.trim()) warn(b.id, "Add alt text so the image is understood when it is blocked or read aloud.");
        if (b.href) {
          const l = validateCampaignUrl(b.href, "Image link");
          if (!l.ok) err(b.id, l.error);
        }
        break;
      }
      case "divider":
      case "spacer":
        break;
      default:
        err(null, "A block has an unknown type.");
    }
  }
  if (!issues.some((i) => i.severity === "error")) {
    const size = new TextEncoder().encode(renderDesignToHtml(d)).length;
    if (size > GMAIL_CLIP_BYTES) warn(null, "This design is large; Gmail clips messages over about 100 KB and hides the unsubscribe link below the clip. Remove some content.");
  }
  return issues;
}

export function hasErrors(issues: DesignIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

/** Parses a stored designJson defensively (it is data from the database): anything that does not match the model returns null. */
export function parseStoredDesign(value: unknown): CampaignDesign | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Partial<CampaignDesign>;
  if (d.version !== 1 || !Array.isArray(d.blocks) || typeof d.accent !== "string") return null;
  return d as CampaignDesign;
}

// ───────────── starter templates ─────────────

let counter = 0;
export const newBlockId = () => `b${Date.now().toString(36)}${(counter++).toString(36)}`;

export function emptyDesign(): CampaignDesign {
  return { version: 1, accent: DEFAULT_ACCENT, blocks: [] };
}

export function newBlock(type: CampaignBlock["type"]): CampaignBlock {
  const id = newBlockId();
  switch (type) {
    case "heading": return { id, type, text: "Your headline", level: 1, align: "left" };
    case "text": return { id, type, text: "Hi {{firstName|there}},\n\nWrite your message here.", align: "left" };
    case "image": return { id, type, src: "", alt: "", href: "", widthPercent: 100 };
    case "button": return { id, type, label: "Learn more", url: "", align: "left", color: DEFAULT_ACCENT };
    case "divider": return { id, type };
    case "spacer": return { id, type, height: 24 };
  }
}

export const DESIGN_TEMPLATES: Array<{ id: string; name: string; category: string; design: () => CampaignDesign }> = [
  {
    id: "announcement",
    name: "Announcement",
    category: "General",
    design: () => ({
      version: 1,
      accent: DEFAULT_ACCENT,
      blocks: [
        { id: newBlockId(), type: "heading", text: "Big news, {{firstName|friend}}", level: 1, align: "left" },
        { id: newBlockId(), type: "text", text: "Tell your subscribers what is new and why it matters to them.", align: "left" },
        { id: newBlockId(), type: "button", label: "See the details", url: "", align: "left", color: DEFAULT_ACCENT },
      ],
    }),
  },
  {
    id: "offer",
    name: "Special offer",
    category: "Promotion",
    design: () => ({
      version: 1,
      accent: "#047857",
      blocks: [
        { id: newBlockId(), type: "heading", text: "A little something for you", level: 1, align: "center" },
        { id: newBlockId(), type: "image", src: "", alt: "", href: "", widthPercent: 100 },
        { id: newBlockId(), type: "text", text: "Hi {{firstName|there}},\n\nDescribe the offer, the dates and any conditions.", align: "left" },
        { id: newBlockId(), type: "button", label: "Claim the offer", url: "", align: "center", color: "#047857" },
        { id: newBlockId(), type: "divider" },
        { id: newBlockId(), type: "text", text: "Terms apply. Replace this with your fine print.", align: "left" },
      ],
    }),
  },
];
