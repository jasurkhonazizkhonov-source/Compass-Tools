// The public unsubscribe experience — one server-rendered, JavaScript-free HTML
// document used by every unsubscribe state (confirm, done, already unsubscribed,
// invalid link, rate limited, error) so they all look like one deliberate Compass
// Tools page instead of a bare box. It follows the same visual language as the
// premium email system (navy ink, restrained gold accent, serif headline, soft
// blue-grey page, white card) and works on its own: no scripts, no web fonts, no
// external requests — a self-contained document that any browser or webview
// renders, including the in-app browsers mail clients open links in.
//
// Hardening, because this page is public and reached through a secret token in
// the URL:
//   • Cache-Control: no-store and Referrer-Policy: no-referrer — the token never
//     leaks to another site and the page is never cached or shared;
//   • X-Robots-Tag: noindex — never listed by a search engine;
//   • a strict Content-Security-Policy: no script of any kind, forms may only post
//     back to this origin, nothing can frame the page;
//   • every dynamic value is HTML-escaped; the page never echoes a token, an id or
//     any internal detail — only a MASKED e-mail address and the company name.
import { escapeAttr, escapeHtml } from "@/server/email/design-system";
import { MAX_UNSUBSCRIBE_REASON_LENGTH, UNSUBSCRIBE_REASONS } from "@/lib/unsubscribe-reasons";

export type UnsubscribePageState =
  | {
      kind: "confirm";
      /** The route a confirmation POSTs back to. */
      action: string;
      /** Hidden form value that identifies the subscription (never shown). */
      tokenField: { name: string; value: string };
      maskedEmail?: string;
      /** Offer the optional reason fields (marketing only). */
      askReason: boolean;
      /** Re-rendered after a validation problem. */
      error?: string;
      draft?: { category?: string | null; text?: string | null };
      /** Heading / lead copy differ for the automated-sequence page. */
      variant?: "marketing" | "sequence";
    }
  | { kind: "done"; maskedEmail?: string; variant?: "marketing" | "sequence"; thanked?: boolean }
  | { kind: "already"; maskedEmail?: string; variant?: "marketing" | "sequence" }
  | { kind: "invalid" }
  | { kind: "missing" }
  | { kind: "rate-limited" }
  | { kind: "error" };

