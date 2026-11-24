import { describe, it, expect, vi, beforeEach } from "vitest";

const track = vi.fn(async (..._args: unknown[]) => undefined);
const limit = vi.fn();
vi.mock("@/server/actions/booking", () => ({ trackQuoteView: (...a: unknown[]) => track(...a) }));
vi.mock("@/server/security/rate-limit", () => ({ checkPublicRateLimit: (...a: unknown[]) => limit(...a), RATE_LIMITS: { QUOTE_OPEN_TRACKING: { windowMs: 900_000, maxAttempts: 600 } } }));

const call = async () => {
  const { GET } = await import("../route");
  return GET(new Request("http://localhost/api/track/quote-open/tok"), { params: Promise.resolve({ token: "tok" }) });
};

beforeEach(() => {
  vi.clearAllMocks();
  limit.mockResolvedValue({ allowed: true });
});

describe("the quote-opened tracking pixel", () => {
  it("answers the transparent image and records the view", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(track).toHaveBeenCalledWith("tok");
    expect(limit).toHaveBeenCalledWith(expect.any(Headers), "QUOTE_OPEN_TRACKING", expect.objectContaining({ maxAttempts: 600 }));
  });

  it("over the per-IP ceiling the image is STILL answered (an email never shows a broken picture) but nothing is looked up or recorded", async () => {
    limit.mockResolvedValue({ allowed: false, retryAfterSeconds: 300 });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(track).not.toHaveBeenCalled();
  });

  it("a failure of the limiter itself never blocks the pixel or the recording", async () => {
    limit.mockRejectedValue(new Error("database down"));
    const res = await call();
    expect(res.status).toBe(200);
    expect(track).toHaveBeenCalledWith("tok");
  });

  it("a failure of the recording never breaks the image", async () => {
    track.mockRejectedValueOnce(new Error("boom"));
    expect((await call()).status).toBe(200);
  });
});
