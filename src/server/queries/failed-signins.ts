import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { businessDayKey, businessDayRange } from "@/lib/business-time";
import { resolvePageSize } from "@/lib/pagination";
import { FAILED_SIGNIN_REASON_CODES } from "@/lib/failed-signin";

// Reads of the failed sign-in log. ADMIN ONLY: callers (the page and the actions) check the role first; nothing here is reachable without that check.
// Server-side pagination, filtering and counting: the browser never receives more than one page.

export type FailedSignInFilters = {
  q?: string;
  /** yyyy-MM-dd business days, inclusive */
  from?: string;
  to?: string;
  reason?: string;
  method?: string;
  ip?: string;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clip = (s: string | undefined, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "");

/** Builds the WHERE clause for an Administrator of `companyId`: events for their company or events not tied to any company (identity could not be verified). */
export function failedSignInWhere(companyId: string, f: FailedSignInFilters): Prisma.FailedSignInEventWhereInput {
  const and: Prisma.FailedSignInEventWhereInput[] = [{ OR: [{ companyId }, { companyId: null }] }];
  const q = clip(f.q, 120);
  if (q) {
    and.push({
      OR: [
        { id: q },
        { verifiedFullName: { contains: q, mode: "insensitive" } },
        { verifiedEmail: { contains: q, mode: "insensitive" } },
        { attemptedEmail: { contains: q, mode: "insensitive" } },
        { ipAddress: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  const ip = clip(f.ip, 45);
  if (ip) and.push({ ipAddress: ip });
  if (f.reason && (FAILED_SIGNIN_REASON_CODES as string[]).includes(f.reason)) and.push({ reasonCode: f.reason });
  if (f.method && /^[A-Z_]{2,30}$/.test(f.method)) and.push({ method: f.method });
  const range: { gte?: Date; lt?: Date } = {};
  if (f.from && DAY.test(f.from)) range.gte = businessDayRange(f.from).start;
  if (f.to && DAY.test(f.to)) range.lt = businessDayRange(f.to).end;
  if (range.gte || range.lt) and.push({ occurredAt: range });
  return { AND: and };
}

export type FailedSignInRow = {
  id: string;
  occurredAt: Date;
  method: string;
  reasonCode: string;
  attemptedEmail: string | null;
  verifiedEmail: string | null;
  verifiedFullName: string | null;
  ipAddress: string | null;
  ipVersion: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  geoSource: string | null;
  repeatCount: number;
};

export type FailedSignInPage = {
  rows: FailedSignInRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Total events per business day for the days present on this page (for the "N failed attempts" group headings). */
  dayTotals: Record<string, number>;
  /** Plain-language security indicators per event id, calculated from the recorded events. */
  indicators: Record<string, string[]>;
};

const SELECT = {
  id: true, occurredAt: true, method: true, reasonCode: true, attemptedEmail: true, verifiedEmail: true, verifiedFullName: true, ipAddress: true, ipVersion: true,
  city: true, region: true, country: true, countryCode: true, geoSource: true, repeatCount: true,
} as const;

export async function getFailedSignInPage(params: { companyId: string; filters: FailedSignInFilters; page?: number; pageSize?: number; now?: Date }): Promise<FailedSignInPage> {
  const page = Math.max(1, Math.trunc(params.page ?? 1) || 1);
  const pageSize = resolvePageSize(params.pageSize);
  const where = failedSignInWhere(params.companyId, params.filters);
  const [rows, total] = await Promise.all([
    prisma.failedSignInEvent.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize, select: SELECT }),
    prisma.failedSignInEvent.count({ where }),
  ]);

  const days = [...new Set(rows.map((r) => businessDayKey(r.occurredAt)))];
  const dayCounts = await Promise.all(
    days.map(async (day) => {
      const { start, end } = businessDayRange(day);
      return [day, await prisma.failedSignInEvent.count({ where: { AND: [where, { occurredAt: { gte: start, lt: end } }] } })] as const;
    })
  );

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), dayTotals: Object.fromEntries(dayCounts), indicators: await indicatorsFor(rows, params.now ?? new Date()) };
}

export async function getFailedSignInEvent(companyId: string, id: string): Promise<FailedSignInRow | null> {
  if (typeof id !== "string" || !id || id.length > 64) return null;
  return prisma.failedSignInEvent.findFirst({ where: { id, OR: [{ companyId }, { companyId: null }] }, select: SELECT });
}

/**
 * Indicators, calculated from the recorded events themselves (no second store): a burst from one address, many different accounts tried from one address, one
 * account tried from many addresses. Bounded: only the addresses/accounts on the current page are examined.
 */
export async function indicatorsFor(rows: Pick<FailedSignInRow, "id" | "ipAddress" | "verifiedEmail" | "attemptedEmail">[], now: Date): Promise<Record<string, string[]>> {
  const ips = [...new Set(rows.map((r) => r.ipAddress).filter((v): v is string => !!v))].slice(0, 50);
  const emails = [...new Set(rows.map((r) => r.verifiedEmail ?? r.attemptedEmail).filter((v): v is string => !!v))].slice(0, 50);
  const tenMin = new Date(now.getTime() - 10 * 60_000);
  const day = new Date(now.getTime() - 24 * 3600_000);
  const [burst, perIp, perEmail] = await Promise.all([
    ips.length ? prisma.failedSignInEvent.groupBy({ by: ["ipAddress"], where: { ipAddress: { in: ips }, occurredAt: { gte: tenMin } }, _sum: { repeatCount: true } }) : [],
    ips.length ? prisma.failedSignInEvent.groupBy({ by: ["ipAddress", "verifiedEmail"], where: { ipAddress: { in: ips }, occurredAt: { gte: day }, verifiedEmail: { not: null } } }) : [],
    emails.length ? prisma.failedSignInEvent.groupBy({ by: ["verifiedEmail", "ipAddress"], where: { verifiedEmail: { in: emails }, occurredAt: { gte: day }, ipAddress: { not: null } } }) : [],
  ]);
  const burstByIp = new Map(burst.map((b) => [b.ipAddress, b._sum.repeatCount ?? 0]));
  const accountsByIp = new Map<string, number>();
  for (const g of perIp) if (g.ipAddress) accountsByIp.set(g.ipAddress, (accountsByIp.get(g.ipAddress) ?? 0) + 1);
  const ipsByEmail = new Map<string, number>();
  for (const g of perEmail) if (g.verifiedEmail) ipsByEmail.set(g.verifiedEmail, (ipsByEmail.get(g.verifiedEmail) ?? 0) + 1);

  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const notes: string[] = [];
    const n = r.ipAddress ? burstByIp.get(r.ipAddress) ?? 0 : 0;
    if (n >= 5) notes.push(`${n} attempts from this address in the last 10 minutes`);
    const accounts = r.ipAddress ? accountsByIp.get(r.ipAddress) ?? 0 : 0;
    if (accounts >= 3) notes.push(`${accounts} different accounts tried from this address in 24 hours`);
    const addrs = r.verifiedEmail ? ipsByEmail.get(r.verifiedEmail) ?? 0 : 0;
    if (addrs >= 3) notes.push(`this account was tried from ${addrs} different addresses in 24 hours`);
    if (notes.length) out[r.id] = notes;
  }
  return out;
}
