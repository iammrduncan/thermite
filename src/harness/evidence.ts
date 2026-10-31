import { type Evidence, evidenceOf, Registry } from "./agents/index.ts";
import { GitError, readableDiff, treeFile, treeFiles } from "./git.ts";
import { clipReason } from "./judge/index.ts";
import { type Ledger, LedgerError } from "./ledger/index.ts";
import type { ExperimentQueue } from "./queue.ts";
import { shownViolations, violationsOf } from "./v0.ts";

/**
 * What the teachers may read of a run's code and evidence (goal 081), read only: the champion's
 * tree, each attempt's diff, the judge's public findings on each attempt, and what became of each
 * experiment tried, with its cause.
 *
 * Held-out content stays out, by what is read and what is not:
 * - The code is the champion's commit in the run's project repository: the tree every worker
 *   starts from, and the diffs workers wrote. The kit (its cases, checks and references) is in
 *   another repository, which nothing here reads.
 * - The judge's findings are the planner's evidence (registry.ts, goal 082) with the judge's
 *   reasons: its verdict, its change and its reasons, the checks that refused an attempt before
 *   it was built, and, for a confirmation that failed on held-out cells, only the fixed words of
 *   how a held-out check failed. The judge writes held-out results only to its held_out table,
 *   never into a verdict's reasons, a measurement or an event; from that table nothing here gets
 *   more than those words: never a cell, its values, its inputs or its outputs. Nothing here
 *   reads measurements or the judge's jobs.
 */

/** The most entries one listing returns: narrow the folder for the rest. */
export const LIST_MAX = 2000;
/** The most lines one read of a file returns, and the default. */
export const READ_LINES_MAX = 2000;
export const READ_LINES_DEFAULT = 400;
/** The largest file read at all, in bytes. */
export const FILE_BYTES_MAX = 8 * 1024 * 1024;
/** The most characters of a diff one read returns. */
export const DIFF_CHARS = 40_000;

/** A path in a tree: from its top, no `..` part, no leading slash, nothing hidden by a NUL. */
export function treePath(path: string): string {
  const p = path
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (
    p.length > 500 ||
    p.startsWith("/") ||
    p.includes("\0") ||
    p.split("/").some((part) => part === ".." || part === ".")
  )
    throw new LedgerError("invalid", `not a path in the tree: ${path.slice(0, 120)}`);
  return p;
}

/**
 * The judge's public findings on one attempt: the planner's evidence (its hypothesis, verdict,
 * change, `refused` and `held_out`, goal 082), with the judge's reasons and the queue's
 * experiment it came from.
 */
