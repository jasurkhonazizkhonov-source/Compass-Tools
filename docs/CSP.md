# Content-Security-Policy: what is enforced, what is still allowed, and why

Code: `src/lib/csp.ts` (the policies), `src/proxy.ts` (which routes get which), `next.config.ts` (the policy for everything else), `src/lib/csp-nonce-client.ts`
and `src/components/csp-nonce-provider.tsx` (handing the nonce to the few libraries that need it). Tests: `src/__tests__/csp-nonce.test.ts`,
`src/__tests__/security-headers.test.ts`, `src/__tests__/proxy.test.ts`.

A CSP stops **injected** script and style from running (the way a cross-site-scripting bug would read a card number as it is typed). It does not stop a compromised
dependency that is already trusted, and it is not a substitute for escaping output.

## Two policies

| | Routes | Scripts | Style elements | Style attributes |
|---|---|---|---|---|
| **Nonce policy** (per request) | every signed-in CRM page, `/quote/*` (card entry), `/`, `/access-denied` | `'self' 'nonce-…' 'strict-dynamic'` — **no `'unsafe-inline'`, no `'unsafe-eval'`** in production | `'self' 'nonce-…'` + the hash of sonner's stylesheet | `'unsafe-inline'` |
| **Nonce policy, sign-in page** | `/login` | same as above | `'self' 'unsafe-inline' https://accounts.google.com` (**exception 2**) | `'unsafe-inline'` |
| **Hash policy** (static pages, written after the build) | the 13 pre-rendered marketing pages (`/about`, `/contact`, `/features/*`, `/privacy`, `/security`, `/terms`) | `'self'` + the SHA-256 of each of that page's inline scripts + Google - **no `'unsafe-inline'`** (`scripts/static-page-csp.mjs`) | `'self'` + sonner hash + Google | `'unsafe-inline'` |
| **Base policy** | everything else: API routes, error pages, and the marketing pages when the post-build step could not run (Cloudflare/Vercel builds) | `'self' 'unsafe-inline' https://accounts.google.com` (**exception 1**) | `'self'` + sonner hash + Google | `'unsafe-inline'` |

Everything else is the same in both: `default-src 'self'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`,
`img-src 'self' data: https:`, `connect-src 'self'` + Google, `frame-src https://accounts.google.com`. No wildcards, no payment provider, no analytics host.

## What changed on 2026-11-24 (continuation pass)

* **`style-src` no longer allows `'unsafe-inline'` for style *elements*** on the CRM, card-entry and marketing pages. Style *attributes* moved to their own directive,
  `style-src-attr 'unsafe-inline'`. An injected `<style>` block (CSS attribute selectors can read page content) is now refused; an attribute cannot contain selectors.
* Two sources of `<style>` elements were made compatible instead of loosening the policy again:
  * **TipTap** (the email editor) adds one `<style>` with its base styles: it now gets the page nonce (`injectNonce`).
  * **The theme switch** briefly disabled transitions with a `<style>` element: it now uses a constructable stylesheet (`adoptedStyleSheets`), which a CSP does not govern,
    with a nonce'd `<style>` fallback for browsers without it.
  * **Radix** (dialogs, menus, selects, popovers) locks page scroll behind a modal with a `<style>` made by `react-remove-scroll-bar`; it asks the `get-nonce` package for a
    nonce. `CspNonceProvider` (root layout) gives it this page's nonce once at start-up. `get-nonce` is now an explicit dependency (it was already installed through Radix).
  * **Sonner** (toasts) injects one fixed stylesheet and offers no nonce option: that exact text is allowed by its SHA-256 (`SONNER_STYLE_HASH`). A test recomputes the hash
    from the installed package, so upgrading sonner fails that test with the new value instead of leaving toasts unstyled.
* `/` (marketing home) and `/access-denied` are rendered on every request, so they moved to the nonce policy (no `'unsafe-inline'` for scripts). The proxy only adds the
  header there; it never gates them (they do their own session check).
* A real browser run found one regression before release: with the strict style policy the Google sign-in button rendered as a giant logo with doubled text, because
  Google's script adds an inline `<style>` to the page (see exception 2).

