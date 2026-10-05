// Argument rules for scripts/rotate-card-keys.ts, kept here so they can be tested. The tool is the ONLY way cards are
// re-encrypted and it can never be reached from a web request; these rules make a production run deliberate.
export type RotationCommand = { mode: "dry-run" | "apply" | "verify"; ids?: string[] } | { error: string };

export function parseRotationArgs(argv: string[]): RotationCommand {
  const flags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
  const known = new Set(["--apply", "--confirm", "--verify"]);
  const idsArg = argv.find((a) => a.startsWith("--ids="));
  for (const a of argv) {
    if (a.startsWith("--ids=")) continue;
    if (!known.has(a)) return { error: `Unknown argument "${a}". Use --verify, or --apply together with --confirm (and optionally --ids=<id,id> for a canary batch).` };
  }
  const apply = flags.has("--apply");
  const verify = flags.has("--verify");
  const confirm = flags.has("--confirm");
  const ids = idsArg ? idsArg.slice("--ids=".length).split(",").map((x) => x.trim()).filter(Boolean) : undefined;
  if (idsArg && (!ids || ids.length === 0)) return { error: "--ids= needs at least one payment-method id." };
  if (apply && verify) return { error: "--verify is read-only and cannot be combined with --apply." };
  if (verify && ids) return { error: "--verify always checks every stored card; it cannot be limited with --ids." };
  if (confirm && !apply) return { error: "--confirm only has meaning together with --apply." };
  if (apply && !confirm) {
    return { error: "Refusing to rotate without --confirm. Before running with --apply: take and verify a database backup, keep every old key in CARD_ENCRYPTION_KEYS, run this tool once WITHOUT --apply and review the counts, and consider a canary batch with --ids=." };
  }
  if (verify) return { mode: "verify" };
  return apply ? { mode: "apply", ids } : { mode: "dry-run", ids };
}
