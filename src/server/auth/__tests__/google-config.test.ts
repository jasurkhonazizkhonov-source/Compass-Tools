import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Pass 36 — real bug found and fixed: a GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET
// value pasted into Vercel's environment-variable UI (or a shell-exported
// .env) can silently pick up a leading/trailing newline or space. Neither
// Google's Identity Services script nor google-auth-library strips this —
// a client_id with a trailing "\n" is a DIFFERENT string than the one
// actually registered in Google Cloud Console, producing exactly the class
// of confusing "Error 401: invalid_client" this app has no way to surface
// server-side (Google's own error page renders in the browser). Trimming
// at the single source-of-truth read point removes this failure class.

const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("getGoogleClientId / getGoogleClientSecret", () => {
  it("returns the value unchanged when it has no surrounding whitespace", async () => {
    process.env.GOOGLE_CLIENT_ID = "abc123.apps.googleusercontent.com";
    const { getGoogleClientId } = await import("../google-config");
    expect(getGoogleClientId()).toBe("abc123.apps.googleusercontent.com");
  });

  it("trims a trailing newline (the classic copy-paste-into-Vercel corruption)", async () => {
    process.env.GOOGLE_CLIENT_ID = "abc123.apps.googleusercontent.com\n";
    const { getGoogleClientId } = await import("../google-config");
    expect(getGoogleClientId()).toBe("abc123.apps.googleusercontent.com");
  });

  it("trims leading/trailing spaces", async () => {
    process.env.GOOGLE_CLIENT_SECRET = "  some-secret-value  ";
    const { getGoogleClientSecret } = await import("../google-config");
    expect(getGoogleClientSecret()).toBe("some-secret-value");
  });

  it("throws a clear, credential-free error when unset", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const { getGoogleClientId } = await import("../google-config");
    expect(() => getGoogleClientId()).toThrow("GOOGLE_CLIENT_ID is not configured");
  });

  it("throws when the value is only whitespace (effectively unset)", async () => {
    process.env.GOOGLE_CLIENT_ID = "   ";
    const { getGoogleClientId } = await import("../google-config");
    expect(() => getGoogleClientId()).toThrow("GOOGLE_CLIENT_ID is not configured");
  });
});
