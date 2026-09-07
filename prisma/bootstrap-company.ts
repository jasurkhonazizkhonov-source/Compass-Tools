// One-time operational script for standing up a brand-new company's
// database — NOT wired into the running app, NOT run automatically by any
// migration. Run this manually, once, against a freshly-migrated, EMPTY
// database, before the first person ever tries to sign in.
//
// Why this script exists: Compass Tools' two-layer auth model requires an
// ACTIVE Account row to already exist before Google Sign-In grants access
// (see src/server/auth/google-authorization.ts — "Google auth succeeding
// is NOT enough on its own"). But creating an Account normally requires
// already being a signed-in Admin (src/server/actions/accounts.ts's
// assertAdmin()). On a brand-new database with zero accounts, that's
// circular — nobody can ever sign in. This script breaks that circularity
// by creating exactly one Company row and one ACTIVE Admin Account
// directly against the database, outside the app's own authorization
// chain. See docs/DEPLOYMENT.md for the full new-company walkthrough.
//
// Usage:
//   npx tsx prisma/bootstrap-company.ts \
//     --company-name "ABC Travel Agency" \
//     --admin-name "Jane Smith" \
//     --admin-email "jane@abctravel.com" \
//     [--website "https://abctravel.com"] \
//     [--phone "+1 555 000 0000"]
//
// The admin-email must be the exact Google account the first admin will
// sign in with — it's matched case-insensitively against the verified
// Google email at login (see authorizeGoogleUser()'s normalizeEmail()).
// Company branding beyond name/website/phone (logo, brand color, email
// signature) is left at sensible defaults — the new admin configures the
// rest themselves via the already-built /company settings page after
// their first login.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

function connectionStringWithoutSslMode(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  return u.toString();
}

const adapter = new PrismaPg({
  connectionString: connectionStringWithoutSslMode(process.env.DATABASE_URL!),
  ssl: { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter });

function readArg(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const companyName = readArg("company-name");
  const adminName = readArg("admin-name");
  const adminEmail = readArg("admin-email");
  const website = readArg("website");
  const phone = readArg("phone");

  if (!companyName || !adminName || !adminEmail) {
    console.error(
      "Usage: npx tsx prisma/bootstrap-company.ts --company-name \"ABC Travel Agency\" --admin-name \"Jane Smith\" --admin-email \"jane@abctravel.com\" [--website \"https://...\"] [--phone \"+1 555 000 0000\"]"
    );
    process.exit(1);
  }

  // Safety guard: refuse to run against a database that already has
  // accounts — this script is only for a brand-new, empty deployment.
  // Re-running it against an existing company's database would create a
  // second, disconnected Company row this app's single-Company-per-DB
  // assumption doesn't expect. Adding a second admin to an EXISTING
  // company should go through the normal in-app /users flow instead.
  const existingAccountCount = await prisma.account.count();
  if (existingAccountCount > 0) {
    console.error(
      `Refusing to run — this database already has ${existingAccountCount} account(s). ` +
        "This script is only for bootstrapping a brand-new, empty deployment. " +
        "To add another admin to an existing company, sign in and use the /users page instead."
      );
    process.exit(1);
  }

  const company = await prisma.company.create({
    data: {
      name: companyName,
      website: website || null,
      phone: phone || null,
      brandColor: "#1c3a5e",
      signatureTemplate: "Best regards,\n{{first_name}} {{last_name}}\n{{phone_number}}",
    },
  });

  const admin = await prisma.account.create({
    data: {
      fullName: adminName,
      email: adminEmail,
      role: "ADMIN",
      status: "ACTIVE",
      companyId: company.id,
    },
  });

  console.log(`Created company "${company.name}" (id: ${company.id})`);
  console.log(`Created admin account "${admin.fullName}" <${admin.email}> (id: ${admin.id})`);
  console.log("This person can now sign in with Google using that exact email address.");
  console.log("After first login, configure logo/brand color/email signature via the /company page.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
