import { describe, it, expect, vi } from "vitest";
import { readLimitedJson, PUBLIC_JSON_MAX_BYTES } from "../read-limited-json";

// Regression for a measured defect: the unauthenticated public endpoints called Request.json(), which buffers the entire body, so a 30 MB body was
// fully read and parsed (about 2.6 s) before the schema said "invalid". The helper caps what is read, by declared length AND by counting the stream.

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/public/x", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

describe("readLimitedJson", () => {
  it("parses a normal body exactly as Request.json() would", async () => {
    const text = JSON.stringify({ a: 1, name: "Zoë ✈" });
    const r = await readLimitedJson(post(text));
    expect(r).toMatchObject({ ok: true, value: { a: 1, name: "Zoë ✈" } });
    // The exact received bytes come back too: the website's request signature (v2) is computed over them, never over a re-serialisation.
    expect(r.ok && r.raw.equals(Buffer.from(text, "utf8"))).toBe(true);
  });

  it("a body at the cap is accepted; one byte over is refused with 413", async () => {
    const pad = (n: number) => JSON.stringify({ x: "a".repeat(n) });
    const exact = pad(PUBLIC_JSON_MAX_BYTES - 8); // {"x":""} is 8 bytes of framing
    expect(Buffer.byteLength(exact)).toBe(PUBLIC_JSON_MAX_BYTES);
    expect((await readLimitedJson(post(exact))).ok).toBe(true);
    const over = await readLimitedJson(post(pad(PUBLIC_JSON_MAX_BYTES - 7)));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.response.status).toBe(413);
  });

  it("a declared Content-Length over the cap is refused before any body byte is read", async () => {
    const read = vi.fn();
    const req = post(null, { "content-length": String(50 * 1024 * 1024) });
    Object.defineProperty(req, "body", { get: read });
    const r = await readLimitedJson(req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
    expect(read).not.toHaveBeenCalled();
  });

  it("a missing or understated Content-Length does not help: the stream itself is counted and cancelled", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        if (pulled > 100000) return c.close();
        c.enqueue(chunk); // endless body
      },
    });
    const r = await readLimitedJson(new Request("http://localhost/x", { method: "POST", body: stream, duplex: "half" } as RequestInit & { duplex: "half" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
    expect(pulled).toBeLessThan(20); // stopped after ~64 KB, not after 1.6 GB
  });

  it("a malformed Content-Length header is refused", async () => {
    const r = await readLimitedJson(post("{}", { "content-length": "12abc" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
  });

  it("invalid JSON and an empty body keep the endpoints' existing 400 'Invalid JSON body'", async () => {
    for (const body of ["{not json", "", null]) {
      const r = await readLimitedJson(post(body as BodyInit | null));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(400);
        expect(await r.response.json()).toEqual({ ok: false, error: "Invalid JSON body" });
      }
    }
  });
});
