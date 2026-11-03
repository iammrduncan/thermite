import { LedgerError } from "../ledger/index.ts";

/** The checks of a set of rules (directives) the owner or an advisor sends, moved out of service.ts. */

/** A directive set may not both avoid a direction and ask for it. */
export function conflictCheck(set: { kind: string; direction?: string | undefined }[]): void {
  const avoid = new Set(
    set.filter((d) => d.kind === "avoid" && d.direction).map((d) => d.direction),
  );
  const both = set.filter(
    (d) => (d.kind === "try" || d.kind === "mandate") && d.direction && avoid.has(d.direction),
  );
  if (both.length) {
    throw new LedgerError(
      "invalid",
      `the set both avoids and asks for ${both.map((d) => d.direction).join(", ")}`,
    );
  }
}

/** The directions a set of rules names that the run does not have (goal 066), in order. */
export function unknownIn(
  set: { direction?: string | undefined }[],
  known: readonly string[],
): string[] {
  const out: string[] = [];
  for (const d of set)
    if (d.direction && !known.includes(d.direction) && !out.includes(d.direction))
      out.push(d.direction);
  return out;
}
