import {
  chmodSync,
  copyFileSync,
  type Dirent,
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { errorText } from "../common/errors.ts";
import { folderBytes } from "../common/fs.ts";
import { log } from "../common/log.ts";
import { NAME_PATTERN, TRIAL_ID } from "../core/ids.ts";
import type { RetentionItem } from "../core/retention/index.ts";
import type { DiskWatch } from "./disk.ts";

/**
 * Each trial's session log, kept on the rig when the trial ends (goal 125, T12; the owner's
 * decision of 2026-11-01): what its agent program wrote of the session, whichever program ran it,
 * copied out of the trial's own area before that area goes, into the harness's state by run and
 * trial (`sessions/<run>/<trial>/`), where no agent's user can write or read. It stays until a
 * retention policy of the trials' session logs removes it (retention.ts). At the rig's disk floor
 * (disk.ts) a log that would take the disk below it is not kept, and the harness says so.
 */

/** The folder of the kept logs, in the harness's state. */
const SESSIONS_DIR = "sessions";

/** Where the kept logs are. */
export const sessionsDir = (stateDir: string): string => join(stateDir, SESSIONS_DIR);

/** One file of a trial's session log: its name in the kept folder, and where it is now. */
export interface SessionFile {
  name: string;
  path: string;
}

/** A file's name as the kept folder takes it: its own characters, others as `-`. */
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 200) || "log";

/** The files of `files` that exist, with their bytes. */
function present(files: readonly SessionFile[]): (SessionFile & { bytes: number })[] {
  return files.flatMap((f) => {
    try {
      const st = statSync(f.path);
      return st.isFile() ? [{ ...f, bytes: st.size }] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Keeps a trial's session log: each of `files` that exists is copied into its trial's folder.
 * Returns what it kept, or why it kept nothing (no file, the disk floor, a copy that failed);
 * never throws, so a trial's end goes on whatever becomes of its log.
 */
export function keepSession(
  o: { stateDir: string; disk?: DiskWatch | undefined },
  run: string,
  trial: string,
  files: readonly SessionFile[],
): { kept: number; bytes: number } | { skipped: string } {
  if (!NAME_PATTERN.test(run) || !TRIAL_ID.test(trial))
    return { skipped: `not a run's and a trial's name: ${run}, ${trial}` };
  const here = present(files);
  if (!here.length) return { skipped: "its program left no session log" };
  const bytes = here.reduce((n, f) => n + f.bytes, 0);
  const dir = join(sessionsDir(o.stateDir), run, trial);
  try {
    o.disk?.refuseBelowFloor(`trial ${trial}'s session log`, o.stateDir, bytes);
    mkdirSync(dir, { recursive: true, mode: 0o750 });
    for (const f of here) {
      const to = join(dir, safeName(f.name));
      copyFileSync(f.path, to);
      chmodSync(to, 0o640);
    }
  } catch (err) {
    const why = errorText(err);
    log("harness", "a trial's session log not kept", { run, trial, bytes, error: why }, "warn");
    return { skipped: why };
  }
  log("harness", "a trial's session log kept", { run, trial, files: here.length, bytes });
  return { kept: here.length, bytes };
}

/** The most entries a look for a program's own session files walks in its home. */
const HOME_WALK_MAX = 10_000;

/**
 * A command-line program's session log in a trial's area: its output headless, or the terminal
 * host's copy of its own log (`<prefix>-events.jsonl`, `<prefix>-session.jsonl`), what its hooks
 * or Thermite's plugin wrote (`<prefix>-signals.jsonl`), and the logs it keeps in its home under a
 * `sessions` folder (Codex's rollouts). Those that exist are kept; the rest are left out.
 */
export function cliSessionFiles(area: string, home: string, prefix: string): SessionFile[] {
  const files: SessionFile[] = ["events", "session", "signals"].map((what) => ({
    name: `${prefix}-${what}.jsonl`,
    path: join(area, `${prefix}-${what}.jsonl`),
  }));
  let looked = 0;
  const walk = (dir: string, inSessions: boolean) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++looked > HOME_WALK_MAX) return;
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path, inSessions || e.name === "sessions");
      else if (e.isFile() && inSessions && e.name.endsWith(".jsonl"))
        files.push({ name: `${prefix}-home-${e.name}`, path });
    }
  };
  walk(home, false);
  return files;
}

/** Folders' names under `dir`, none when it is not there. */
function folders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** The newest time of a folder's files, in ISO 8601: when the log was kept. */
function keptAt(dir: string): string {
  let at = 0;
  for (const name of readdirSync(dir)) {
    try {
      at = Math.max(at, statSync(join(dir, name)).mtimeMs);
    } catch {
      // Gone meanwhile: the others say when.
    }
  }
  return new Date(at || statSync(dir).mtimeMs).toISOString();
}

/** Each kept log as a retention policy reads it: its trial, run, time, bytes, its run open or not. */
export function sessionItems(stateDir: string, openRuns: ReadonlySet<string>): RetentionItem[] {
  const top = sessionsDir(stateDir);
  const out: RetentionItem[] = [];
  for (const run of folders(top)) {
    for (const trial of folders(join(top, run))) {
      const dir = join(top, run, trial);
      out.push({
        id: `${run}/${trial}`,
        rig: null,
        run,
        at: keptAt(dir),
        bytes: folderBytes(dir),
        count: 1,
        open: openRuns.has(run),
      });
    }
  }
  return out;
}

/** Removes kept logs by their ids (`<run>/<trial>`), and a run's folder they leave empty. */
export function removeSessions(stateDir: string, ids: readonly string[]): number {
  const top = sessionsDir(stateDir);
  let removed = 0;
  for (const id of ids) {
    const [run = "", trial = ""] = id.split("/");
    if (!NAME_PATTERN.test(run) || !TRIAL_ID.test(trial)) continue;
    rmSync(join(top, run, trial), { recursive: true, force: true });
    removed++;
    try {
      rmdirSync(join(top, run));
    } catch {
      // The run has other trials' logs still, or its folder went already.
    }
  }
  return removed;
}
