import { lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { copiesOf } from "../common/db-copy.ts";
import { errorText } from "../common/errors.ts";
import { CONTROL_STATE } from "../core/backup.ts";
import { EVENT_STREAM } from "../core/link/events.ts";
import { type BusView, busState } from "./bus/index.ts";
import type { ControlStore } from "./store/index.ts";

/**
 * The space each kind of what control keeps takes (goal 125, T12), for Settings › Space and
 * /metrics: control keeps everything that grows with history, unless a setting says otherwise,
 * so the owner can see where its disk goes. A look walks control's folders, so it is made at
 * most once in SPACE_LOOK_MS, and the next asks get that look.
 */

/** Each kind, in the order the page lists them: what it is, in words. */
export const SPACE_KINDS = {
  events: {
    label: "Rigs' events",
    words:
      "Control's copy of every event its rigs reported, in the message bus's EVENTS stream. Control reads its views from it, and keeps it for good.",
  },
  exports: {
    label: "Rigs' exports",
    words:
      "The exports that rigs without a results repository send control, in its exports folder: each one's events, attempts, ledger copies and research folders.",
  },
  store: {
    label: "Control's store",
    words:
      "control.db, with its write-ahead log: rigs, runs, commands, the agents' model usage, the audit log and the knowledge base's items.",
  },
  copies: {
    label: "Copies of the store",
    words:
      "control.db as it was before each update that changed its tables, kept beside it so an update can be undone.",
  },
  kb_files: {
    label: "Knowledge base files",
    words: "The files of Thermite's knowledge base, each kept once by its SHA-256.",
  },
  kits: {
    label: "Kits",
    words: "The kits written or uploaded on the New campaign page, as Git repositories.",
  },
} as const;

type SpaceKind = keyof typeof SPACE_KINDS;

/** One kind's space: its bytes, or why they could not be read. */
export interface SpaceUse {
  kind: SpaceKind;
  bytes: number | null;
  error?: string;
}

/** How long one look stands: a look walks control's folders. */
export const SPACE_LOOK_MS = 60_000;

/** The bytes the files under `path` take, links not followed; 0 when there is nothing. */
export function folderBytes(path: string): number {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  if (!st.isDirectory()) return st.isFile() ? st.size : 0;
  let total = 0;
  for (const name of readdirSync(path)) total += folderBytes(join(path, name));
  return total;
}

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
  LOOKS.set(store, { at: now, uses });
  return uses;
}
