import sanitizeHtml from "sanitize-html";
import { campaignSanitizeOptions } from "@/server/email/sanitize-campaign-html";
import { EMAIL_TOKENS, escapeHtml } from "@/server/email/design-system";
import { SEQUENCE_VARIABLES, VARIABLE_TOKEN_META, type SequenceVariableContext } from "@/lib/sequence-variables";

// Everything the server does with a sequence step written in the VISUAL editor (StepBodyFormat HTML). Pure and synchronous: the same functions run when a step is saved (to
// clean and judge it), when it is previewed, and when it is sent, so what a person sees in the preview is exactly what the customer's mail client is given.
//
// The pipeline for one send is:   raw HTML (with {{tokens}})  ->  tokens replaced by the recipient's values, HTML-ESCAPED  ->  cleaned against the allow-list
// (sanitize-html: scripts, event handlers, javascript: links, forms, url() in CSS ... all removed)  ->  email-safe INLINE styles added  ->  wrapped by buildSequenceEmail
// (branded shell, the agent's signature and the mandatory unsubscribe footer). A step therefore cannot remove the unsubscribe link, and a customer's name can never
// inject markup.
//
// Email clients ignore most of what browsers support: no <style> blocks (they are stripped), limited CSS, Outlook ignores CSS widths on images. So the styles are written inline on
// every element, images carry width/height attributes as well as CSS, and the call-to-action button is a table (the only construction every client renders as a button).

export const MAX_STEP_HTML_CHARS = 100_000; // Gmail clips a message at ~102 KB; a step that big leaves no room for the shell and footer
const WARN_STEP_HTML_CHARS = 70_000;
export const EDITOR_BLOCK_ATTRIBUTE = "data-compass-block"; // marks the blocks only the visual editor creates (button, spacer) so they survive a save and reload

/** The cleaned HTML of a step, ready to be stored: the same allow-list that protects campaigns, plus the editor's own block markers. */
export function sanitizeStepHtml(dirty: string): string {
  if (!dirty) return "";
  return sanitizeHtml(dirty, campaignSanitizeOptions());
}

// ───────────────────────── email-safe inline styles ─────────────────────────

function parseStyle(style: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (style ?? "").split(";")) {
    const i = part.indexOf(":");
    if (i > 0) out.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return out;
}

/** Defaults first, then what the author set: the author's own value (a colour, an alignment, a size) always wins. */
function withDefaults(existing: string | undefined, defaults: Record<string, string>): string {
  const merged = new Map(Object.entries(defaults));
  for (const [k, v] of parseStyle(existing)) merged.set(k, v);
  return [...merged].map(([k, v]) => `${k}:${v}`).join(";");
}

const BODY = EMAIL_TOKENS.textMuted; // the same body colour buildSequenceEmail uses for plain-text steps
const FONT = "15px";

function styleDefaults(brandColor: string): Record<string, Record<string, string>> {
  return {
    p: { margin: "0 0 16px", "font-size": FONT, "line-height": "1.75", color: BODY },
    h1: { margin: "0 0 14px", "font-size": "26px", "line-height": "1.25", "font-weight": "700", color: EMAIL_TOKENS.text },
    h2: { margin: "0 0 12px", "font-size": "21px", "line-height": "1.3", "font-weight": "700", color: EMAIL_TOKENS.text },
    h3: { margin: "0 0 10px", "font-size": "17px", "line-height": "1.35", "font-weight": "700", color: EMAIL_TOKENS.text },
    ul: { margin: "0 0 16px", "padding-left": "24px", "font-size": FONT, "line-height": "1.75", color: BODY },
    ol: { margin: "0 0 16px", "padding-left": "24px", "font-size": FONT, "line-height": "1.75", color: BODY },
    li: { margin: "0 0 6px" },
    a: { color: brandColor, "text-decoration": "underline" },
    blockquote: { margin: "0 0 16px", "padding-left": "14px", "border-left": `3px solid ${EMAIL_TOKENS.border}`, color: EMAIL_TOKENS.textSubtle },
    hr: { border: "0", "border-top": `1px solid ${EMAIL_TOKENS.border}`, margin: "24px 0" },
    img: { border: "0", "max-width": "100%", height: "auto" },
  };
}

