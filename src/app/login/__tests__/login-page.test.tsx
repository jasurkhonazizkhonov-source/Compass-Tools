import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => null) }));
vi.mock("@/server/auth/google-config", () => ({ getGoogleClientId: () => "test-client-id" }));
vi.mock("@/components/layout/google-sign-in-button", () => ({ GoogleSignInButton: () => null }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import LoginPage from "../page";

async function render(reason?: string | string[]) {
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(reason === undefined ? {} : { reason }) }));
}

describe("/login — why the previous session ended", () => {
  it("a session replaced by a sign-in on another device says exactly that, in a status region, with no device detail", async () => {
    const html = await render("superseded");
    expect(html).toContain('data-testid="session-ended-message"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Your session ended because this account signed in on another device.");
    expect(html).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  it("an administrator's sign-out-all has its own wording", async () => {
    const html = await render("signed-out-all");
    expect(html).toContain("You were signed out by an administrator.");
    expect(html).not.toContain("another device");
  });

  it("the 24-hour expiry keeps its own message and does not claim another device", async () => {
    const html = await render("expired");
    expect(html).not.toContain('data-testid="session-ended-message"');
    expect(html).not.toContain("another device");
    expect(html.toLowerCase()).toContain("expired");
  });

  it("no reason, an unknown reason or an injected one shows none of the session-ended copy (and nothing is echoed)", async () => {
    for (const reason of [undefined, "", "bogus", "<script>alert(1)</script>", ["superseded", "x"]]) {
      const html = await render(reason as string);
      expect(html, String(reason)).not.toContain('data-testid="session-ended-message"');
      expect(html).not.toContain("<script>alert(1)</script>");
    }
  });
});
