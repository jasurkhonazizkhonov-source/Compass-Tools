import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The binding that ties a Google ID token to the browser that asked for it. next/headers' cookie jar is replaced by a tiny in-memory one so the cookie attributes can be asserted.
const store = new Map<string, string>();
const setSpy = vi.fn();
const deleteSpy = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      setSpy(name, value, options);
      store.set(name, value);
    },
    delete: (name: string) => {
      deleteSpy(name);
      store.delete(name);
    },
  }),
}));

import { GOOGLE_BINDING_COOKIE, clearBinding, ensureBindingNonce, nonceForBinding, nonceMatches, readBindingNonce } from "../google-login-binding";

beforeEach(() => {
  store.clear();
  setSpy.mockClear();
  deleteSpy.mockClear();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("APP_ENV", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("the nonce", () => {
  it("is a one-way function of the binding: stable for one binding, different for another, and does not contain it", () => {
    const a = "A".repeat(43);
    const b = "B".repeat(43);
    expect(nonceForBinding(a)).toBe(nonceForBinding(a));
    expect(nonceForBinding(a)).not.toBe(nonceForBinding(b));
    expect(nonceForBinding(a)).not.toContain(a);
    expect(nonceForBinding(a)).toMatch(/^[A-Za-z0-9_-]{43}$/); // SHA-256, base64url
  });

  it("nonceMatches is true only for an identical string; absent, empty, non-string and near-miss values are all false", () => {
    const n = nonceForBinding("A".repeat(43));
    expect(nonceMatches(n, n)).toBe(true);
    for (const bad of [undefined, null, "", 12345, {}, n.slice(0, -1), `${n}x`, n.toUpperCase()]) expect(nonceMatches(n, bad), String(bad)).toBe(false);
    for (const noExpected of [undefined, null, ""]) expect(nonceMatches(noExpected, n)).toBe(false);
  });
});

describe("ensureBindingNonce", () => {
  it("creates the binding on first use: random, HttpOnly, SameSite=Lax, Secure in production, site-wide, short-lived; the cookie is NOT the nonce", async () => {
    const nonce = await ensureBindingNonce();
    expect(setSpy).toHaveBeenCalledTimes(1);
    const [name, value, options] = setSpy.mock.calls[0];
    expect(name).toBe(GOOGLE_BINDING_COOKIE);
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    expect(options.maxAge).toBeLessThanOrEqual(24 * 60 * 60);
    expect(nonce).toBe(nonceForBinding(value));
    expect(nonce).not.toBe(value);
  });

  it("reuses an existing valid binding (two open tabs share one) and does not write the cookie again", async () => {
    const first = await ensureBindingNonce();
    setSpy.mockClear();
    expect(await ensureBindingNonce()).toBe(first);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("replaces a malformed cookie value with a fresh binding", async () => {
    store.set(GOOGLE_BINDING_COOKIE, "short");
    const nonce = await ensureBindingNonce();
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(store.get(GOOGLE_BINDING_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).toBe(nonceForBinding(store.get(GOOGLE_BINDING_COOKIE)!));
  });

  it("outside production the cookie is not Secure (plain http://localhost still works)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await ensureBindingNonce();
    expect(setSpy.mock.calls[0][2]).toMatchObject({ secure: false, httpOnly: true });
  });

  it("two browsers get two different bindings", async () => {
    const a = await ensureBindingNonce();
    store.clear();
    const b = await ensureBindingNonce();
    expect(a).not.toBe(b);
  });
});

describe("readBindingNonce / clearBinding", () => {
  it("reads the nonce of a valid binding, null for none or a malformed one, and never creates a cookie", async () => {
    expect(await readBindingNonce()).toBeNull();
    store.set(GOOGLE_BINDING_COOKIE, "not-valid");
    expect(await readBindingNonce()).toBeNull();
    store.set(GOOGLE_BINDING_COOKIE, "C".repeat(43));
    expect(await readBindingNonce()).toBe(nonceForBinding("C".repeat(43)));
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("clearBinding removes it, and never throws", async () => {
    store.set(GOOGLE_BINDING_COOKIE, "C".repeat(43));
    await clearBinding();
    expect(deleteSpy).toHaveBeenCalledWith(GOOGLE_BINDING_COOKIE);
    expect(await readBindingNonce()).toBeNull();
  });
});
