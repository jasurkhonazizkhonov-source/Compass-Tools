import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Unit coverage for bootstrapInitialAdminIfEligible's decision logic
// (mocked Prisma). Real, genuine Postgres concurrency proof of the actual
// race-safety guarantee (Serializable isolation + P2034 retry + the
// orphaned-Company compensating cleanup) was run separately this pass
// against a fresh throwaway database — see the pass report; not a
// committed test file since it needs a real database.

type FakeAccount = { id: string; email: string; fullName: string; role: string; status: string; companyId: string };
type FakeCompany = { id: string; name: string; createdAt: Date };

let accounts: FakeAccount[];
let companies: FakeCompany[];
let nextId: number;

function installFakePrisma() {
  return {
    account: {
      count: vi.fn(async () => accounts.length),
    },
    company: {
      // Mirrors the real function's "reuse an existing Company row if one
      // is already present" behavior — every freshly-migrated real
      // database always has at least one (a historical migration seeds a
      // `default-company` placeholder), so this is the realistic default;
      // tests that need the "genuinely zero companies" branch clear this
      // array explicitly.
      findFirst: vi.fn(async () => (companies.length > 0 ? companies[0] : null)),
      create: vi.fn(async ({ data }: { data: { name: string } }) => {
        const company: FakeCompany = { id: `company-${nextId++}`, name: data.name, createdAt: new Date() };
        companies.push(company);
        return company;
      }),
    },
    $transaction: vi.fn((fn: (tx: ReturnType<typeof installFakePrisma>) => unknown) => fn(fakePrisma)),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fakePrisma: any = installFakePrisma();

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fakePrisma;
  },
}));

beforeEach(() => {
  accounts = [];
  companies = [{ id: "default-company", name: "Business Flights Travel", createdAt: new Date(0) }];
  nextId = 1;
  fakePrisma = installFakePrisma();
});

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.INITIAL_ADMIN_EMAIL;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.INITIAL_ADMIN_EMAIL;
  else process.env.INITIAL_ADMIN_EMAIL = savedEnv;
});

// account.create isn't part of the shared fakePrisma above because its
// implementation depends on the test (some need it to insert into
// `accounts`, one needs it to simulate a unique-constraint race loss).
function installAccountCreate() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fakePrisma as any).account.create = vi.fn(async ({ data }: { data: Omit<FakeAccount, "id"> }) => {
    const account: FakeAccount = { id: `account-${nextId++}`, ...data };
    accounts.push(account);
    return account;
  });
}

