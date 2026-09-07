import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

declare global {
  var __prisma: PrismaClient | undefined;
}

function connectionStringWithoutSslMode(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  return u.toString();
}

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: connectionStringWithoutSslMode(process.env.DATABASE_URL!),
    // Aiven's managed Postgres uses a CA not in Node's default trust store.
    // Encrypted-but-unverified is an accepted tradeoff for this dev/test DB.
    ssl: { rejectUnauthorized: false },
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalThis.__prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
