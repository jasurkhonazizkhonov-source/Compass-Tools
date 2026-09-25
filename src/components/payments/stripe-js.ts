// Minimal typed loader for the payment provider's browser library (Stripe.js).
// The library is always loaded from the provider's own domain (js.stripe.com) —
// never bundled or self-hosted — which is what keeps the card fields inside the
// provider's iframes: the card number and security code are typed into those
// iframes and go straight to the provider, never through this app's JavaScript.

export type StripeFieldEvent = { complete?: boolean; empty?: boolean; brand?: string; error?: { message?: string } };

export type StripeFieldElement = {
  mount(target: HTMLElement): void;
  unmount(): void;
  destroy(): void;
  on(event: "change" | "ready", handler: (e: StripeFieldEvent) => void): void;
};

export type StripeSetupResult = {
  setupIntent?: { id: string; status: string };
  error?: { message?: string; code?: string; type?: string };
};

export type StripeInstance = {
  elements(options?: Record<string, unknown>): {
    create(type: "cardNumber" | "cardExpiry" | "cardCvc", options?: Record<string, unknown>): StripeFieldElement;
  };
  confirmCardSetup(clientSecret: string, data: { payment_method: { card: StripeFieldElement; billing_details: { name: string } } }): Promise<StripeSetupResult>;
};

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeInstance;
  }
}

const SCRIPT_SRC = "https://js.stripe.com/v3";
let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Stripe.js can only load in a browser"));
  if (window.Stripe) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => {
      scriptPromise = null; // allow a retry after a transient network failure
      reject(new Error("Could not load the secure card form"));
    });
    if (!existing) {
      script.src = SCRIPT_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  });
  return scriptPromise;
}

const instances = new Map<string, StripeInstance>();

export async function loadStripe(publishableKey: string): Promise<StripeInstance> {
  await loadScript();
  if (!window.Stripe) throw new Error("Could not load the secure card form");
  let instance = instances.get(publishableKey);
  if (!instance) {
    instance = window.Stripe(publishableKey);
    instances.set(publishableKey, instance);
  }
  return instance;
}
