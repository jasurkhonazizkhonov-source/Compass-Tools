// Test double for the provider's hosted card fields. The real component mounts
// the payment provider's iframes (not available in jsdom); this stub renders a
// placeholder and exposes the same handle, so form logic can be tested without
// any card data existing anywhere in the test.
import { forwardRef, useImperativeHandle } from "react";
import type { SecureCardHandle } from "@/components/payments/secure-card-fields";

export const stubHandleState = { complete: true, confirm: async () => ({ ok: true as const, setupIntentId: "seti_test_stub" }) as Awaited<ReturnType<SecureCardHandle["confirmSetup"]>> };

export const SecureCardFields = forwardRef<SecureCardHandle, { publishableKey: string }>(function SecureCardFieldsStub(_props, ref) {
  useImperativeHandle(ref, () => ({
    isComplete: () => stubHandleState.complete,
    confirmSetup: () => stubHandleState.confirm(),
  }));
  return <div data-testid="secure-card-fields">Secure card fields</div>;
});
