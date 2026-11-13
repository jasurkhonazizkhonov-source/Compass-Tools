import { NextResponse } from "next/server";
import { getHealth } from "@/lib/health-check";
import { hasValidCronSecret } from "@/server/security/cron-auth";

// Liveness + database-latency probe for uptime monitors, the Docker HEALTHCHECK and diagnosing "This page couldn't load" reports.
//
// The PUBLIC answer is deliberately minimal: a generic status ({ "status": "ok" | "down" }) and the HTTP code (200 / 503) - everything a load
// balancer, monitor or container health check needs, and nothing a stranger could use to map the deployment. The detailed report (database
// timings, pool occupancy, and the readiness categories: card-vault state and key version, database TLS mode, schema/migration status, upload
// storage, which integrations are configured, the environment) is returned only to a caller that presents the internal CRON_SECRET as a Bearer
// token - the same secret the deploy scripts already read inside the container for the cron endpoints. Staff see the same facts in the signed-in
// System Health page. See src/lib/health-check.ts for what the detailed report does and (deliberately) does not expose.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request?: Request) {
  const { body, status } = await getHealth();
  const headers = { "Cache-Control": "no-store" };
  if (request && hasValidCronSecret(request)) return NextResponse.json(body, { status, headers });
  return NextResponse.json({ status: body.status }, { status, headers });
}
