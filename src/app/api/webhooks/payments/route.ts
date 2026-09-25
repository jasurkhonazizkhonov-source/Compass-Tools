import { NextResponse } from "next/server";
import { getPaymentProvider } from "@/server/payments/provider";
import { handleVerifiedWebhook } from "@/server/payments/webhook-handler";
import { WebhookVerificationError } from "@/server/payments/stripe-adapter";
import { recordHealthEvent } from "@/server/system/health-events";
import { safeErrorTag } from "@/lib/safe-error-log";

// Public endpoint the payment provider calls with signed events. The ONLY thing
// that authenticates a request here is the provider's signature over the raw
// body, verified with the endpoint's signing secret — never a session, never a
// header a browser could set. Everything else is idempotent state sync; see
// src/server/payments/webhook-handler.ts.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const provider = getPaymentProvider();
  if (!provider) {
    // Not configured: nothing to verify against. A 503 makes the provider retry later.
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  // The RAW body: the signature covers the exact bytes, so it must not be parsed and re-serialized first.
  const rawBody = await req.text();

  let event;
  try {
    event = provider.verifyWebhook(rawBody, req.headers.get("stripe-signature"));
  } catch (err) {
    const reason = err instanceof WebhookVerificationError ? err.reason : "unknown";
    console.error(`[payments-webhook] REJECTED reason=${reason}`);
    // Repeated rejections of a correctly-configured endpoint mean a wrong/rotated secret or someone probing.
    await recordHealthEvent({
      type: "PAYMENT_WEBHOOK_REJECTED",
      category: "payment",
      severity: "WARNING",
      discriminator: reason,
      message: `A payment webhook was rejected (${reason}). If this keeps happening, the webhook signing secret may be wrong or rotated.`,
      metadata: { reason },
    });
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  try {
    const outcome = await handleVerifiedWebhook(provider.id, event);
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    console.error(`[payments-webhook] HANDLER_FAILED type=${event.type} (${safeErrorTag(err)})`);
    await recordHealthEvent({
      type: "PAYMENT_WEBHOOK_FAILED",
      category: "payment",
      severity: "WARNING",
      discriminator: event.type.slice(0, 60),
      message: "A verified payment webhook could not be applied. The provider will retry it.",
      metadata: { eventType: event.type.slice(0, 60), failure: safeErrorTag(err) },
    });
    // 500 => the provider redelivers; the ledger makes the retry safe.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
