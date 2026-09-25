import { NextResponse } from "next/server";
import { getHealth } from "@/lib/health-check";

// Public, unauthenticated liveness + database-latency probe for uptime
// monitors and for diagnosing "This page couldn't load" reports — see
// src/lib/health-check.ts for what it does and (deliberately) does not expose.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const { body, status } = await getHealth();
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