/** Image width / height as plain numbers (pixels), so Outlook - which ignores CSS sizes - still lays the picture out correctly. */
function numericPixels(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^(\d{1,4})(?:px)?$/.exec(value.trim());
  return m ? m[1] : undefined;
}

/** Adds the inline styles an email client needs to every element the editor can produce. Runs inside the same sanitising pass as everything else. */
export function sanitizeAndStyleStepHtml(dirty: string, brandColor: string): string {
  if (!dirty) return "";
  const defaults = styleDefaults(/^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : "#1d4ed8");
  const base = campaignSanitizeOptions();
  const styled: sanitizeHtml.IOptions["transformTags"] = { ...base.transformTags };
  for (const tag of Object.keys(defaults)) {
    const previous = base.transformTags?.[tag];
    styled[tag] = (tagName, attribs) => {
      const first = typeof previous === "function" ? previous(tagName, attribs) : { tagName, attribs };
      const attrs = { ...first.attribs };
      attrs.style = withDefaults(attrs.style, defaults[tag]);
      if (tag === "img") {
        const w = numericPixels(attrs.width) ?? numericPixels(parseStyle(attrs.style).get("width"));
        const h = numericPixels(attrs.height);
        if (w) attrs.width = w;
        if (h) attrs.height = h;
        else delete attrs.height; // an attribute height would distort the picture when the client shrinks it: leave it to height:auto
      }
      return { tagName: first.tagName, attribs: attrs };
    };
  }
  return sanitizeHtml(dirty, {
    ...base,
    transformTags: styled,
    // The editor keeps an empty paragraph after a button or divider so the cursor has somewhere to go; sent as a real paragraph it would be a blank gap. Anything that holds
    // text or a picture is kept. (Paragraphs already have spacing; an author who wants an exact gap uses the Spacer block.)
    exclusiveFilter: (frame) => (base.exclusiveFilter?.(frame) ?? false) || (frame.tag === "p" && !frame.text.trim() && frame.mediaChildren.length === 0),
  });
}

// ───────────────────────── personalization ─────────────────────────

const TOKEN_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
const CAMEL_TO_SNAKE = (key: string) => key.replace(/([A-Z])/g, "_$1").toLowerCase();

/** Replaces the {{tokens}} the sequence knows with the recipient's value, HTML-ESCAPED; a token it does not know is left exactly as written. */
export function personalizeStepHtml(html: string, context: SequenceVariableContext): string {
  const byToken = new Map<string, string>(SEQUENCE_VARIABLES.map((v) => [CAMEL_TO_SNAKE(v.key), context[v.key] ?? ""]));
  return html.replace(TOKEN_RE, (whole, name: string) => (byToken.has(name.toLowerCase()) ? escapeHtml(byToken.get(name.toLowerCase()) ?? "") : whole));
}

/** The HTML body of one email: personalised, cleaned, and styled for email clients. */
export function renderStepBodyHtml(html: string, context: SequenceVariableContext, brandColor: string): string {
  return sanitizeAndStyleStepHtml(personalizeStepHtml(html, context), brandColor);
}

// ───────────────────────── analysis: what is wrong, what could be better ─────────────────────────

export type StepIssue = { level: "error" | "warning"; code: string; message: string };
export type StepAnalysis = { errors: StepIssue[]; warnings: StepIssue[]; linkCount: number; imageCount: number; sizeChars: number; ok: boolean };

const SAFE_LINK = /^(https?:\/\/[^\s]+|mailto:[^\s]+@[^\s]+|tel:[+\d][\d\s().-]*)$/i;

function collect(html: string): { links: { href: string; text: string }[]; images: { src: string; alt: string }[]; hasText: boolean; hasScript: boolean } {
  const links: { href: string; text: string }[] = [];
  const images: { src: string; alt: string }[] = [];
  let hasScript = false;
  let textChars = 0;
  let openLink: { href: string; text: string } | null = null;
  // A parse pass that keeps everything (the transform runs on the RAW attributes, before any scheme is filtered out), only to read what is there.
  sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    nonTextTags: ["style", "textarea", "option", "title", "noscript", "template"],
    textFilter: (text) => {
      const trimmed = text.trim();
      textChars += trimmed.length;
      if (openLink) openLink.text += trimmed;
      return text;
    },
    transformTags: {
      a: (tagName, attribs) => {
        openLink = { href: (attribs.href ?? "").trim(), text: "" };
        links.push(openLink);
        return { tagName, attribs };
      },
      img: (tagName, attribs) => {
        images.push({ src: (attribs.src ?? "").trim(), alt: (attribs.alt ?? "").trim() });
        return { tagName, attribs };
      },
      script: (tagName, attribs) => {
        hasScript = true;
        return { tagName, attribs };
      },
    },
  });
  return { links, images, hasText: textChars > 0, hasScript };
}

