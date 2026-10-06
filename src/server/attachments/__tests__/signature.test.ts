import { describe, it, expect } from "vitest";
import { matchesSignature } from "../signature";

const b = (...v: number[]) => Uint8Array.from(v);
const text = (s: string) => new TextEncoder().encode(s);

describe("content signatures (extension must match the real bytes)", () => {
  it("accepts genuine headers", () => {
    expect(matchesSignature("pdf", text("%PDF-1.7\n..."))).toBe(true);
    expect(matchesSignature("jpeg", b(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe(true);
    expect(matchesSignature("png", b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(true);
    expect(matchesSignature("webp", b(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe(true);
    expect(matchesSignature("ole", b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe(true);
    expect(matchesSignature("zip", b(0x50, 0x4b, 0x03, 0x04, 0))).toBe(true);
    expect(matchesSignature("text", text("Name,Email\nJane,jane@example.com\n"))).toBe(true);
  });

  it("rejects an executable / HTML / script renamed to a document", () => {
    const exe = text("MZ\x90\x00\x03\x00");
    for (const kind of ["pdf", "jpeg", "png", "webp", "ole", "zip", "text"] as const) expect(matchesSignature(kind, exe), kind).toBe(false);
    expect(matchesSignature("pdf", text("<html><script>alert(1)</script></html>"))).toBe(false);
    expect(matchesSignature("png", text("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBe(false);
    expect(matchesSignature("text", text("<!DOCTYPE html><html></html>"))).toBe(false);
    expect(matchesSignature("text", text("<svg onload=alert(1)>"))).toBe(false);
    expect(matchesSignature("text", text("#!/bin/sh\nrm -rf /"))).toBe(false);
    expect(matchesSignature("text", b(0x7f, 0x45, 0x4c, 0x46))).toBe(false);
  });

  it("rejects binary data and empty content as text", () => {
    expect(matchesSignature("text", b(0x41, 0x42, 0x00, 0x43))).toBe(false);
    expect(matchesSignature("text", new Uint8Array())).toBe(false);
  });

  it("a type can't be satisfied by another type's header", () => {
    expect(matchesSignature("jpeg", b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(false);
    expect(matchesSignature("zip", text("%PDF-1.4"))).toBe(false);
    expect(matchesSignature("webp", b(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45))).toBe(false); // RIFF WAVE (audio)
  });
});
