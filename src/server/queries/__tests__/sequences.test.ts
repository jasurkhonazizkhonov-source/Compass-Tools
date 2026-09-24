import { describe, it, expect, vi, beforeEach } from "vitest";

// Real, measured inefficiency found and fixed: getSequences() used to fetch
// the actual row ids of every ACTIVE SequenceEnrollment for every sequence
// on the page just to compute an "Active Enrollments" count via
// `.length` — for a popular always-on sequence enrolled against thousands
// of leads, that fetched thousands of rows purely to count them, right
// next to a `_count` on the same query proving the count could already be
// had without fetching rows. Now computed via one small, batched groupBy
// instead of per-row fetching. These tests prove the active count is
// correct and that only one groupBy call happens for the whole page (not
// one per sequence).

vi.mock("@/lib/pagination", () => ({
  resolvePageSize: (n: number | undefined) => n ?? 25,
}));

vi.mock("@/server/visibility", () => ({
  sequenceVisibilityWhere: () => ({}),
}));

const findMany = vi.fn();
const count = vi.fn();
const groupBy = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    sequence: { findMany: (...args: unknown[]) => findMany(...args), count: (...args: unknown[]) => count(...args) },
    sequenceEnrollment: { groupBy: (...args: unknown[]) => groupBy(...args) },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getSequences — active enrollment count", () => {
  it("computes the active-enrollment count per sequence via one batched groupBy, not per-row fetching", async () => {
    findMany.mockResolvedValue([
      { id: "seq-1", name: "Nurture", _count: { enrollments: 500 } },
      { id: "seq-2", name: "Follow-up", _count: { enrollments: 10 } },
    ]);
    count.mockResolvedValue(2);
    groupBy.mockResolvedValue([
      { sequenceId: "seq-1", _count: { _all: 42 } },
      { sequenceId: "seq-2", _count: { _all: 3 } },
    ]);

    const { getSequences } = await import("../sequences");
    const result = await getSequences({ viewer: { id: "acct-1", role: "ADMIN", companyId: "company-1" } });

    expect(result.sequences[0].activeEnrollmentCount).toBe(42);
    expect(result.sequences[1].activeEnrollmentCount).toBe(3);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["sequenceId"],
        where: { sequenceId: { in: ["seq-1", "seq-2"] }, status: "ACTIVE" },
      })
    );
  });

  it("a sequence with zero active enrollments gets 0, not undefined", async () => {
    findMany.mockResolvedValue([{ id: "seq-1", name: "Quiet", _count: { enrollments: 5 } }]);
    count.mockResolvedValue(1);
    groupBy.mockResolvedValue([]); // no ACTIVE rows for seq-1 at all

    const { getSequences } = await import("../sequences");
    const result = await getSequences({ viewer: { id: "acct-1", role: "ADMIN", companyId: "company-1" } });

    expect(result.sequences[0].activeEnrollmentCount).toBe(0);
  });

  it("never calls groupBy when the page has zero sequences", async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    const { getSequences } = await import("../sequences");
    await getSequences({ viewer: { id: "acct-1", role: "ADMIN", companyId: "company-1" } });

    expect(groupBy).not.toHaveBeenCalled();
  });
});
