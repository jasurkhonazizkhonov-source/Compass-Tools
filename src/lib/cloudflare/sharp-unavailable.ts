// Stand-in for the `sharp` image library in CLOUDFLARE WORKERS builds only (next.config.ts aliases `sharp` to this file when
// CLOUDFLARE_BUILD=1, which scripts/cloudflare-build.mjs sets). sharp is a native Node addon: a Worker cannot load it, and OpenNext's
// bundler cannot inline its ESM files (the build fails). The Vercel / Node build never sees this file.
//
// The only callers are src/lib/logo-processing.ts (company logo upload and the bundled fallback email logo). Both already handle a
// rejection: the fallback-logo path resolves to "no logo" and the upload action reports an error, so on Workers those two features
// degrade instead of the whole app failing to build. See docs/CLOUDFLARE_DEPLOYMENT.md.
export default function sharp(): never {
  throw new Error("Image processing is not available on this deployment platform.");
}