## Remaining exceptions (each one is deliberate)

1. **Scripts on routes the build cannot hash: `'unsafe-inline'`** - API routes, error pages, and the marketing pages on a Cloudflare or Vercel build (which do not run the post-build step).
   The 13 pre-rendered marketing pages **no longer need it** (2026-11-25): Next.js writes its hydration data into inline `<script>` elements (`self.__next_f.push(...)`, the theme
   bootstrap), which cannot carry a per-request nonce on a page built at deploy time - but the HTML of a static page does not change between requests, so each inline script is
   allowed by its **SHA-256** instead. `scripts/static-page-csp.mjs` (run by `npm run build` after `next build`) hashes every executable inline script of every pre-rendered
   page and appends one rule per page to `.next/routes-manifest.json` (and the copy under `.next/standalone`); Next.js applies a later matching header rule over an earlier one, so the
   page rule replaces the base one. The pages stay static and CDN-cacheable. `'strict-dynamic'` is deliberately not used (it would make browsers ignore `'self'`, and the
   parser-inserted `<script src>` of a static page cannot carry a nonce), so the policy is hashes + `'self'`: an injected inline script no longer runs, but a script file from this
   same origin would. What it does not do: it fails open on purpose - if the step cannot run, the pages keep the base policy and the build says so (`[csp] static pages keep the base
   policy`); CI can pass `--require`. **Verified:** production build, 13 pages in a real browser: all hydrate, no violations, and an injected inline script is refused. **Not verified:**
   the Docker/standalone image (the script patches both manifests; run `curl -I` on `/about` against the real container and check `script-src` has hashes and no `'unsafe-inline'`).
   The other options considered: making the pages dynamic (nonce) costs CDN caching, so it was not needed; Next's experimental SRI covers script *files* only, so it does not help.
2. **Styles on `/login`: `'unsafe-inline'`.** Google's sign-in script adds its own inline `<style>` (about 8 KB, class names like `.qJTHM`) and cannot be given a nonce; its text is
   Google's and changes without notice, so it cannot be hash-pinned. (A nonce or hash in the same directive would make browsers ignore `'unsafe-inline'`, so this page's
   directive carries neither.) The page's **script** policy stays strict, and the page shows and accepts no customer data.
3. **Style attributes: `'unsafe-inline'`** (`style-src-attr`) everywhere. Radix/floating UI positions popovers and menus, charts and the editor set sizes and colours with them, and an
   attribute cannot carry a nonce. Declarations only: no selectors, no script, cannot read other elements.
4. **`'unsafe-eval'` in `next dev` only.** React's development build needs it; production and test builds never include it (tested).
5. **`img-src https:`.** Lead documents, company logos and email-editor image previews can point at any HTTPS host. Narrowing it would break the editor's image URLs.

## How it was checked

Production build (`next build` + `next start`), Chrome-based browser pane, Admin session on a seeded database:

* **No violations on:** `/login` (real Google script loaded, button rendered correctly), `/`, `/about`, `/features/leads`, `/contact`, `/access-denied`, `/dashboard`, `/leads`,
  `/quotes`, `/contacts`, `/bookings`, `/subscriptions`, `/system-health`, `/users`, `/database-backup`; an open New Lead dialog (page scroll is locked: `body` overflow `hidden`);
  the theme toggle through all three states; the global search (cmdk); the sequence step editor with TipTap (its style element carries the nonce and is applied). Page-load
  violations were read from the console; dialog, menu and theme interactions were observed with a `securitypolicyviolation` listener (an empty list).
* **Found and fixed from violations:** Google's button style (exception 2), Radix scroll lock (nonce provider), sonner (hash).
* **What a unit test cannot show, and this did:** every item in the list above was invisible to the mocked-component tests; only a real browser reported them.
* **Not checked here:** Safari and Firefox; a signed-in session of every role; email clients (the email templates are not pages under this policy).

To re-check after changing a library or adding a third-party origin: build, start, open the pages above, and in the page console run
`document.addEventListener('securitypolicyviolation', e => console.log(e.violatedDirective, e.blockedURI, e.sample))` **before** opening dialogs and menus (blocked styles added after
load are only reported to that event).
