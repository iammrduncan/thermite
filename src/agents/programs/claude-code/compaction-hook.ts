import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { claudeCompactions, readOwn } from "../../compaction/index.ts";

/**
 * Claude Code's compaction hooks (goal 070), as one program. Thermite's settings for the run
 * (`--settings`) name it twice:
 *
 * - `claude <folder> <line>`, the PreCompact hook: Claude Code 2.1.305 runs it before each
 *   compaction, with the session's transcript path on stdin, and appends what it prints to the
 *   compaction's own instructions. It copies the transcript, the whole conversation before this
 *   compaction, to `<folder>/<n>.jsonl`, and prints the line, with `{n}` replaced by
 *   the compaction's number, which tells the summary where Thermite keeps the conversation.
 * - `claude-post <folder>`, the PostCompact hook: Claude Code runs it after the compaction, with
 *   the summary on stdin (empty where Claude Code applies a summary it made earlier). It keeps
 *   the summary as `<folder>/<n>.summary.md`, for the compaction's record.
 *
 * Claude Code keeps its transcript private to the agent's user (mode 0600, in folders of mode
 * 0700), so Thermite's own code reads these copies instead, once Claude Code reports the
 * compaction, and keeps the conversation where the agents read it (compaction/conversation.ts,
 * the harness's compactions.ts). The hooks run as the agent's own user, under the same limits,
 * read only its own transcript, write only in the folder given, and reach no network. They never
 * stand in the compaction's way: whatever fails, they exit 0.
 *
 * Claude Code 2.1.305 queues the lines of its transcript and writes them every 100 ms
 * (FLUSH_INTERVAL_MS in its code), and runs the PreCompact hook without writing them first: when
 * the hook starts, the newest lines (often the last tool's result) are not in the file yet, and
 * early in a session the file itself may not be there. Claude Code goes on writing while it waits
 * for the hook, so the hook copies the transcript only once it has settled (SETTLE).
 *
 * `n` counts the compactions the transcript already shows, plus one, so it matches the count
 * Thermite keeps from Claude Code's output: a compaction that fails leaves no boundary, and the
 * next one copies under the same number. The PostCompact hook takes the number of the last copy.
 */

/** The placeholder for the compaction's number in the line the hook prints. */
export const NUMBER = "{n}";

/** The largest transcript the hook copies, in bytes (a longer one is cut at a whole line). */
const HOOK_MAX = 256 * 1024 * 1024;

/**
 * How long the PreCompact hook waits for the transcript to settle: until the file is there and its
 * size has not changed for `quietMs` (three of Claude Code's writes), checked every `stepMs`; at
 * most `maxMs`, then it copies what is there.
 */
export interface Settle {
  quietMs: number;
  maxMs: number;
  stepMs: number;
}
export const SETTLE: Settle = { quietMs: 300, maxMs: 5_000, stepMs: 50 };

/** A regular file's size (never through a link), or -1 when there is none. */
function sizeOf(path: string): number {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

/**
 * Waits until the file at `path` is there and has not grown for `wait.quietMs`, or for
 * `wait.maxMs` at most. Returns how long it waited, in milliseconds.
 */
export async function settled(path: string, wait: Settle = SETTLE): Promise<number> {
  const start = Date.now();
  let last = sizeOf(path);
  let since = start;
  while (Date.now() - start < wait.maxMs) {
    await sleep(wait.stepMs);
    const now = sizeOf(path);
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (now >= 0 && Date.now() - since >= wait.quietMs) break;
  }
  return Date.now() - start;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const fields = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** Writes a file whole or not at all, readable by Thermite's own user. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}

/** The numbers of the hook's records in `drops` with this suffix (`.jsonl`, `.meta.json`). */
function numbers(drops: string, suffix: string): number[] {
  try {
    return readdirSync(drops)
      .filter((f) => f.endsWith(suffix) && /^\d+$/.test(f.slice(0, -suffix.length)))
      .map((f) => Number(f.slice(0, -suffix.length)));
  } catch {
    return [];
  }
}

/**
 * Claude Code's PreCompact hook: copies the transcript to `drops` once it has settled, and returns
 * the line to print. `input`: the hook's input (`session_id`, `transcript_path`, `trigger`).
 */
export async function claudePreCompact(
  input: unknown,
  drops: string,
  line: string,
  wait: Settle = SETTLE,
): Promise<string> {
  const i = fields(input);
  const path = str(i.transcript_path);
  const named = Boolean(path) && isAbsolute(path);
  const waited = named ? await settled(path, wait) : 0;
  const text = named ? readOwn(path, HOOK_MAX) : undefined;
  // No transcript to count from: after the copies already made.
  const n =
    text !== undefined ? claudeCompactions(text) + 1 : numbers(drops, ".meta.json").length + 1;
  try {
    mkdirSync(drops, { recursive: true, mode: 0o755 });
    chmodSync(drops, 0o755);
    if (text !== undefined) writeAtomic(join(drops, `${n}.jsonl`), text);
    writeAtomic(
      join(drops, `${n}.meta.json`),
      JSON.stringify({
        session_id: str(i.session_id),
        transcript_path: path,
        trigger: str(i.trigger),
        at: new Date().toISOString(),
        waited_ms: waited,
        copied: text !== undefined,
      }),
    );
  } catch {
    // The conversation as Thermite saw it is kept instead (compaction/cli.ts).
  }
  return line.split(NUMBER).join(String(n));
}

/**
 * Claude Code's PostCompact hook: keeps the summary of the compaction the PreCompact hook last
 * copied for, as `<n>.summary.md` in `drops`. Returns its number, or undefined when there is no
 * summary or no copy.
 */
export function claudePostCompact(input: unknown, drops: string): number | undefined {
  const summary = str(fields(input).compact_summary).trim();
  const n = Math.max(0, ...numbers(drops, ".meta.json"));
  if (!summary || !n) return undefined;
  try {
    writeAtomic(join(drops, `${n}.summary.md`), `${summary}\n`);
    return n;
  } catch {
    return undefined;
  }
}

/**
 * Run as a program: `node compaction-hook.js claude <folder> <line>` (PreCompact) or
 * `node compaction-hook.js claude-post <folder>` (PostCompact), the hook's input on stdin.
 */
async function main(argv: string[]): Promise<void> {
  const [kind, drops, line] = argv;
  if ((kind !== "claude" && kind !== "claude-post") || !drops) return;
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    input = {};
  }
  if (kind === "claude-post") {
    // Nothing printed: Claude Code shows a PostCompact hook's output to the user only.
    claudePostCompact(input, drops);
    return;
  }
  const said = await claudePreCompact(input, drops, line ?? "");
  // Plain text, never JSON: Claude Code takes a hook's plain output as instructions.
  if (said.trim()) process.stdout.write(`${said.replace(/^\s*\{/, "(")}\n`);
}

const invoked = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href
    );
  } catch {
    return false;
  }
})();
if (invoked)
  void main(process.argv.slice(2))
    .catch(() => {
      // Never in the compaction's way.
    })
    .finally(() => {
      process.exitCode = 0;
    });
