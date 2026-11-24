// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { getCspNonce } from "../csp-nonce-client";

afterEach(() => {
  document.head.innerHTML = "";
});

describe("the page's CSP nonce, for the few pieces of code that add a <style> element themselves", () => {
  it("reads the nonce property of a nonce'd script", () => {
    const s = document.createElement("script");
    s.nonce = "abc123==";
    s.setAttribute("nonce", "abc123==");
    document.head.appendChild(s);
    expect(getCspNonce()).toBe("abc123==");
  });

  it("there is none on a page without one (the static marketing pages, tests): undefined, never an empty string", () => {
    const s = document.createElement("script");
    document.head.appendChild(s);
    expect(getCspNonce()).toBeUndefined();
    document.head.innerHTML = "";
    expect(getCspNonce()).toBeUndefined();
  });

  it("an environment without a document (server rendering) is undefined, and a document that throws is too", () => {
    expect(getCspNonce(undefined as never)).toBeUndefined();
    expect(getCspNonce({ querySelector: () => { throw new Error("x"); } })).toBeUndefined();
  });
});
