import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Default is 1MB, which a real-world Bulk Subscriber paste can
      // exceed (e.g. a messy multi-thousand-row Excel copy with extra
      // whitespace/columns) — Next then rejects the request at the
      // framework level before it ever reaches previewBulkSubscribers/
      // createBulkSubscribers (src/server/actions/subscribers.ts), which
      // the client can't parse as a normal action result and reports as
      // the generic "An unexpected response was received from the
      // server." Raised generously (well beyond MAX_BULK_SUBSCRIBERS'
      // 2000-email application-level ceiling) rather than just past
      // today's reported failure size.
      bodySizeLimit: "5mb",
    },
  },
};

export default nextConfig;