/** "jane.doe@example.com" → "j***@example.com". Never the full address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "your email address";
  const local = email.slice(0, at);
  return `${local[0]}***${email.slice(at)}`;
}

const NAVY = "#1c3a5e";
const GOLD = "#d4a24e";
const INK = "#0f1b2d";

const CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1f2937;background-color:#eef1f6;background-image:linear-gradient(180deg,#eef1f6 0%,#e2e8f1 100%);line-height:1.6}
.wrap{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px}
.brand{display:flex;align-items:center;gap:10px;margin:0 0 20px;color:${INK};font-weight:700;font-size:15px;letter-spacing:.01em;text-decoration:none}
.badge{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;background:#fff;border:1px solid #dde3ec;box-shadow:0 1px 2px rgba(15,27,45,.06)}
.card{width:100%;max-width:520px;background:#fff;border:1px solid #e2e5eb;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(15,27,45,.05),0 12px 32px rgba(15,27,45,.07)}
.bar{height:4px;background:${NAVY}}
.body{padding:36px 36px 32px}
h1{margin:0 0 10px;font-family:Georgia,"Times New Roman",Times,serif;font-size:27px;line-height:1.25;font-weight:700;color:${INK};letter-spacing:-.01em}
.lead{margin:0 0 18px;color:#4b5563;font-size:16px}
.note{margin:0 0 22px;padding:12px 14px;border-radius:10px;background:#f6f8fb;border:1px solid #e6e9ef;color:#4b5563;font-size:14px}
.rule{width:44px;height:2px;background:${GOLD};margin:0 0 20px;border:0}
fieldset{margin:0 0 18px;padding:0;border:0}
legend{padding:0;margin:0 0 8px;font-weight:600;font-size:15px;color:${INK}}
.opt{font-weight:400;color:#4b5563}
.choice{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;margin:0 0 6px;border:1px solid #dde3ec;border-radius:10px;cursor:pointer;font-size:15px;background:#fff}
.choice:hover{border-color:#b9c4d4;background:#fafbfd}
.choice input{margin:3px 0 0;width:17px;height:17px;accent-color:${NAVY};flex:none}
label.field{display:block;margin:0 0 6px;font-weight:600;font-size:15px;color:${INK}}
textarea{display:block;width:100%;min-height:96px;padding:11px 12px;border:1px solid #c7cfdb;border-radius:10px;font:inherit;font-size:15px;color:#1f2937;background:#fff;resize:vertical}
.hint{margin:6px 0 0;font-size:13px;color:#4b5563}
.error{margin:0 0 18px;padding:12px 14px;border-radius:10px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;font-size:14px}
.btn{display:block;width:100%;margin:22px 0 0;padding:14px 20px;border:0;border-radius:10px;background:${NAVY};color:#fff;font:inherit;font-size:16px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
.btn:hover{background:#17304f}
.fine{margin:14px 0 0;font-size:13px;color:#4b5563;text-align:center}
.icon{display:flex;align-items:center;justify-content:center;width:52px;height:52px;margin:0 0 18px;border-radius:50%}
.icon.ok{background:#ecfdf5;border:1px solid #a7f3d0}
.icon.neutral{background:#f1f5f9;border:1px solid #dde3ec}
:focus-visible{outline:3px solid #7aa2d6;outline-offset:2px}
.foot{margin:22px 0 0;font-size:12px;color:#4b5563;text-align:center}
@media (max-width:480px){.body{padding:28px 20px 24px}h1{font-size:24px}.wrap{padding:20px 12px;justify-content:flex-start}.brand{margin-top:8px}}
`;

const MARK = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><polygon points="8.75,3.07 7.77,13.54 15.25,20.93" fill="${NAVY}"/><polygon points="8.75,3.07 16.23,10.46 15.25,20.93" fill="${GOLD}"/><circle cx="12" cy="12" r="1.4" fill="#fff"/></svg>`;
const CHECK = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const INFO = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>`;

// The page is the Compass Tools product's own, so it names no sender or agency: the message the customer
// clicked from already says who it was from, and the copy says "this sender".
function who(maskedEmail?: string, verb = "will no longer receive marketing emails"): string {
  const from = " from this sender";
  const addr = maskedEmail ? `<strong>${escapeHtml(maskedEmail)}</strong>` : "This address";
  return `${addr} ${verb}${from}.`;
}

function bodyFor(state: UnsubscribePageState): { title: string; status: number; html: string } {
  switch (state.kind) {
    case "confirm": {
      const sequence = state.variant === "sequence";
      const reasonBlock = state.askReason
        ? `<fieldset>
        <legend>Why are you unsubscribing? <span class="opt">(Optional)</span></legend>
        ${UNSUBSCRIBE_REASONS.map(
          (r) =>
            `<label class="choice"><input type="radio" name="reason" value="${escapeAttr(r.value)}"${state.draft?.category === r.value ? " checked" : ""}><span>${escapeHtml(r.label)}</span></label>`
        ).join("")}
      </fieldset>
      <label class="field" for="comment">Anything you'd like to add? <span class="opt">(Optional)</span></label>
      <textarea id="comment" name="comment" maxlength="${MAX_UNSUBSCRIBE_REASON_LENGTH}" placeholder="Your comments help us send you better, more relevant email.">${escapeHtml(state.draft?.text ?? "")}</textarea>
      <p class="hint">You don't have to answer — you can unsubscribe without telling us why.</p>`
        : "";
      return {
        title: sequence ? "Stop these emails" : "Unsubscribe from marketing emails",
        status: state.error ? 400 : 200,
        html: `<h1>${sequence ? "Stop these automated emails" : "Unsubscribe from marketing emails"}</h1>
      <hr class="rule">
      <p class="lead">${
        sequence
          ? "Confirm below and you will stop receiving these automated follow-up emails."
          : `${state.maskedEmail ? `<strong>${escapeHtml(state.maskedEmail)}</strong> will` : "You will"} stop receiving marketing emails from this sender.`
      }</p>
      <p class="note">${
        sequence
          ? "This stops automated follow-up messages only. You can still reply to your travel agent directly."
          : "This only affects marketing emails. Personal replies from your travel agent and messages about your quotes or bookings are separate and aren't affected."
      }</p>
      ${state.error ? `<p class="error" role="alert">${escapeHtml(state.error)}</p>` : ""}
      <form method="post" action="${escapeAttr(state.action)}">
        <input type="hidden" name="${escapeAttr(state.tokenField.name)}" value="${escapeAttr(state.tokenField.value)}">
        ${reasonBlock}
        <button class="btn" type="submit">Unsubscribe</button>
        <p class="fine">Nothing changes until you confirm. If you didn't mean to, simply close this page.</p>
      </form>`,
      };
    }
    case "done":
      return {
        title: "You're unsubscribed",
        status: 200,
        html: `<div class="icon ok">${CHECK}</div>
      <h1>You're unsubscribed</h1>
      <hr class="rule">
      <p class="lead" role="status">${state.variant === "sequence" ? "You will no longer receive these automated emails. If you'd still like to hear from your travel agent directly, feel free to reply to any of their previous emails." : who(state.maskedEmail)}</p>
      ${state.variant === "sequence" ? "" : `<p class="note">${state.thanked ? "Thank you for your feedback — it helps us improve. " : ""}This only affects marketing emails. Personal replies from your travel agent and messages about your quotes or bookings are separate and aren't affected.</p>`}`,
      };
    case "already":
      return {
        title: "You're already unsubscribed",
        status: 200,
        html: `<div class="icon ok">${CHECK}</div>
      <h1>You're already unsubscribed</h1>
      <hr class="rule">
      <p class="lead" role="status">${state.variant === "sequence" ? "These automated emails have already been stopped." : who(state.maskedEmail, "is already unsubscribed and will not receive marketing emails")}</p>
      <p class="note">There's nothing more you need to do.</p>`,
      };
    case "missing":
      return {
        title: "This link is incomplete",
        status: 400,
        html: `<div class="icon neutral">${INFO}</div>
      <h1>This link is incomplete</h1>
      <hr class="rule">
      <p class="lead">The unsubscribe link looks like it was cut short. Please use the unsubscribe link in the original email.</p>`,
      };
    case "invalid":
      return {
        title: "This link is no longer valid",
        status: 404,
        html: `<div class="icon neutral">${INFO}</div>
      <h1>This link is no longer valid</h1>
      <hr class="rule">
      <p class="lead">We couldn't find a subscription for this link — it may have expired or been replaced.</p>
      <p class="note">If you're still receiving emails you don't want, reply to one of them and we'll take care of it.</p>`,
      };
    case "rate-limited":
      return {
        title: "Please try again shortly",
        status: 429,
        html: `<div class="icon neutral">${INFO}</div>
      <h1>Please try again shortly</h1>
      <hr class="rule">
      <p class="lead">There have been a lot of requests from this connection. Please wait a few minutes and try again.</p>`,
      };
    case "error":
      return {
        title: "Something went wrong",
        status: 500,
        html: `<div class="icon neutral">${INFO}</div>
      <h1>Something went wrong</h1>
      <hr class="rule">
      <p class="lead">We couldn't complete that just now. Nothing has been changed — please try again in a moment.</p>`,
      };
  }
}

export function renderUnsubscribePage(state: UnsubscribePageState): { html: string; status: number } {
  const { title, status, html } = bodyFor(state);
  return {
    status,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} — Compass Tools</title>
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
  <div class="brand" aria-label="Compass Tools"><span class="badge">${MARK}</span><span>Compass Tools</span></div>
  <section class="card" aria-labelledby="page-title">
    <div class="bar"></div>
    <div class="body" id="page-title-wrap">
      ${html.replace("<h1>", '<h1 id="page-title">')}
    </div>
  </section>
  <p class="foot">Email preferences</p>
</main>
</body>
</html>`,
  };
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function unsubscribeResponse(state: UnsubscribePageState, extraHeaders: Record<string, string> = {}): Response {
  const { html, status } = renderUnsubscribePage(state);
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": CSP,
      ...extraHeaders,
    },
  });
}