/** Judges a step before it is saved. Errors block saving; warnings are advice. TEXT steps only get the variable and link checks. */
export function analyzeStepContent(input: { subject: string; body: string; format: "TEXT" | "HTML" }): StepAnalysis {
  const errors: StepIssue[] = [];
  const warnings: StepIssue[] = [];
  const err = (code: string, message: string) => errors.push({ level: "error", code, message });
  const warn = (code: string, message: string) => warnings.push({ level: "warning", code, message });
  const { subject, body, format } = input;

  if (!subject.trim()) err("subject-empty", "The subject is empty.");
  if (!body.trim()) err("body-empty", "The email has no content.");

  // Variables: an unknown token would be sent as literal text, which a customer sees as a mistake.
  const unknown = new Set<string>();
  for (const text of [subject, body]) for (const m of text.matchAll(TOKEN_RE)) if (!VARIABLE_TOKEN_META[m[1].toLowerCase()]) unknown.add(m[0]);
  for (const token of unknown) warn("unknown-variable", `${token} is not a known variable and would be sent as written.`);

  let linkCount = 0;
  let imageCount = 0;
  if (format === "HTML") {
    if (body.length > MAX_STEP_HTML_CHARS) err("too-large", `The email is too large (${Math.round(body.length / 1000)} KB). Gmail cuts messages off at about 102 KB; shorten it or use fewer or smaller blocks.`);
    else if (body.length > WARN_STEP_HTML_CHARS) warn("large", `The email is ${Math.round(body.length / 1000)} KB; Gmail cuts messages off at about 102 KB.`);
    const found = collect(body);
    linkCount = found.links.length;
    imageCount = found.images.length;
    if (!found.hasText && found.images.length === 0 && body.trim()) err("body-empty", "The email has no visible content.");
    if (found.hasScript) warn("script-removed", "Scripts are not allowed in email; they will be removed.");
    found.links.forEach((l, i) => {
      const label = l.text ? `"${l.text.slice(0, 40)}"` : `link ${i + 1}`;
      if (!l.href || l.href === "#") err("link-empty", `The ${label} link has no web address.`);
      else if (/\{\{/.test(l.href)) warn("link-variable", `The ${label} link contains a variable; variables only work in the text, so this link would be sent broken.`);
      else if (!SAFE_LINK.test(l.href)) err("link-unsafe", `The ${label} link (${l.href.slice(0, 60)}) is not a web, email or phone link and cannot be sent.`);
      else if (/^http:\/\//i.test(l.href)) warn("link-insecure", `The ${label} link uses http://; many mail programs warn about it. Use https:// if the site supports it.`);
      if (l.href && !l.text && !/<img/i.test(body)) warn("link-no-text", `A link has no visible text.`);
    });
    found.images.forEach((img, i) => {
      if (!img.src) err("image-missing", `Image ${i + 1} has no source.`);
      else if (!/^https:\/\/[^\s]+$/i.test(img.src)) err("image-not-public", `Image ${i + 1} must be a public https:// address. A picture stored on this computer or inside the CRM cannot be shown to the people who receive the email.`);
      if (!img.alt) warn("image-alt", `Image ${i + 1} has no description (alt text). It is shown when pictures are blocked and read out by screen readers.`);
    });
  } else {
    // Plain text: only links typed as text can be checked, and they are linked automatically when sent.
    for (const m of body.matchAll(/\bhttp:\/\/[^\s]+/gi)) warn("link-insecure", `${m[0].slice(0, 60)} uses http://; use https:// if the site supports it.`);
  }

  const analysis = { errors, warnings, linkCount, imageCount, sizeChars: body.length, ok: errors.length === 0 };
  return analysis;
}
