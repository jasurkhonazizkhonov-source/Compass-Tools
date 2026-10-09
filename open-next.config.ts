import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Default OpenNext Cloudflare configuration. No R2 incremental cache is configured on purpose: the CRM's pages are dynamic
// (per-user, `force-dynamic`) and the few static marketing pages are fully generated at build time, so nothing needs
// on-demand revalidation. Add an incrementalCache override here only if ISR is ever introduced.
export default defineCloudflareConfig();
