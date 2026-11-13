import { describe, it, expect, vi, beforeEach } from "vitest";

// The campaign HTML lifecycle at the action layer: create and edit store CLEANED html, the editor's preview is produced by the server, a record that
// was stored before the sanitizer existed is never rewritten by reading/previewing it, and the test send mails the cleaned copy. The sanitizer's own
// payload coverage is in src/server/email/__tests__/sanitize-campaign-html.test.ts. Prisma and the mailer are mocks: nothing is stored or sent.

const HOSTILE = `<p>Hello</p><script>alert(1)</script><img src="https://example.com/a.png" onerror="alert(2)"><a href="javascript:alert(3)">x</a>`;
const LEGACY = { id: "camp-legacy", companyId: "co-1", subject: "Old", htmlContent: HOSTILE, status: "DRAFT" };

let actor: { id: string; role: string; companyId: string; fullName: string; email: string } | null;
const created: Array<Record<string, unknown>> = [];
const updated: Array<Record<string, unknown>> = [];
const sentMail: Array<{ html: string }> = [];

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (m: { html: string }) => {
    sentMail.push({ html: m.html });
    return { ok: true };
  }),
}));
vi.mock("@/server/queries/company", () => ({ getCompanyForAccountId: vi.fn(async () => ({ name: "Acme Travel", brandColor: "#0a2540" })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    marketingCampaign: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "camp-new", ...data };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        return {};
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === LEGACY.id ? { ...LEGACY } : where.id === "camp-sent" ? { ...LEGACY, id: "camp-sent", status: "SENT" } : null)),
    },
  },
}));

beforeEach(() => {
  created.length = 0;
  updated.length = 0;
  sentMail.length = 0;
  actor = { id: "u1", role: "ADMIN", companyId: "co-1", fullName: "Ada Admin", email: "ada@example.com" };
});

const NO_ACTIVE = /<script|onerror|javascript:|alert\(/i;

describe("campaign HTML lifecycle", () => {
  it("create stores the CLEANED html and keeps the legitimate content", async () => {
    const { createMarketingCampaign } = await import("../marketing-campaigns");
    await createMarketingCampaign({ name: "n", subject: "s", htmlContent: HOSTILE });
    const stored = String(created[0].htmlContent);
    expect(stored).not.toMatch(NO_ACTIVE);
    expect(stored).toContain("<p>Hello</p>");
    expect(stored).toContain('src="https://example.com/a.png"');
  });

  it("edit stores the CLEANED html too", async () => {
    const { updateMarketingCampaign } = await import("../marketing-campaigns");
    await updateMarketingCampaign("camp-legacy", { name: "n", subject: "s", htmlContent: HOSTILE });
    expect(String(updated[0].htmlContent)).not.toMatch(NO_ACTIVE);
  });

  it("content that is nothing but unsupported markup is refused rather than saved as an empty campaign", async () => {
    const { createMarketingCampaign } = await import("../marketing-campaigns");
    await expect(createMarketingCampaign({ name: "n", subject: "s", htmlContent: "<script>alert(1)</script>" })).rejects.toThrow(/empty/i);
    expect(created).toHaveLength(0);
  });

  it("the preview comes from the server, is cleaned, and needs the marketing role", async () => {
    const { previewCampaignHtml } = await import("../marketing-campaigns");
    expect((await previewCampaignHtml(HOSTILE)).html).not.toMatch(NO_ACTIVE);
    expect((await previewCampaignHtml(HOSTILE)).html).toContain("<p>Hello</p>");
    expect(await previewCampaignHtml(undefined as unknown as string)).toEqual({ html: "" });
    actor = { ...actor!, role: "TRAVEL_AGENT" };
    await expect(previewCampaignHtml(HOSTILE)).rejects.toThrow(/not authorized/i);
    actor = null;
    await expect(previewCampaignHtml(HOSTILE)).rejects.toThrow(/not authorized/i);
  });

  it("a record stored before the sanitizer existed is mailed cleaned (test send) and is NOT rewritten in the database", async () => {
    const { sendTestMarketingCampaign } = await import("../marketing-campaigns");
    await sendTestMarketingCampaign("camp-legacy");
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].html).not.toMatch(NO_ACTIVE);
    expect(sentMail[0].html).toContain("Hello");
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0); // the stored record is left exactly as it was
  });
});
