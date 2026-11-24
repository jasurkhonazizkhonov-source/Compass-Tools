import { Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyleKit } from "@tiptap/extension-text-style";

// The extensions of the ONE visual email editor (components/subscriptions/rich-text-editor.tsx), used by the sequence step editor and the campaign form alike. Everything here
// writes HTML that survives the server's allow-list (server/email/sanitize-campaign-html.ts) and renders in email clients: formatting as inline styles, the button as a table, and
// the blocks only this editor makes carry a data-compass-block marker so they come back as blocks when a step is reopened.

/** The sizes offered for text (pixels): small print, normal, and three larger ones. */
export const FONT_SIZES = [
  { label: "Small", value: "13px" },
  { label: "Normal", value: "15px" },
  { label: "Large", value: "18px" },
  { label: "Extra large", value: "22px" },
] as const;

/** Line spacing offered for text (the line-height multiplier). */
export const LINE_SPACINGS = [
  { label: "Tight", value: "1.4" },
  { label: "Normal", value: "1.75" },
  { label: "Relaxed", value: "2" },
] as const;

export const COLOR_SWATCHES = ["#111827", "#4b5563", "#b91c1c", "#c2410c", "#a16207", "#15803d", "#0e7490", "#1d4ed8", "#6d28d9", "#be185d", "#ffffff"] as const;
export const HIGHLIGHT_SWATCHES = ["#fef08a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#fed7aa", "#e5e7eb"] as const;

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const safeHex = (v: unknown, fallback: string) => (isHex(v) ? v : fallback);
const px = (v: unknown): string | null => {
  const m = /^(\d{1,4})(?:px)?$/.exec(String(v ?? "").trim());
  return m ? m[1] : null;
};

/** An image with a size. It sits inline (so a link can wrap it and a paragraph's alignment aligns it); width/height are written as attributes (Outlook) and the width as CSS. */
export const EmailImage = Image.configure({ inline: true, allowBase64: false }).extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => px(el.getAttribute("width")) ?? px((el as HTMLElement).style?.width),
        renderHTML: (attrs) => (px(attrs.width) ? { width: px(attrs.width)!, style: `width:${px(attrs.width)}px;max-width:100%;height:auto` } : {}),
      },
      height: {
        default: null,
        parseHTML: (el) => px(el.getAttribute("height")),
        renderHTML: (attrs) => (px(attrs.height) ? { height: px(attrs.height)! } : {}),
      },
    };
  },
});

export type CtaAttrs = { href: string; label: string; align: "left" | "center" | "right"; bg: string; color: string };

/** A call-to-action button. It is a TABLE with a coloured cell around a link: the one construction every email client (Outlook included) shows as a button. */
export const CtaButton = Node.create({
  name: "ctaButton",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      href: { default: "" },
      label: { default: "Button" },
      align: { default: "center" },
      bg: { default: "#1d4ed8" },
      color: { default: "#ffffff" },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'table[data-compass-block="button"]',
        getAttrs: (el) => {
          const table = el as HTMLElement;
          const a = table.querySelector("a");
          const td = table.querySelector("td");
          const align = table.getAttribute("align");
          return {
            href: a?.getAttribute("href") ?? "",
            label: a?.textContent?.trim() || "Button",
            align: align === "left" || align === "right" ? align : "center",
            bg: safeHex(td?.getAttribute("bgcolor"), "#1d4ed8"),
            color: safeHex(a?.style?.color && rgbToHex(a.style.color), "#ffffff"),
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const { href, label, align, bg, color } = node.attrs as CtaAttrs;
    const background = safeHex(bg, "#1d4ed8");
    const text = safeHex(color, "#ffffff");
    const side = align === "left" || align === "right" ? align : "center";
    return [
      "table",
      mergeAttributes({ "data-compass-block": "button", role: "presentation", align: side, cellpadding: "0", cellspacing: "0", border: "0", style: side === "center" ? "margin:0 auto 16px" : "margin:0 0 16px" }),
      [
        "tbody",
        [
          "tr",
          [
            "td",
            { bgcolor: background, style: `border-radius:6px;background-color:${background}` },
            ["a", { href: href || "#", style: `display:inline-block;padding:12px 28px;font-size:15px;font-weight:700;line-height:1.2;color:${text};text-decoration:none;border-radius:6px` }, label || "Button"],
          ],
        ],
      ],
    ];
  },
});

/** "rgb(29, 78, 216)" (what a browser reports for a style colour) -> "#1d4ed8"; a hex value is returned as it is; anything else is not a colour we trust. */
function rgbToHex(value: string): string | null {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  const m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(value.trim());
  if (!m) return null;
  return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
}

/** A block of empty vertical space (8 to 80 pixels), made of the spacer every email client respects: a div with a fixed line height. */
export const Spacer = Node.create({
  name: "spacer",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return { height: { default: 24 } };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-compass-block="spacer"]',
        getAttrs: (el) => {
          const h = Number(px((el as HTMLElement).style?.height));
          return { height: h >= 8 && h <= 80 ? h : 24 };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const h = Math.min(80, Math.max(8, Number(node.attrs.height) || 24));
    return ["div", { "data-compass-block": "spacer", style: `height:${h}px;line-height:${h}px;font-size:1px` }, " "];
  },
});

/** The full set. `Link` and `Underline` come with StarterKit (v3); colours, highlight (background colour), size and line spacing come from the text-style kit. */
export function emailEditorExtensions() {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer" } } }),
    TextStyleKit.configure({ fontFamily: false }),
    TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right"] }),
    EmailImage,
    CtaButton,
    Spacer,
  ];
}
