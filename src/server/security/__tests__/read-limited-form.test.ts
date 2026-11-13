import { describe, it, expect } from "vitest";
import { readLimitedForm, PUBLIC_FORM_MAX_BYTES } from "../read-limited-form";

const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://app.example.com/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });

describe("readLimitedForm", () => {
  it("parses a normal urlencoded form", async () => {
    const r = await readLimitedForm(req("token=abc&comment=hello+world"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.form.get("token")).toBe("abc");
      expect(r.form.get("comment")).toBe("hello world");
    }
  });

  it("parses a multipart form", async () => {
    const fd = new FormData();
    fd.set("token", "abc");
    const encoded = new Response(fd);
    const r = await readLimitedForm(req(await encoded.arrayBuffer(), { "content-type": encoded.headers.get("content-type") ?? "" }));
    expect(r.ok && r.form.get("token")).toBe("abc");
  });

  it("accepts a body exactly at the cap and refuses one byte over it", async () => {
    const pad = (n: number) => "a=" + "x".repeat(n - 2);
    expect((await readLimitedForm(req(pad(PUBLIC_FORM_MAX_BYTES)))).ok).toBe(true);
    const over = await readLimitedForm(req(pad(PUBLIC_FORM_MAX_BYTES + 1), { "content-length": "1" })); // a lying length changes nothing
    expect(over).toEqual({ ok: false, reason: "too-large" });
  });

  it("refuses a declared length over the cap without reading, and a malformed declared length", async () => {
    expect(await readLimitedForm(req("a=b", { "content-length": String(PUBLIC_FORM_MAX_BYTES + 1) }))).toEqual({ ok: false, reason: "too-large" });
    expect(await readLimitedForm(req("a=b", { "content-length": "12abc" }))).toEqual({ ok: false, reason: "too-large" });
  });

  it("reports an empty or unparseable body as unreadable, never throws", async () => {
    expect(await readLimitedForm(req(null))).toEqual({ ok: false, reason: "unreadable" });
    const bad = await readLimitedForm(req("garbage", { "content-type": "multipart/form-data; boundary=x" }));
    expect(bad).toEqual({ ok: false, reason: "unreadable" });
  });
});
