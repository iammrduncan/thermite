import { LedgerError } from "../ledger/index.ts";

/** The checks of a set of rules (directives) the owner or an advisor sends, moved out of service.ts. */

/** A directive set may not both avoid a direction and ask for it. */
export function conflictCheck(set: { kind: string; family?: string | undefined }[]): void {
  const avoid = new Set(set.filter((d) => d.kind === "avoid" && d.family).map((d) => d.family));
  const both = set.filter(
    (d) => (d.kind === "try" || d.kind === "mandate") && d.family && avoid.has(d.family),
  );
  if (both.length) {
    throw new LedgerError(
      "invalid",
      `the set both avoids and asks for ${both.map((d) => d.family).join(", ")}`,
    );
  }
}

/** The directions a set of rules names that the run does not have (goal 066), in order. */
export function unknownIn(
  set: { family?: string | undefined }[],
  known: readonly string[],
): string[] {
  const out: string[] = [];
  for (const d of set)
    if (d.family && !known.includes(d.family) && !out.includes(d.family)) out.push(d.family);
  return out;
}
