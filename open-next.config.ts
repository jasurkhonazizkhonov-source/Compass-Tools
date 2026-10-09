import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Default Cloudflare configuration. No R2 incremental cache: the CRM is dynamic and the few static pages are built once, so
// there is nothing to revalidate into a cache.
//
// `buildCommand`: the adapter runs the project's Next build itself. By default that is `npm run build`, which in a Workers Builds
// environment is the OpenNext build (scripts/build.mjs) — that would call itself. Pinning the plain Next build breaks the loop.
const config = {
  ...defineCloudflareConfig(),
  buildCommand: "npx next build",
};

export default config;
