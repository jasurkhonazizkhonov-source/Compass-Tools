import { NextResponse } from "next/server";

// A byte cap for the UNAUTHENTICATED public endpoints that accept JSON (inquiries, lead capture, newsletter). `Request.json()` buffers the whole
// body, so without a cap one request could make the server hold tens of megabytes (measured: a 30 MB body was fully read and parsed before the
// schema rejected it). The cap is far above any real submission (the longest field is a 5,000-character message) and is enforced twice: a declared
// Content-Length over the cap is refused before a byte is read, and the stream itself is counted and cancelled the moment it exceeds the cap, so a
// missing or lying Content-Length changes nothing. The authenticated website API (v1/website/flight-inquiries) has its own, stricter cap.

export const PUBLIC_JSON_MAX_BYTES = 64 * 1024;

export type LimitedJson = { ok: true; value: unknown } | { ok: false; response: NextResponse };

const tooLarge = () => NextResponse.json({ ok: false, error: "Request body is too large." }, { status: 413 });
const badJson = () => NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });

export async function readLimitedJson(req: Request, maxBytes: number = PUBLIC_JSON_MAX_BYTES): Promise<LimitedJson> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > maxBytes)) return { ok: false, response: tooLarge() };
  if (!req.body) return { ok: false, response: badJson() };

  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: tooLarge() };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return { ok: false, response: badJson() };
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, response: badJson() };
  }
}
