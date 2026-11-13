// A byte cap for the UNAUTHENTICATED public endpoint that accepts an HTML form post (the unsubscribe page). `Request.formData()` buffers and parses the
// whole body, so without a cap one request could make the server hold arbitrarily many megabytes before the handler even looks at the token. Same
// two-layer rule as read-limited-json.ts: a declared Content-Length over the cap is refused before a byte is read, and the stream itself is counted
// and cancelled the moment it exceeds the cap, so a missing or lying Content-Length changes nothing. The real form is a token (about 40 characters),
// a reason category and a comment of at most 5,000 characters, so 32 KB is far above any genuine submission.

export const PUBLIC_FORM_MAX_BYTES = 32 * 1024;

export type LimitedForm = { ok: true; form: FormData } | { ok: false; reason: "too-large" | "unreadable" };

export async function readLimitedForm(req: Request, maxBytes: number = PUBLIC_FORM_MAX_BYTES): Promise<LimitedForm> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > maxBytes)) return { ok: false, reason: "too-large" };
  if (!req.body) return { ok: false, reason: "unreadable" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    // Parsed from the bytes already read (and already capped), with the original Content-Type so urlencoded and multipart bodies both work.
    const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const form = await new Response(bytes, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
    return { ok: true, form };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
