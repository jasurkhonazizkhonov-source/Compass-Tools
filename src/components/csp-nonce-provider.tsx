"use client";

import { useEffect } from "react";
import { setNonce } from "get-nonce";
import { getCspNonce } from "@/lib/csp-nonce-client";

/**
 * Hands this page's Content-Security-Policy nonce to the UI libraries that add a <style> element of their own at run time. Radix (dialogs, menus, selects, popovers) locks page scroll
 * behind a modal with a <style> element made by react-remove-scroll-bar, which asks the `get-nonce` package for a nonce; without one the strict style policy blocks it (seen in a
 * real browser: the page kept scrolling behind an open dialog). It runs once, before anything opens, and does nothing on a page without a nonce (the static marketing pages).
 */
export function CspNonceProvider() {
  useEffect(() => {
    const nonce = getCspNonce();
    if (nonce) setNonce(nonce);
  }, []);
  return null;
}