export interface AttemptEvidence extends Evidence {
  /** The queue's experiment the attempt came from, when it had one. */
  experiment: { id: string; title: string } | null;
  /** The judge's reasons for its verdict (public: never a held-out result). */
  reasons: string | null;
  /** Only in one attempt's full evidence: its claim and its declared flaws. */
  claim?: string | null;
  known_flaws?: string[];
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** The planner's evidence of an attempt, with the judge's reasons and its experiment. */
function withReasons(ledger: Ledger, e: Evidence, reasonChars: number): AttemptEvidence {
  const v = ledger.verdicts.current(e.attempt);
  const reasons = v ? ledger.verdicts.get(v.id) : undefined;
  const x = ledger.experiments.ofAttempt(e.attempt);
  return {
    ...e,
    experiment: x ? { id: x.id, title: x.title } : null,
    reasons: reasons?.reasons ? clipReason(reasons.reasons, reasonChars) : null,
  };
}

/** The run's newest attempts with the judge's public findings, newest first. */
export function recentAttempts(
  ledger: Ledger,
  run: string,
  o: { limit: number; reasonChars: number },
): AttemptEvidence[] {
  return new Registry(ledger)
    .evidence(run, o.limit)
    .map((e) => withReasons(ledger, e, o.reasonChars));
}

/**
 * One attempt of the run, in full: the same shape, with its whole hypothesis, every violation
 * of a refused change, the judge's reasons as it kept them, its claim and its declared flaws.
 */
export function oneAttempt(ledger: Ledger, run: string, attempt: string): AttemptEvidence {
  const a = ledger.attempts.get(attempt);
  if (!a || String(a.run) !== run)
    throw new LedgerError("not_found", `no attempt ${attempt} in run ${run}`);
  const all = violationsOf(a.v0);
  return {
    ...withReasons(ledger, evidenceOf(ledger, a), 8000),
    hypothesis: str(a.hypothesis),
    ...(all.length ? { refused: shownViolations(all, all.length) } : {}),
    claim: str(a.claim),
    known_flaws: (() => {
      try {
        return JSON.parse(String(a.known_flaws ?? "[]")) as string[];
      } catch {
        return [];
      }
    })(),
  };
}
/** An experiment tried (done or dropped), with what became of it and why. */
export interface TriedCause {
  id: string;
  title: string;
  family?: string;
  by: string;
  lane?: string;
  /** done: how its trial ended; dropped: dropped. */
  result: string;
  attempt?: string;
  verdict?: string;
  delta?: number;
  /** Why it ended as it did, in words: the judge's reasons, the trial's error, or who dropped it. */
  cause: string;
}

/** The run's newest tried experiments, each with its cause, newest first. */
export function triedCauses(
  ledger: Ledger,
  queue: ExperimentQueue,
  run: string,
  o: { limit: number; causeChars: number },
): TriedCause[] {
  return queue.tried(run, o.limit).map((x) => {
    const base = {
      id: x.id,
      title: x.title,
      ...(x.family ? { family: x.family } : {}),
      by: x.added_by,
      ...(x.lane ? { lane: x.lane } : {}),
    };
    if (x.state === "dropped")
      return {
        ...base,
        result: "dropped",
        cause: clipReason(
          `dropped by ${x.dropped_by ?? "?"}: ${x.dropped_why ?? ""}`.trim(),
          o.causeChars,
        ),
      };
    if (x.attempt) {
      const e = withReasons(
        ledger,
        evidenceOf(
          ledger,
          (ledger.attempts.get(x.attempt) ?? { id: x.attempt, lifecycle: "unknown" }) as Row,
        ),
        o.causeChars,
      );
      const said = e.refused
        ? `refused before building: ${e.refused.violations.join("; ")}${e.refused.total > e.refused.violations.length ? `; and ${e.refused.total - e.refused.violations.length} more` : ""}`
        : e.held_out
          ? `${e.held_out}${e.reasons ? `; the judge: ${e.reasons}` : ""}`
          : e.reasons
            ? `the judge: ${e.reasons}`
            : `the attempt is ${e.lifecycle}`;
      return {
        ...base,
        result: x.result ?? "submitted",
        attempt: x.attempt,
        ...(e.verdict ? { verdict: e.verdict } : {}),
        ...(e.delta !== null ? { delta: e.delta } : {}),
        cause: clipReason(`${e.verdict ?? e.lifecycle}: ${said}`, o.causeChars),
      };
    }
    const t = x.trial ? ledger.trials.get(x.trial) : undefined;
    const how = x.result ?? t?.stopped ?? "ended";
    return {
      ...base,
      result: how,
      cause: clipReason(
        `no attempt: the trial ended ${how.replace(/_/g, " ")}${t?.error ? ` (${t.error})` : ""}`,
        o.causeChars,
      ),
    };
  });
}

/** The champion's tree: its files under a folder, with their sizes. */
export async function listChampionFiles(
  mirror: string,
  commit: string,
  folder: string,
): Promise<{ commit: string; folder: string; files: string[]; more: number; note?: string }> {
  const f = treePath(folder);
  const all = await treeFiles(mirror, commit, f);
  const files = all.slice(0, LIST_MAX).map((x) => `${x.path} (${x.size} bytes)`);
  return {
    commit,
    folder: f || ".",
    files,
    more: Math.max(0, all.length - LIST_MAX),
    ...(all.length
      ? all.length > LIST_MAX
        ? { note: `${all.length - LIST_MAX} more files: list a folder to see them` }
        : {}
      : { note: f ? `the champion has no folder or file ${f}` : "the champion's tree is empty" }),
  };
}

/** One file of the champion's tree, with line numbers, `limit` lines from line `offset`. */
export async function readChampionFile(
  mirror: string,
  commit: string,
  path: string,
  offset = 1,
  limit = READ_LINES_DEFAULT,
): Promise<{
  commit: string;
  path: string;
  size: number;
  total_lines?: number;
  from?: number;
  to?: number;
  content?: string;
  note?: string;
}> {
  const p = treePath(path);
  if (!p) throw new LedgerError("invalid", "name a file of the champion's tree");
  let got: Awaited<ReturnType<typeof treeFile>>;
  try {
    got = await treeFile(mirror, commit, p, FILE_BYTES_MAX);
  } catch (err) {
    if (err instanceof GitError) throw new LedgerError("not_found", err.message);
    throw err;
  }
  if (!got) throw new LedgerError("not_found", `the champion has no file ${p}`);
  if (!got.bytes)
    return {
      commit,
      path: p,
      size: got.size,
      note: `too large to read (${got.size} bytes, more than ${FILE_BYTES_MAX})`,
    };
  if (got.bytes.subarray(0, 8000).includes(0))
    return { commit, path: p, size: got.size, note: "a binary file: not shown" };
  const lines = got.bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const from = Math.max(1, Math.floor(offset));
  const n = Math.max(1, Math.min(READ_LINES_MAX, Math.floor(limit)));
  const slice = lines.slice(from - 1, from - 1 + n);
  return {
    commit,
    path: p,
    size: got.size,
    total_lines: lines.length,
    from,
    to: from - 1 + slice.length,
    content: slice.map((l, i) => `${from + i}\t${l}`).join("\n"),
  };
}

/** An attempt's diff from the commit it was built on, `DIFF_CHARS` characters from `offset`. */
export async function readAttemptDiff(
  ledger: Ledger,
  mirror: string,
  run: string,
  attempt: string,
  offset = 0,
): Promise<{
  attempt: string;
  total_chars: number;
  from: number;
  next: number | null;
  diff: string;
}> {
  const a = ledger.attempts.get(attempt);
  if (!a || String(a.run) !== run)
    throw new LedgerError("not_found", `no attempt ${attempt} in run ${run}`);
  let text: string;
  try {
    text = await readableDiff(mirror, String(a.parent_commit), String(a.commit_sha));
  } catch (err) {
    if (err instanceof GitError) throw new LedgerError("not_found", err.message);
    throw err;
  }
  const from = Math.max(0, Math.min(text.length, Math.floor(offset)));
  const to = Math.min(text.length, from + DIFF_CHARS);
  return {
    attempt,
    total_chars: text.length,
    from,
    next: to < text.length ? to : null,
    diff: text.slice(from, to),
  };
}
