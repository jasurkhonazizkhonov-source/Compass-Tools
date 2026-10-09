# Cloudflare Workers deployment (OpenNext) — status, setup and known blockers

The CRM can be built for **Cloudflare Workers** with the OpenNext Cloudflare adapter (`@opennextjs/cloudflare`). The Vercel deployment
(`vercel.json`, `scripts/vercel-build.mjs`) is unchanged and remains the production system; nothing here changes DNS or routing.

> **Status (verified 2026-10-09): the Worker builds and boots, and the public pages work, but the authenticated CRM does NOT run on
> Workers yet** — see [Known blockers](#known-blockers-the-crm-does-not-work-on-workers-yet). Do not point `www.compass-tools.com`
> at the Worker until they are resolved and re-verified.

## What was wrong with the first Cloudflare build

Wrangler found no Worker configuration, so it tried to auto-migrate the project (`npm install` of the OpenNext adapter **outside the
lockfile**). That fresh resolution requested `@aws-sdk/credential-provider-http@^3.972.75`, which the registry mirror used by the
build did not yet serve (`ETARGET`). The committed lockfile never asked for it (it pins `3.972.74`; a clean `npm ci` from it succeeds).
The fix is to commit the adapter, Wrangler and the configuration, pinned and locked, so the build is a plain `npm ci` plus an explicit
build — no auto-migration and no unpinned resolution.

## What was wrong with the second Cloudflare build

With the configuration committed, the dashboard still ran its default **Build command `npm run build`** (a plain `next build`) and then
**Deploy command `npx wrangler deploy`**. Wrangler detects an OpenNext project and delegates to `opennextjs-cloudflare deploy`, which
needs the output of `opennextjs-cloudflare build` (`.open-next/`, in particular `.open-next/.build/open-next.config.edge.mjs`). A plain
`next build` does not create it, so the deploy failed with `Could not find compiled Open Next config, did you run the build command?`.

The same plain build is also why the log said `APP_BASE_URL` was missing: the build step only sees Workers Builds **build variables**,
not the Worker's runtime `vars`, so the origin silently fell back to `http://localhost:3000`.

Fix (in the repository, so it works with the dashboard's default settings): `npm run build` is now `scripts/build.mjs`, which runs the
full OpenNext Cloudflare build (`scripts/cloudflare-build.mjs`, including the `APP_BASE_URL` default) when Workers Builds sets
`WORKERS_CI`, and a plain `next build` everywhere else. The adapter's own inner Next build is pinned to `npx next build`
(`open-next.config.ts` `buildCommand`) so the two cannot call each other. Vercel is unaffected (`vercel-build` calls `npx next build`).
Setting the Build command to `npm run cf:build` is equivalent and remains the explicit form.

## What was wrong with the third Cloudflare build

The build now reached server bundling and failed with `Could not resolve "pg-cloudflare"` at
`.open-next/server-functions/default/node_modules/pg/lib/stream.js:41`, noting that `pg-cloudflare/package.json` points to
`./dist/index.js`, which was missing from the copied package.

* The installed package is complete (`pg-cloudflare@1.4.0`, an *optional* dependency of `pg@8.23.0`; lockfile consistent). It ships two
  builds chosen by export condition: `workerd` → the real socket implementation (`dist/index.js`, `esm/index.mjs`), anything else →
  `dist/empty.js`.
* Next traces files with the Node conditions, so OpenNext's copy of the package contained only `dist/empty.js` plus the original
  `package.json`. The Worker is bundled by esbuild with the `workerd` condition, which wants `dist/index.js` → unresolved.
* It did not fail on Windows because there Next's external-package link (`.next/standalone/.next/node_modules/pg-<hash>`) is absolute and
  points back at the complete project `node_modules/pg`; on Linux it is relative and lands on the incomplete traced copy.
* Fix: OpenNext's own mechanism for packages with a `workerd` condition — it copies the whole package (with a `workerd`-only
  `exports`) when the package is listed in Next's `serverExternalPackages`. `next.config.ts` lists `pg-cloudflare` there **for Cloudflare
  builds only** (`CLOUDFLARE_BUILD=1`); the Vercel/Node build is byte-for-byte unaffected. It is not marked external in the Worker bundle,
  stubbed, or suppressed: the bundle inlines the real implementation (`CloudflareSocket`, using `connect()` from `cloudflare:sockets`).
* Verification: reproduced on Windows by making the standalone link relative (the Linux layout); the failure appeared exactly as reported
  and disappeared with the fix. **This only proves the Worker bundles** — whether it can talk to the database is a separate question (see
  the known blockers below).

## What is committed

| File | Purpose |
| --- | --- |
| `wrangler.jsonc` | Worker `compass-tools`, entry `.open-next/worker.js`, `nodejs_compat`, assets binding, self-reference service, **non-secret** `vars.APP_BASE_URL` |
| `open-next.config.ts` | Default `defineCloudflareConfig()` (no R2 incremental cache: the CRM is dynamic; static pages are built once) |
| `scripts/build.mjs` | `npm run build`: the OpenNext Cloudflare build when `WORKERS_CI` is set (Workers Builds), plain `next build` otherwise |
| `scripts/cloudflare-build.mjs` | Build entry point (`npm run cf:build`): fixes `APP_BASE_URL` for the static pages, flags the build as a Workers build, runs `opennextjs-cloudflare build` |
| `src/lib/cloudflare/sharp-unavailable.ts` | Stub for the native `sharp` addon, aliased in **only** when `CLOUDFLARE_BUILD=1` (see `next.config.ts`) |
| `public/_headers` | Long-lived caching for `/_next/static/*` |
| `package.json` / `package-lock.json` | `next@16.3.8`, `@opennextjs/cloudflare@1.20.10`, `wrangler@4.149.0` (exact versions) and scripts `cf:build`, `cf:preview`, `cf:deploy`, `cf:dry-run` |

**Versions.** `@opennextjs/cloudflare@1.20.10` requires `next >= 16.3.8` (its peer range moves up with Next security releases), so Next
moved from 16.3.1 to 16.3.8 — a patch release; the full test suite and the normal build pass on it.

## Cloudflare dashboard (Workers Builds) — manual settings

Worker `compass-tools` → **Settings → Build**:

* **Build command:** `npm run cf:build` (the dashboard default `npm run build` now does the same inside Workers Builds)
* **Deploy command:** `npx wrangler deploy` (delegates to `opennextjs-cloudflare deploy`; `npm run cf:deploy` is equivalent). It must run
  **after** the build command in the same build — the deploy step reads `.open-next/` produced by the build.
* **Root directory:** repository root. **Production branch:** `main`.
* Node: the build image's default (Node 22+) is fine. Dependencies install with `npm ci` from the committed lockfile.

### Environment variables

| Variable | Where | Value |
| --- | --- | --- |
| `APP_BASE_URL` | already in `wrangler.jsonc` `vars` (runtime) and read from it by `cf:build` (build time) | `https://www.compass-tools.com` — a Workers Builds **build variable** with the same name overrides it |
| `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CRON_SECRET`, `CARD_ENCRYPTION_KEY`, `GMAIL_TOKEN_ENCRYPTION_KEY`, `IP_ENCRYPTION_KEY`, `IP_HASH_KEY`, `LEAD_INGEST_SECRET`, `CARD_VAULT_MODE`, `R2_*`, … | Worker → Settings → **Variables and Secrets** (runtime). Mark secrets as *Secret*. **Copy them from Vercel; they are not shared.** Use the **same** key values (re-generating an encryption key makes stored data unreadable). | see `.env.example` / `docs/DEPLOYMENT.md` |

Secrets are never written to `wrangler.jsonc` or the repository. To keep dashboard-set variables across deploys use
`npx wrangler deploy --keep-vars`.

## Known blockers (the CRM does not work on Workers yet)

Verified by running the built Worker locally in `workerd` (`npm run cf:preview`) — public pages, images, sitemap, robots, the cron
auth gate and the signed-out attachment route all behave correctly (200 / 401), but:

1. **Prisma's query compiler cannot start.** The generated client compiles its WebAssembly from bytes at runtime
   (`new WebAssembly.Module(...)`), which Workers forbid (`CompileError`; `/api/health` reports `database.ok:false`). Workers need the
   generator's `runtime = "workerd"` build (precompiled `.wasm` module). Changing the generator affects the Vercel build too, so it
   needs a deliberate, separately tested change.
2. **One Prisma client / `pg` pool shared across requests.** `src/lib/prisma.ts` keeps a process-wide singleton. A Worker may not
   reuse an I/O object (socket) created by another request; OpenNext's guidance is a **per-request client with `maxUses: 1`**, ideally
   through **Hyperdrive**. This is a database-layer change and was deliberately not made here.
3. **Database TLS.** The default connection is "encrypted, not identity-verified" (`rejectUnauthorized: false`) and Aiven certificates
   are signed by a project CA. Workers' TLS sockets validate against the system trust store and cannot take a custom CA, so connecting
   to Aiven directly is unlikely to work; **Hyperdrive** (which holds the CA) is the supported route.
4. **Route protection.** `src/proxy.ts` (the session gate and nonce-CSP provider) is a Node-runtime proxy. OpenNext reports "Node.js
   middleware support is experimental in cloudflare", and in the local run every proxied route (`/dashboard`, `/leads`, …) answered
   500 (`Error in routingHandler: Method Promise.prototype.then called on incompatible receiver`). Until that is resolved the Worker
   cannot enforce the sign-in redirect — **it must not receive production traffic.**
5. **Worker size.** The built Worker is ≈ 43 MB uncompressed / **≈ 10.2 MiB gzip** (Wrangler dry run). That is just under the Workers
   Paid limit (10 MiB) and far over the Free plan limit (3 MiB): the Worker **requires the Workers Paid plan** and has almost no
   headroom — any growth in dependencies can break the deploy.
6. **Company logo processing** uses the native `sharp` addon, which a Worker cannot load. On Workers the logo-upload action reports an
   error and a company with no uploaded logo gets none in its emails (the fallback path already degrades to "no logo"). Uploaded logos
   already stored in the database keep working.

None of these affect Vercel. They are listed so the cut-over decision is made on facts: the work needed is (1)–(4), most likely
"Prisma `workerd` runtime + Hyperdrive + per-request client + a Workers-safe replacement for the Node proxy".

## Local commands

```
npm run cf:build     # Workers build -> .open-next/   (APP_BASE_URL taken from wrangler.jsonc when unset)
npm run cf:dry-run   # wrangler deploy --dry-run: validates wrangler.jsonc and bundles; prints the gzip size
npm run cf:preview   # build + run the Worker locally in workerd (put test-only values in .dev.vars — git-ignored)
```

OpenNext warns that Windows is not fully supported; the Cloudflare build image is Linux. `.open-next/`, `.wrangler/` and `.dev.vars`
are git-ignored.

## Cut-over (separate step, needs explicit approval)

Only after the blockers above are resolved and the Worker's own `*.workers.dev` URL passes a full authenticated check (sign-in, a lead,
a quote, an attachment upload, the cron routes with the real `CRON_SECRET`): add the custom domain in Cloudflare, keep Vercel as the
fallback, and run database migrations from the Vercel pipeline (`scripts/vercel-build.mjs` runs `prisma migrate deploy`; the Workers
build deliberately does **not**).
