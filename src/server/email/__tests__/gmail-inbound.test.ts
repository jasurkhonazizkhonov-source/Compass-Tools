import { describe, it, expect, vi } from "vitest";
import { GmailInboundError, createGmailInboundApi, toMessageMeta } from "../gmail-inbound";
import { parseRetryAfterMs } from "../gmail-send";
import { DEFAULT_RATE_LIMIT_BACKOFF_MS } from "@/server/sender-quota";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

// The read-only Gmail client behind reply detection. The network is a fake `fetch`; what matters is WHAT is requested (metadata only, by id) and how each Gmail answer is understood.
type Call = { url: string; auth: string | null };
function api(responses: Array<{ status?: number; body?: unknown } | "network-error">) {
  const calls: Call[] = [];
  const fetchFake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.Authorization ?? null });
    const next = responses.shift();
    if (next === "network-error" || !next) throw new Error("boom");
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  });
  return { client: createGmailInboundApi("token-xyz", fetchFake as unknown as typeof fetch), calls };
}

describe("what is asked of Gmail", () => {
  it("a message and a conversation are fetched as METADATA with a short fixed list of headers - never the full format", async () => {
    const { client, calls } = api([
      { body: { id: "m1", threadId: "t1", labelIds: ["INBOX"], internalDate: "1700000000000", payload: { headers: [{ name: "From", value: "a@b.example" }] } } },
      { body: { id: "t1", messages: [{ id: "m1", threadId: "t1", labelIds: ["SENT"], payload: { headers: [] } }] } },
    ]);
    await client.getMessage("m1");
    await client.getThread("t1");
    for (const c of calls) {
      expect(c.url).toContain("format=metadata");
      expect(c.url).not.toContain("format=full");
      expect(c.url).not.toContain("format=raw");
      expect(c.url).toContain("metadataHeaders=From");
      expect(c.url).not.toMatch(/metadataHeaders=(Subject|To|Cc)\b/);
      expect(c.auth).toBe("Bearer token-xyz");
    }
    expect(calls[0].url).toContain("/users/me/messages/m1?");
    expect(calls[1].url).toContain("/users/me/threads/t1?");
  });

  it("the change list asks only for messages that were ADDED, from the saved position", async () => {
    const { client, calls } = api([{ body: { history: [], historyId: "99" } }]);
    await client.listHistory("42");
    expect(calls[0].url).toContain("startHistoryId=42");
    expect(calls[0].url).toContain("historyTypes=messageAdded");
  });

  it("an id is URL-encoded, so it can never alter the path it is placed in", async () => {
    const { client, calls } = api([{ status: 404 }]);
    await client.getMessage("../../labels");
    expect(calls[0].url).toContain("/messages/..%2F..%2Flabels?");
  });
});

describe("how answers are understood", () => {
  it("the change list yields ids, thread ids and labels, and follows pages", async () => {
    const { client } = api([
      { body: { history: [{ messagesAdded: [{ message: { id: "a", threadId: "ta", labelIds: ["INBOX"] } }, { message: { id: "b", threadId: "tb" } }, { message: {} }] }], historyId: "100", nextPageToken: "p2" } },
    ]);
    const page = await client.listHistory("1");
    expect(page.added).toEqual([
      { id: "a", threadId: "ta", labelIds: ["INBOX"] },
      { id: "b", threadId: "tb", labelIds: [] },
    ]);
    expect(page).toMatchObject({ historyId: "100", nextPageToken: "p2" });
  });

  it("a 404 on the change list means the saved position is too old (the caller starts again from now)", async () => {
    const { client } = api([{ status: 404 }]);
    await expect(client.listHistory("1")).rejects.toMatchObject({ code: "HISTORY_EXPIRED" });
  });

  it("a conversation or message that no longer exists is simply absent", async () => {
    const { client } = api([{ status: 404 }, { status: 404 }]);
    expect(await client.getThread("gone")).toEqual([]);
    expect(await client.getMessage("gone")).toBeNull();
  });

  it.each([
    [401, {}, "AUTH"],
    [403, { error: { errors: [{ reason: "insufficientPermissions" }] } }, "SCOPE"],
    [403, { error: { status: "PERMISSION_DENIED" } }, "SCOPE"],
    [429, {}, "RATE"],
    [403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }, "RATE"],
    [500, {}, "UNAVAILABLE"],
  ])("HTTP %i is classified as %s", async (status, body, code) => {
    const { client } = api([{ status, body }]);
    await expect(client.currentHistoryId()).rejects.toMatchObject({ code });
  });

  it("a network failure is a temporary problem, and the error carries only the category", async () => {
    const { client } = api(["network-error"]);
    const err = await client.currentHistoryId().catch((e) => e);
    expect(err).toBeInstanceOf(GmailInboundError);
    expect(err.code).toBe("UNAVAILABLE");
    expect(String(err.message)).toBe("UNAVAILABLE");
  });

  it("toMessageMeta tolerates missing parts and never invents an id", () => {
    expect(toMessageMeta({ id: "x", threadId: "y" })).toEqual({ id: "x", threadId: "y", labelIds: [], headers: {} });
    expect(toMessageMeta({ id: "x" })).toBeNull();
    expect(toMessageMeta({ id: "x", threadId: "y", internalDate: "1700000000000", payload: { headers: [{ name: "From", value: "a@b.example" }, { name: "Bad" }] } })).toEqual({
      id: "x",
      threadId: "y",
      labelIds: [],
      headers: { From: "a@b.example" },
      internalDateMs: 1700000000000,
    });
  });
});

describe("Gmail's own advice about slowing down", () => {
  const NOW = Date.parse("2026-11-24T12:00:00Z");
  it("uses Retry-After seconds, an HTTP date, or the 'Retry after <time>' sentence - bounded to between one minute and a day", () => {
    expect(parseRetryAfterMs("120", null, NOW)).toBe(120_000);
    expect(parseRetryAfterMs("5", null, NOW)).toBe(60_000); // never less than a minute
    expect(parseRetryAfterMs("999999999", null, NOW)).toBe(24 * 60 * 60_000); // never more than a day
    expect(parseRetryAfterMs("Tue, 24 Nov 2026 12:10:00 GMT", null, NOW)).toBe(10 * 60_000);
    const body = { error: { message: "User-rate limit exceeded.  Retry after 2026-11-24T12:30:00.000Z" } };
    expect(parseRetryAfterMs(null, body, NOW)).toBe(30 * 60_000);
  });

  it("falls back to the default when there is no usable advice, or the time is in the past", () => {
    expect(parseRetryAfterMs(null, null, NOW)).toBe(DEFAULT_RATE_LIMIT_BACKOFF_MS);
    expect(parseRetryAfterMs("soon", { error: { message: "no time here" } }, NOW)).toBe(DEFAULT_RATE_LIMIT_BACKOFF_MS);
    expect(parseRetryAfterMs(null, { error: { message: "Retry after 2020-01-01T00:00:00.000Z" } }, NOW)).toBe(DEFAULT_RATE_LIMIT_BACKOFF_MS);
  });
});