describe("bootstrapInitialAdminIfEligible", () => {
  it("no accounts + matching INITIAL_ADMIN_EMAIL → creates an ADMIN account, reusing the existing (default-company) row rather than creating a second one", async () => {
    process.env.INITIAL_ADMIN_EMAIL = "founder@example.com";
    installAccountCreate();
    const { bootstrapInitialAdminIfEligible } = await import("../initial-admin-bootstrap");

    const result = await bootstrapInitialAdminIfEligible("founder@example.com", "Founder Name");

    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(result.account.role).toBe("ADMIN");
      expect(result.account.status).toBe("ACTIVE");
      expect(result.account.email).toBe("founder@example.com");
      expect(result.account.fullName).toBe("Founder Name");
      expect(result.account.companyId).toBe("default-company");
    }
    expect(companies).toHaveLength(1); // reused, not a second row created
    expect(accounts).toHaveLength(1);
  });

  it("no accounts + no pre-existing Company row either → creates a fresh placeholder company AND the ADMIN account", async () => {
    process.env.INITIAL_ADMIN_EMAIL = "founder@example.com";
    companies = []; // simulates a database with literally zero Company rows
    installAccountCreate();
    const { bootstrapInitialAdminIfEligible } = await import("../initial-admin-bootstrap");

    const result = await bootstrapInitialAdminIfEligible("founder@example.com", "Founder Name");

    expect(result.outcome).toBe("created");
    expect(companies).toHaveLength(1);
    if (result.outcome === "created") {
      expect(result.account.companyId).toBe(companies[0]!.id);
    }
  });

  it("no accounts + nonmatching Google email → email_mismatch, nothing created", async () => {
    process.env.INITIAL_ADMIN_EMAIL = "founder@example.com";
    installAccountCreate();
    const { bootstrapInitialAdminIfEligible } = await import("../initial-admin-bootstrap");

    const result = await bootstrapInitialAdminIfEligible("stranger@example.com", undefined);

    expect(result).toEqual({ outcome: "email_mismatch" });
    expect(accounts).toHaveLength(0);
    expect(companies).toHaveLength(1); // unchanged — still just the pre-existing row
  });

  it("no accounts + missing INITIAL_ADMIN_EMAIL → not_initialized, nothing created, no wildcard admin", async () => {
    delete process.env.INITIAL_ADMIN_EMAIL;
    installAccountCreate();
    const { bootstrapInitialAdminIfEligible } = await import("../initial-admin-bootstrap");

    const result = await bootstrapInitialAdminIfEligible("anyone@example.com", undefined);

    expect(result).toEqual({ outcome: "not_initialized" });
    expect(accounts).toHaveLength(0);
  });

  it("no accounts + INITIAL_ADMIN_EMAIL is only whitespace → not_initialized, never treated as a wildcard", async () => {
    process.env.INITIAL_ADMIN_EMAIL = "   ";
    installAccountCreate();
    const { bootstrapInitialAdminIfEligible } = await import("../initial-admin-bootstrap");

    const result = await bootstrapInitialAdminIfEligible("anyone@example.com", undefined);

    expect(result).toEqual({ outcome: "not_initialized" });
    expect(accounts).toHaveLength(0);
  });

  it("matching email with different case → still bootstraps successfully", async () => {
    process.env.INITIAL_ADMIN_EMAIL = "Founder@Example.com";
    installAccountCreate();
    const { bootstrapInitialAdminIfEligible } = await import("../initial-admin-bootstrap");

    const result = await bootstrapInitialAdminIfEligible("founder@example.com", undefined);

    expect(result.outcome).toBe("created");
  });

  it("matching email with surrounding whitespace in the CONFIGURED value → still bootstraps successfully", async () => {
    process.env.INITIAL_ADMIN_EMAIL = "  founder@example.com  ";
    installAccountCreate();
    const { bootstrapInitialAdminIfEligible } = await import("../initial-admin-bootstrap");

    const result = await bootstrapInitialAdminIfEligible("founder@example.com", undefined);

    expect(result.outcome).toBe("created");
  });

  it("existing accounts + INITIAL_ADMIN_EMAIL matches → not_applicable, cannot bootstrap a second Admin this way", async () => {
    process.env.INITIAL_ADMIN_EMAIL = "founder@example.com";
    accounts.push({ id: "existing-1", email: "someone-else@example.com", fullName: "Someone", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-existing" });
    installAccountCreate();
    const { bootstrapInitialAdminIfEligible } = await import("../initial-admin-bootstrap");

    const result = await bootstrapInitialAdminIfEligible("founder@example.com", undefined);

    expect(result).toEqual({ outcome: "not_applicable" });
    expect(accounts).toHaveLength(1); // unchanged — no second account created
  });

  it("loses the in-transaction re-check race (another request already created the first account) → not_applicable, no orphaned company", async () => {
    process.env.INITIAL_ADMIN_EMAIL = "founder@example.com";
    // Simulate "someone else won" by having the in-transaction re-check see
    // a non-zero count even though the outer pre-check saw zero.
    let callCount = 0;
    fakePrisma.account.count = vi.fn(async () => {
      callCount++;
      return callCount === 1 ? 0 : 1; // pre-check: empty; in-transaction re-check: no longer empty
    });
    installAccountCreate();
    const { bootstrapInitialAdminIfEligible } = await import("../initial-admin-bootstrap");

    const result = await bootstrapInitialAdminIfEligible("founder@example.com", undefined);

    expect(result).toEqual({ outcome: "not_applicable" });
    expect(companies).toHaveLength(1); // unchanged — the recheck threw before any company lookup/create ran
    expect(accounts).toHaveLength(0);
  });

  it("a P2002 unique-constraint violation on account.create() (the real Postgres race outcome) is treated the same as losing the race", async () => {
    process.env.INITIAL_ADMIN_EMAIL = "founder@example.com";
    const { Prisma } = await import("@/generated/prisma/client");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fakePrisma as any).account.create = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`email`)", {
        code: "P2002",
        clientVersion: "test",
      });
    });
    const { bootstrapInitialAdminIfEligible } = await import("../initial-admin-bootstrap");

    const result = await bootstrapInitialAdminIfEligible("founder@example.com", undefined);

    expect(result).toEqual({ outcome: "not_applicable" });
  });

  it("no client-controlled role/admin flag can influence the outcome — only the server-verified email and INITIAL_ADMIN_EMAIL matter", async () => {
    process.env.INITIAL_ADMIN_EMAIL = "founder@example.com";
    installAccountCreate();
    const { bootstrapInitialAdminIfEligible } = await import("../initial-admin-bootstrap");

    // bootstrapInitialAdminIfEligible's signature only ever accepts
    // (verifiedEmail, verifiedName) — there is no role/isAdmin parameter
    // for a caller to supply at all, so this is a structural guarantee,
    // proven by TypeScript's own type-checking of this call site rather
    // than a runtime assertion.
    const result = await bootstrapInitialAdminIfEligible("founder@example.com", undefined);
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(result.account.role).toBe("ADMIN"); // always hardcoded, never derived from any input
    }
  });
});
