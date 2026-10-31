import { spawnSync } from "node:child_process";
import { chownSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { deriveKeys, parseSnapshotKey } from "./seal.ts";
import { backupLedger, TakeJob, takeSnapshot } from "./snapshot/index.ts";

/**
 * The broker's helper for the rig's state snapshot (snapshot.ts), started as its own process so
 * the copying never holds up the broker, which times the judge's runs:
 *
 *   take                      as root: takes a sealed snapshot. The job comes on its standard
 *                             input, as JSON (TakeJob), with the snapshot key: never in its
 *                             arguments, which any user may read, nor in its environment;
 *   ledger <source> <copy>    as the controller's user: copies the ledger with SQLite's backup.
 *
 * Its output is the broker's log: what it took, or why it could not.
 */

const self = fileURLToPath(import.meta.url);

/**
 * The ledger's copy, made as its owner (never as root: SQLite may make the write-ahead files of a
 * ledger no controller has open, and they must stay the controller's), into a folder root made.
 * It must be a plain file of the owner's own with one link. Its environment has nothing but the
 * path: never the snapshot key.
 */
function stageLedger(source: string, job: TakeJob): string {
  rmSync(job.stage, { recursive: true, force: true });
  mkdirSync(job.stage, { mode: 0o700 });
  chownSync(job.stage, job.owner.uid, job.owner.gid);
  const copy = join(job.stage, "ledger.db");
  const r = spawnSync(process.execPath, [...process.execArgv, self, "ledger", source, copy], {
    uid: job.owner.uid,
    gid: job.owner.gid,
    cwd: job.stage,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
    },
    encoding: "utf8",
    timeout: 600_000,
  });
  if (r.status !== 0)
    throw new Error(
      `the ledger's backup failed (exit ${r.status ?? r.signal}): ${String(r.error ?? "")} ${(r.stderr ?? "").trim().slice(-300)}`,
    );
  const st = lstatSync(copy);
  if (!st.isFile() || st.uid !== job.owner.uid || st.nlink !== 1)
    throw new Error("the ledger's copy is not a plain file of the controller's own");
  return copy;
}

async function main(): Promise<number> {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "ledger" && a && b) {
    await backupLedger(a, b);
    return 0;
  }
  if (cmd !== "take") {
    process.stderr.write("usage: snapshot-main take < job | ledger <source> <copy>\n");
    return 2;
  }
  let job: TakeJob;
  try {
    job = TakeJob.parse(JSON.parse(readFileSync(0, "utf8")));
  } catch (err) {
    log(
      "broker",
      "could not take a snapshot of the rig's state: the last one stays",
      {
        error: `the job is not valid: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
      },
      "warn",
    );
    return 1;
  }
  const key = parseSnapshotKey(job.key);
  if ("why" in key) {
    log(
      "broker",
      "could not take a snapshot of the rig's state: the last one stays",
      {
        dir: job.dir,
        error: key.why,
      },
      "warn",
    );
    return 1;
  }
  try {
    const r = await takeSnapshot({
      dir: job.dir,
      areas: job.areas,
      reason: job.reason,
      keys: deriveKeys(key.key),
      rig: job.rig,
      backupLedger: async (source) => stageLedger(source, job),
    });
    log("broker", "took a snapshot of the rig's state", {
      dir: job.dir,
      reason: r.reason,
      seq: r.seq,
      files: r.files,
      folders: r.dirs,
      bytes: r.bytes,
      sealed: r.sealed,
      reused: r.reused,
      removed: r.removed,
      ledger: r.ledger,
      ...(r.before_refused
        ? {
            before: `the last snapshot did not verify (${r.before_refused}): every file was sealed again`,
          }
        : {}),
      ...(r.skipped.length
        ? { skipped: r.skipped.length, skipped_first: r.skipped.slice(0, 5) }
        : {}),
      ms: r.ms,
    });
    return 0;
  } catch (err) {
    log(
      "broker",
      "could not take a snapshot of the rig's state: the last one stays",
      {
        dir: job.dir,
        reason: job.reason,
        error: errorText(err),
      },
      "warn",
    );
    return 1;
  } finally {
    rmSync(job.stage, { recursive: true, force: true });
  }
}

process.exitCode = await main();
