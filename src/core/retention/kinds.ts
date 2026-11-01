import { listText } from "../words.ts";

/**
 * The kinds a retention policy may remove (index.ts): where each is kept, its words, its warning,
 * and what a policy may always keep of it; and what no policy removes.
 */

/** Where each kind is kept, and so which part removes it. */
type KeptOn = "control" | "rigs" | "supervisors";

/** What a policy may keep of its kind, whatever the rule says. */
export type KeepKey = "open" | "champions" | "newest";

interface KindInfo {
  label: string;
  on: KeptOn;
  /** The kind's unit, in words: "builds"; `one`, for one of them: "build". */
  unit: string;
  one: string;
  /** What the kind is, in words, under its label's ⓘ. */
  words: string;
  /** What is lost with it, said beside the kind when a policy is made for it. */
  warn?: string;
  /** What a policy of this kind may always keep, each in words: none for a kind without. */
  keeps: Partial<Record<KeepKey, string>>;
}

/**
 * Each kind a policy may remove, in the order the page lists them. The rigs' kinds are removed on
 * each rig (the harness, or its supervisor) when control's signed command asks; control's kinds by
 * control itself.
 */
const RETENTION_KINDS = {
  builds: {
    label: "Judge's builds",
    on: "rigs",
    unit: "builds",
    one: "build",
    words:
      "The builds the judge made of each candidate, on each rig's volume. A build removed is made again if it is ever needed: its commit and its kit stay.",
    keeps: { champions: "Each lane's champion builds", open: "Builds of runs still open" },
  },
  advisor_records: {
    label: "Advisors' records",
    on: "supervisors",
    unit: "records",
    one: "record",
    words:
      "The records of each round of the auditor, the teachers, the review panel and the paper's writers, and their conversations kept before each compaction, on each rig's supervisor. Their decisions stay in the ledger.",
    keeps: { open: "Records of runs still open" },
  },
  kb_versions: {
    label: "Older versions of knowledge-base items",
    on: "control",
    unit: "versions",
    one: "version",
    words:
      "Versions of an item that a newer version replaced. The newest version of each item always stays.",
    keeps: {},
  },
  store_copies: {
    label: "Copies of control's store",
    on: "control",
    unit: "copies",
    one: "copy",
    words:
      "control.db as it was before each update that changed its tables, kept beside it so an update can be undone. Control keeps the two newest.",
    keeps: { newest: "The newest copy" },
  },
  audit: {
    label: "Audit log",
    on: "control",
    unit: "entries",
    one: "entry",
    words: "Who did what, and when, on control.",
    warn: "Entries removed can't be shown again. Each removal by a policy is itself written to the audit log, and that entry stays.",
    keeps: {},
  },
} as const satisfies Record<string, KindInfo>;

export type RetentionKind = keyof typeof RETENTION_KINDS;
export const RETENTION_KIND_KEYS = Object.keys(RETENTION_KINDS) as RetentionKind[];

/** The kind's facts, typed as every kind's. */
export const kindOf = (k: RetentionKind): KindInfo => RETENTION_KINDS[k];

/** Whether a kind is kept on rigs (or their supervisors): a policy of it says where. */
export const onRigs = (k: RetentionKind): boolean => kindOf(k).on !== "control";

/** The kinds kept on rigs, which each rig reports with their space. */
export const RIG_KINDS = RETENTION_KIND_KEYS.filter(onRigs);

/** What a rig never loses to a policy, and why: the page's "Never removed by a policy". */
export const NEVER_REMOVED = [
  {
    label: "Rigs' ledgers",
    words:
      "Each event's hash holds the one before it, and the judge's verdicts are checked against the chain. Removing any event would break it.",
  },
  {
    label: "Results repositories",
    words: "Your project's own Git repository. Thermite pushes to it and never removes from it.",
  },
  {
    label: "Exports",
    words: "Removed only by hand, on the Exports page.",
  },
] as const;

/** The kinds' labels, in words: for a refusal that names them. */
export const KINDS_WORDS = listText(RETENTION_KIND_KEYS.map((k) => `${k} (${kindOf(k).label})`));
