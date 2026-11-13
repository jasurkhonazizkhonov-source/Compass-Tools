import sanitizeHtml from "sanitize-html";

/**
 * The server-side trust boundary for a marketing campaign's HTML (MarketingCampaign.htmlContent).
 *
 * Campaign HTML is typed or pasted by a CRM user, but it is rendered in two sensitive places - the signed-in CRM's own preview, and the email that
 * goes to every subscriber - and pasted markup can carry anything (a script from a copied web page, an inline event handler, a javascript: link,
 * a form that posts somewhere else). It is therefore cleaned on the SERVER with a maintained, parser-based sanitizer (sanitize-html, which uses the
 * htmlparser2 tokenizer, decodes entities before judging a URL, and rebuilds the markup from an allow-list), never with regular expressions and never
 * only in the browser. Anything not on the allow-list is dropped; what remains is rebuilt, well-formed, from the allow-list alone.
 *
 * What is KEPT (the HTML email authors actually use): paragraphs, headings, lists, bold/italic/underline, links (http, https, mailto, tel), images
 * (http, https and small inline base64 raster images), tables with their layout attributes (width, align, cellpadding, bgcolor ...), div/span,
 * and inline CSS for typography, colour, spacing, borders and sizing.
 *
 * What is REMOVED: <script>, <style> blocks, <iframe>/<object>/<embed>, <form> and form controls, <svg>/<math>, <meta>/<link>/<base>, event-handler
 * attributes (onclick, onerror ...), javascript:/data:/vbscript: links, CSS that can fetch or execute (url(), expression(), behavior, @import),
 * position/z-index (an email must not paint over its own footer or the CRM page) and every attribute not listed below. Plain <style> blocks are
 * dropped on purpose: email clients strip or rewrite them anyway, so authors inline their CSS, which is kept.
 *
 * The function is pure and idempotent (sanitising its own output changes nothing), so it is safe to apply at save time, at preview time and at send
 * time. Records saved before this existed are not rewritten; they are cleaned when they are previewed or sent.
 */

const SAFE_CSS_VALUE = /^(?![\s\S]*(?:url\s*\(|expression\s*\(|javascript:|vbscript:|behavior|-moz-binding|@import|\\))[\s\S]{1,200}$/i;
const any = [SAFE_CSS_VALUE];

const ALLOWED_STYLES: Record<string, Record<string, RegExp[]>> = {
  "*": {
    color: any,
    "background-color": any,
    background: any, // url() is excluded by SAFE_CSS_VALUE, so only colours / gradients without a URL remain
    "font-family": any,
    "font-size": any,
    "font-style": any,
    "font-weight": any,
    "line-height": any,
    "letter-spacing": any,
    "text-align": any,
    "text-decoration": any,
    "text-transform": any,
    "text-indent": any,
    "vertical-align": any,
    "white-space": any,
    "word-break": any,
    "word-wrap": any,
    "overflow-wrap": any,
    margin: any,
    "margin-top": any,
    "margin-right": any,
    "margin-bottom": any,
    "margin-left": any,
    padding: any,
    "padding-top": any,
    "padding-right": any,
    "padding-bottom": any,
    "padding-left": any,
    border: any,
    "border-top": any,
    "border-right": any,
    "border-bottom": any,
    "border-left": any,
    "border-color": any,
    "border-style": any,
    "border-width": any,
    "border-radius": any,
    "border-collapse": any,
    "border-spacing": any,
    width: any,
    height: any,
    "max-width": any,
    "min-width": any,
    "max-height": any,
    "min-height": any,
    display: [/^(?:block|inline|inline-block|table|table-cell|table-row|none)$/i],
    "list-style-type": any,
    "list-style-position": any,
  },
};

const TABLE_LAYOUT = ["width", "height", "align", "valign", "bgcolor", "border", "cellpadding", "cellspacing", "role", "style"];

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const MAX_INLINE_IMAGE_CHARS = 300_000;

export function sanitizeCampaignHtml(dirty: string): string {
  if (!dirty) return "";
  return sanitizeHtml(dirty, {
    allowedTags: [
      "p", "br", "hr", "div", "span", "center",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "strong", "b", "em", "i", "u", "s", "strike", "small", "sup", "sub", "mark",
      "blockquote", "pre", "code",
      "ul", "ol", "li",
      "a", "img",
      "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
    ],
    allowedAttributes: {
      "*": ["style", "title", "dir", "lang", "align"],
      a: ["href", "target", "rel", "name", "title", "style"],
      img: ["src", "alt", "width", "height", "title", "style", "align", "border"],
      table: TABLE_LAYOUT,
      thead: TABLE_LAYOUT,
      tbody: TABLE_LAYOUT,
      tfoot: TABLE_LAYOUT,
      tr: ["align", "valign", "bgcolor", "height", "style"],
      td: [...TABLE_LAYOUT, "colspan", "rowspan", "nowrap"],
      th: [...TABLE_LAYOUT, "colspan", "rowspan", "nowrap", "scope"],
      col: ["width", "span", "style"],
      colgroup: ["width", "span", "style"],
      ol: ["start", "type", "style"],
      li: ["value", "style"],
    },
    allowedStyles: ALLOWED_STYLES,
    // Link/image URLs: only these schemes survive. javascript:, vbscript:, data: (on links), file: ... are removed together with the attribute.
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    // The text inside these is never useful as page text; <script>/<style> content must not leak out as visible text either.
    nonTextTags: ["script", "style", "textarea", "option", "title", "noscript", "template"],
    transformTags: {
      a: (tagName, attribs) => {
        const next = { ...attribs };
        if (next.target && next.target !== "_blank") delete next.target;
        if (next.target === "_blank") next.rel = "noopener noreferrer";
        else delete next.rel;
        return { tagName, attribs: next };
      },
      img: (tagName, attribs) => {
        const next = { ...attribs };
        // data: is permitted on <img> only for small raster images; anything else (an SVG document, text/html, an oversized blob) loses its src.
        if (next.src && /^\s*data:/i.test(next.src) && (!DATA_IMAGE.test(next.src.trim()) || next.src.length > MAX_INLINE_IMAGE_CHARS)) delete next.src;
        return { tagName, attribs: next };
      },
    },
    // An <img> with no usable source is meaningless; drop it rather than leave an empty tag.
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
}
