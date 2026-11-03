/**
 * The kinds of held-out failure and their words (goal 082), for the judge, the agents and the
 * owner's screens alike (goal 125, T1). A closed list: nothing a run printed becomes a kind. And
 * one held-out cell's result, as the judge's `held_out_checked` event gives it to control.
 */

/** How one held-out cell failed. A closed list: nothing a run printed becomes a kind. */
export const HELD_OUT_KINDS = [
  "threshold_missed",
  "timed_out",
  "crashed",
  "check_failed",
  "non_finite",
  "no_cell",
] as const;
export type HeldOutKind = (typeof HELD_OUT_KINDS)[number];

/** The agents' words for each kind: that a held-out check failed, and how, never which or why. */
export const HELD_OUT_WORDS: Record<HeldOutKind, string> = {
  threshold_missed: "a held-out check missed its threshold",
  timed_out: "a held-out check timed out",
  crashed: "a held-out check crashed",
  check_failed: "a held-out check failed the kit's check",
  non_finite: "a held-out check gave no finite value",
  no_cell: "a held-out check names a cell the kit does not have",
};

/** The owner's words for each kind, after the cell's name. */
export const HELD_OUT_OWNER_WORDS: Record<HeldOutKind, string> = {
  threshold_missed: "missed its threshold",
  timed_out: "timed out",
  crashed: "crashed",
  check_failed: "failed the kit's check",
  non_finite: "gave no finite value",
  no_cell: "is not in the kit",
};

/**
 * The agents' words for a failed held-out check: each kind once, such as "a held-out check
 * timed out; a held-out check missed its threshold". A record from before goal 082 has no
 * kinds: "a held-out check failed".
 */
export function heldOutWords(kinds: readonly HeldOutKind[]): string {
  return kinds.length ? kinds.map((k) => HELD_OUT_WORDS[k]).join("; ") : "a held-out check failed";
}

/** One held-out cell's result, as the owner sees it. */
export interface HeldOutCell {
  cell: string;
  /** Goal campaigns: the threshold goal it was checked for, or the kit's verifier it ran in. */
  goal?: string | undefined;
  verifier?: string | undefined;
  ok: boolean;
  /** How it failed, when it did. */
  kind?: HeldOutKind | undefined;
  /**
   * The measured value and the threshold it is held to, where the check gives one: a goal's
   * metric threshold (its mean, and its interval), or a hill climb's ratio to the champion.
   */
  value?: number | undefined;
  low?: number | undefined;
  high?: number | undefined;
  threshold?: number | undefined;
  op?: ">=" | ">" | "<=" | "<" | undefined;
  /** What the value measures, in words, and its unit. */
  measure?: string | undefined;
  unit?: string | undefined;
}

/** The most held-out cells one event names; the held_out table keeps them all. */
export const HELD_OUT_EVENT_CELLS = 50;

/**
 * The kinds of failure among some cells, each once, in the list's order: a record's, or the
 * cells control read from an event.
 */
export function heldOutKinds(
  cells: readonly { ok: boolean; kind?: string | null | undefined }[],
): HeldOutKind[] {
  const found = new Set(cells.filter((c) => !c.ok && c.kind).map((c) => c.kind));
  return HELD_OUT_KINDS.filter((k) => found.has(k));
}
