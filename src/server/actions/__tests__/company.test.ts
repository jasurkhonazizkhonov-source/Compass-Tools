import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fake Prisma, same convention as the other server-action test
// files. Focused on the two things that matter most for company.ts:
// (1) every action is genuinely admin-only, not just UI-hidden, and
// (2) an admin can only ever touch their OWN company's row, never an
// arbitrary companyId. Logo upload's sharp/filesystem pipeline is covered
// by manual/live verification instead of mocked here (mocking sharp would
// defeat the point of the real-image-processing requirement).

type FakeAccount = { id: string; role: string; companyId: string };
type FakeCompany = { id: string; name: string; website: string | null; phone: string | null; brandColor: string | null; signatureTemplate: string };

let currentActor: FakeAccount | null;
let companies: Map<string, FakeCompany>;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: {
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakeCompany> }) => {
        const company = companies.get(id);
        if (!company) throw new Error(`company ${id} not found`);
        Object.assign(company, data);
        return company;
      }),
    },
  },
}));

beforeEach(() => {
  companies = new Map([
    ["company-a", { id: "company-a", name: "Company A", website: null, phone: null, brandColor: null, signatureTemplate: "Best regards,\n{{first_name}} {{last_name}}\n{{phone_number}}" }],
    ["company-b", { id: "company-b", name: "Company B", website: null, phone: null, brandColor: null, signatureTemplate: "Regards,\n{{first_name}}" }],
  ]);
  currentActor = { id: "admin-a", role: "ADMIN", companyId: "company-a" };
  vi.clearAllMocks();
});

describe("updateCompanyInfo — admin-only, own-company-only", () => {
  it("rejects a non-admin caller", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-a" };
    const { updateCompanyInfo } = await import("../company");
    await expect(updateCompanyInfo({ name: "Hacked Name" })).rejects.toThrow(/Only Admins/);
    expect(companies.get("company-a")!.name).toBe("Company A");
  });

  it("rejects an unauthenticated caller", async () => {
    currentActor = null;
    const { updateCompanyInfo } = await import("../company");
    await expect(updateCompanyInfo({ name: "Hacked Name" })).rejects.toThrow(/Only Admins/);
  });

  it("allows an admin to update their own company's info", async () => {
    const { updateCompanyInfo } = await import("../company");
    await updateCompanyInfo({ name: "New Name", website: "https://example.com", phone: "555-1234", brandColor: "#112233" });
    expect(companies.get("company-a")!.name).toBe("New Name");
    expect(companies.get("company-a")!.website).toBe("https://example.com");
  });

  it("an admin can never update a DIFFERENT company's row — only ever writes to their own companyId", async () => {
    const { updateCompanyInfo } = await import("../company");
    await updateCompanyInfo({ name: "New Name" });
    // company-b (a different company) must remain completely untouched.
    expect(companies.get("company-b")!.name).toBe("Company B");
  });

  it("rejects an empty company name", async () => {
    const { updateCompanyInfo } = await import("../company");
    await expect(updateCompanyInfo({ name: "" })).rejects.toThrow();
  });

  it("rejects an invalid brand color", async () => {
    const { updateCompanyInfo } = await import("../company");
    await expect(updateCompanyInfo({ name: "Valid Name", brandColor: "not-a-color" })).rejects.toThrow();
  });
});

describe("updateCompanySignature — admin-only, own-company-only", () => {
  it("rejects a non-admin caller", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-a" };
    const { updateCompanySignature } = await import("../company");
    await expect(updateCompanySignature({ signatureTemplate: "Hacked" })).rejects.toThrow(/Only Admins/);
  });

  it("allows an admin to update their own company's signature template", async () => {
    const { updateCompanySignature } = await import("../company");
    await updateCompanySignature({ signatureTemplate: "New sign-off,\n{{first_name}} {{last_name}}" });
    expect(companies.get("company-a")!.signatureTemplate).toBe("New sign-off,\n{{first_name}} {{last_name}}");
  });

  it("a different admin (different company) editing their own signature never touches company-a's template", async () => {
    currentActor = { id: "admin-b", role: "ADMIN", companyId: "company-b" };
    const { updateCompanySignature } = await import("../company");
    await updateCompanySignature({ signatureTemplate: "Company B's own template" });
    expect(companies.get("company-a")!.signatureTemplate).toBe("Best regards,\n{{first_name}} {{last_name}}\n{{phone_number}}");
    expect(companies.get("company-b")!.signatureTemplate).toBe("Company B's own template");
  });
});
