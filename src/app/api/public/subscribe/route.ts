import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { notifyNewSubscriber } from "@/server/admin-notifications";
import { checkPublicRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";

// Part 10 — the public company website's newsletter/marketing signup form
// posts here. Same unauthenticated, companyId-required pattern as
// /api/public/contact-inquiry (see that route's comment for why companyId
// must be explicit in a multi-tenant app with no other trustworthy signal).
const subscribeSchema = z.object({
  companyId: z.string().min(1),
  email: z.string().email(),
  source: z.string().max(100).optional(),
});

export async function POST(req: Request) {
  // Pass 26 §35 — public-endpoint rate limiting, same pattern as
  // lead-capture's own route (see its comment).
  const rateLimitCheck = await checkPublicRateLimit(req.headers, "SUBSCRIBE", RATE_LIMITS.SUBSCRIBE);
  if (!rateLimitCheck.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many requests from this connection. Please wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(rateLimitCheck.retryAfterSeconds) } }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = subscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid submission" }, { status: 400 });
  }
  const { companyId, source } = parsed.data;
  // Normalized the same way every other email field in this CRM is
  // (ContactEmail, bulk-contact-validation.ts, etc.) — without this,
  // "John@example.com" and "john@example.com" would pass the DB's
  // @@unique([companyId, email]) constraint as two distinct rows, since
  // Postgres text equality is case-sensitive by default.
  const email = parsed.data.email.trim().toLowerCase();

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!company) {
    return NextResponse.json({ ok: false, error: "Unknown company" }, { status: 400 });
  }

  // Idempotent — a returning subscriber who previously unsubscribed and
  // signs up again is re-subscribed (status flips back, unsubscribedAt
  // cleared) rather than rejected as a duplicate or silently ignored.
  // Existence checked first so the admin notification below only fires for
  // a genuinely new subscriber, not every re-subscribe of an existing one.
  const existing = await prisma.subscriber.findUnique({ where: { companyId_email: { companyId, email } }, select: { id: true } });
  await prisma.subscriber.upsert({
    where: { companyId_email: { companyId, email } },
    create: { companyId, email, source },
    update: { status: "SUBSCRIBED", unsubscribedAt: null, ...(source ? { source } : {}) },
  });

  if (!existing) {
    await notifyNewSubscriber(companyId, email).catch(() => undefined);
  }

  return NextResponse.json({ ok: true });
}
