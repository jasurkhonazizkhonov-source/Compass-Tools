// The Content-Security-Policy nonce of the page being shown, for the few pieces of browser code that must add a <style> element themselves (the editor's base styles).
//
// The nonce policy (src/lib/csp.ts, src/proxy.ts) stamps this request's nonce on every script Next.js renders. Browsers hide the `nonce` ATTRIBUTE from getAttribute() once the element is
// parsed (so a script cannot copy it out of the markup) but keep the `.nonce` PROPERTY readable, which is what this reads. On a page without a nonce (the static marketing pages, tests)
// it returns undefined and callers simply add the element without one: the base policy there does not require it.
export function getCspNonce(doc: Pick<Document, "querySelector"> | undefined = typeof document === "undefined" ? undefined : document): string | undefined {
  try {
    const el = doc?.querySelector<HTMLScriptElement>("script[nonce]");
    const nonce = el?.nonce;
    return nonce ? nonce : undefined;
  } catch {
    return undefined;
  }
}
