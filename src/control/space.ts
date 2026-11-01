import { dirname, join } from "node:path";
import { copiesOf } from "../common/db-copy.ts";
import { errorText } from "../common/errors.ts";
import { folderBytes } from "../common/fs.ts";
import { CONTROL_STATE } from "../core/backup.ts";
import { EVENT_STREAM } from "../core/link/events.ts";
import { kindOf, type RetentionKind } from "../core/retention/index.ts";
import { type BusView, busState } from "./bus/index.ts";
import { controlItems } from "./retention/index.ts";
import type { ControlStore } from "./store/index.ts";

/**
 * The space each kind of what Thermite keeps takes (goal 125, T12), for Settings › Space and
 * /metrics: Thermite keeps everything that grows with history until a retention policy the owner
 * made removes it (core/retention/), so the owner can see where the disk goes, where each kind is
 * kept, and what removes it. Control's kinds are read from its folders; a rig's kinds are the sum
 * of what each rig last said it keeps (its `space` ask). A look walks control's folders, so it is
 * made at most once in SPACE_LOOK_MS, and the next asks get that look.
 */

/** Where a kind is kept, as the Space table's "Kept on" says it. */
type SpaceOn = "Control" | "Rigs" | "Supervisors";

interface SpaceKindInfo {
  label: string;
  on: SpaceOn;
  words: string;
  /** The retention kind whose policies remove it; none: no policy does. */
  policy?: RetentionKind;
  /** Removed only by hand, on the Exports page. */
  byHand?: true;
  /** Part of control's store, whose row counts it already: not added to the total again. */
  inStore?: true;
}

/** Each kind, in the order the page lists them: what it is, in words, and where it is kept. */
export const SPACE_KINDS = {
  events: {
    label: kindOf("events").label,
    on: "Control",
    policy: "events",
    words: `${kindOf("events").words} Control reads its views from it at each start.`,
  },
  exports: {
    label: "Rigs' exports",
    on: "Control",
    byHand: true,
    words:
      "The exports that rigs without a results repository send control, in its exports folder: each one's events, attempts, ledger copies and research folders. Removed only by hand, on the Exports page.",
  },
  store: {
    label: "Control's store",
    on: "Control",
    words:
      "control.db, with its write-ahead log: rigs, runs, commands, the agents' model usage, the audit log and the knowledge base's items.",
  },
  kb_versions: {
    label: "Older versions of knowledge-base items",
    on: "Control",
    policy: "kb_versions",
    inStore: true,
    words: `${kindOf("kb_versions").words} Part of control's store, counted there.`,
  },
  audit: {
    label: "Audit log",
    on: "Control",
    policy: "audit",
    inStore: true,
    words: `${kindOf("audit").words} Part of control's store, counted there.`,
  },
  copies: {
    label: "Copies of the store",
    on: "Control",
    policy: "store_copies",
    words: kindOf("store_copies").words,
  },
  kb_files: {
    label: "Knowledge base files",
    on: "Control",
    words: "The files of Thermite's knowledge base, each kept once by its SHA-256.",
  },
  kits: {
    label: "Kits",
    on: "Control",
    words: "The kits written or uploaded on the New campaign page, as Git repositories.",
  },
  builds: {
    label: kindOf("builds").label,
    on: "Rigs",
    policy: "builds",
    words: `${kindOf("builds").words} The sum of what each rig last said it keeps.`,
  },
  trial_logs: {
    label: kindOf("trial_logs").label,
    on: "Rigs",
    policy: "trial_logs",
    words: `${kindOf("trial_logs").words} The sum of what each rig last said it keeps.`,
  },
  advisor_records: {
    label: kindOf("advisor_records").label,
    on: "Supervisors",
    policy: "advisor_records",
    words: `${kindOf("advisor_records").words} The sum of what each rig last said it keeps.`,
  },
} as const satisfies Record<string, SpaceKindInfo>;

type SpaceKind = keyof typeof SPACE_KINDS;

/** A kind's facts, typed as every kind's. */
export const spaceKindOf = (k: SpaceKind): SpaceKindInfo => SPACE_KINDS[k];

/** One kind's space: its bytes, or why they could not be read. */
export interface SpaceUse {
  kind: SpaceKind;
  bytes: number | null;
  error?: string;
  /** A rig's kind: how many rigs said what they keep of it. */
  rigs?: number;
}

/** The bytes of every kind not counted in another's row: the Space table's total. */
export function spaceTotal(uses: readonly SpaceUse[]): number {
  return uses
    .filter((u) => u.bytes !== null && !spaceKindOf(u.kind).inStore)
    .reduce((n, u) => n + (u.bytes ?? 0), 0);
}

/** How long one look stands: a look walks control's folders. */
export const SPACE_LOOK_MS = 60_000;

/** Each store's last look, and when it was made. */
const LOOKS = new WeakMap<ControlStore, { at: number; uses: SpaceUse[] }>();

/** One kind's bytes, read now; a failure is said, and the other kinds go on. */
async function use(kind: SpaceKind, bytes: () => number | Promise<number>): Promise<SpaceUse> {
  try {
    return { kind, bytes: await bytes() };
  } catch (err) {
    return { kind, bytes: null, error: errorText(err) };
  }
}

/**
 * The space each kind takes, from the look made in the last SPACE_LOOK_MS, or a new one. A store
 * in memory (a test's) has no folders: its kinds on disk take 0.
 */
export async function spaceOf(
  store: ControlStore,
  bus: BusView | undefined,
  now = Date.now(),
): Promise<SpaceUse[]> {
  const kept = LOOKS.get(store);
  if (kept && now - kept.at < SPACE_LOOK_MS) return kept.uses;
  const onDisk = store.path !== ":memory:";
  const dir = dirname(store.path);
  const at = (name: string) => (onDisk ? folderBytes(join(dir, name)) : 0);
  const uses = await Promise.all([
    use("events", async () => {
      const state = await busState(store, bus);
      if (!state.on) return 0;
      if (state.error) throw new Error(`the message bus: ${state.error}`);
      const events = state.streams.find((s) => s.name === EVENT_STREAM);
      if (!events) throw new Error("the message bus has no EVENTS stream");
      return events.bytes;
    }),
    use("exports", () => at(CONTROL_STATE.exports)),
    use("store", () => (onDisk ? folderBytes(store.path) + folderBytes(`${store.path}-wal`) : 0)),
    use("copies", () =>
      onDisk ? copiesOf(store.path).reduce((n, c) => n + folderBytes(c.path), 0) : 0,
    ),
    use("kb_files", () => at(CONTROL_STATE.kbFiles)),
    use("kits", () => at(CONTROL_STATE.kits)),
  ]);
  // Inside control's store: the bytes of the rows a policy may remove.
  const sum = (kind: RetentionKind) => controlItems(store, kind).reduce((n, x) => n + x.bytes, 0);
  uses.splice(
    3,
    0,
    await use("kb_versions", () => sum("kb_versions")),
    await use("audit", () => sum("audit")),
  );
  // A rig's kinds: the sum of what each rig not retired last said it keeps.
  const spaces = [...store.retention.spaces()].filter(([rig]) => !store.retired.get(rig));
  for (const kind of ["builds", "trial_logs", "advisor_records"] as const) {
    const said = spaces.flatMap(([, s]) => (s.kinds[kind] ? [s.kinds[kind]] : []));
    uses.push({ kind, bytes: said.reduce((n, inv) => n + inv.bytes, 0), rigs: said.length });
  }
  LOOKS.set(store, { at: now, uses });
  return uses;
}
