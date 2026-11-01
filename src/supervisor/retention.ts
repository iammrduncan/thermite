import { readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { z } from "zod";
import type { HarnessClient } from "../common/api/harness.ts";
import { log } from "../common/env.ts";
import { errorText } from "../common/errors.ts";
import { RETENTION_REMOVED, SPACE } from "../core/api/harness/supervisor.ts";
import { CommandPayloads, type SignedCommand } from "../core/commands.ts";
import { NAME_PATTERN } from "../core/ids.ts";
import {
  packItems,
  type RetentionItem,
  type RigSpace,
  removedBody,
  type SpaceInventory,
  wouldRemove,
} from "../core/retention/index.ts";
import { ask, type ControlOnBus } from "./ask.ts";

/**
 * The advisors' records under the owner's retention policies (core/retention/): the records of
 * each advisor's round and their conversations kept before each compaction, in the supervisor's
 * home (advisors/). The supervisor tells control what it keeps of them, with the harness's
 * builds, on the bus (the `space` ask); and it removes what a policy covers once its harness took
 * the policy's signed command, then tells the harness what went, which records it as the rig's
 * `retention_removed` event.
 */

/** The advisors' records, in the supervisor's home. */
const ADVISORS_DIR = "advisors";
/** A run's own records, in their run's folder. */
const RUNS_DIR = "runs";
/** The conversations kept before compactions, by run (advisors/pass/keeper.ts). */
const COMPACTIONS_DIR = "compactions";

/** Where an advisor's round is recorded: its run's folder, or the top for a round with no run. */
export function advisorRecordsDir(home: string, run?: string | null): string {
  const top = join(home, ADVISORS_DIR);
  return run && NAME_PATTERN.test(run) ? join(top, RUNS_DIR, run) : top;
}

/** The run a record belongs to, by where it is: runs/<run>/ or compactions/<run>/. */
function runOf(rel: string): string | null {
  const [first, run, ...rest] = rel.split(sep);
  return (first === RUNS_DIR || first === COMPACTIONS_DIR) && run && rest.length ? run : null;
}

/** Every record under the advisors' folder, as a policy reads it; none when there is none. */
export function advisorItems(home: string, openRuns: ReadonlySet<string>): RetentionItem[] {
  const top = join(home, ADVISORS_DIR);
  const out: RetentionItem[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const name of names) {
      const path = join(dir, name);
      const st = statSync(path, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        const rel = relative(top, path);
        const run = runOf(rel);
        out.push({
          id: rel,
          rig: null,
          run,
          at: st.mtime.toISOString(),
          bytes: st.size,
          count: 1,
          open: run !== null && openRuns.has(run),
        });
      }
    }
  };
  walk(top);
  return out;
}

type RetentionRun = z.output<(typeof CommandPayloads)["retention_run"]>;

/**
 * Removes the advisors' records a policy covers now, and returns what went as the event's body.
 * A folder a removal leaves empty goes too. A record that can't be removed is said in `error`.
 */
function removeAdvisorRecords(
  home: string,
  p: RetentionRun,
  openRuns: ReadonlySet<string>,
  now: Date,
) {
  const top = join(home, ADVISORS_DIR);
  const r = wouldRemove(p.rule, advisorItems(home, openRuns), now);
  const gone: RetentionItem[] = [];
  let error: string | undefined;
  const folders = new Set<string>();
  for (const x of r.items) {
    try {
      rmSync(join(top, x.id), { force: true });
      gone.push(x);
      const parts = x.id.split(sep);
      for (let i = parts.length - 1; i > 0; i--) folders.add(join(top, ...parts.slice(0, i)));
    } catch (err) {
      error ??= `a record could not be removed: ${errorText(err)}`;
    }
  }
  // Deepest first: a run's folder goes once its records have.
  for (const dir of [...folders].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(dir);
    } catch {
      // Not empty, or gone already: it stays as it is.
    }
  }
  const ats = gone.map((x) => x.at).sort();
  return removedBody(
    { policy: p.policy, name: p.name, kind: "advisor_records", by: p.by },
    {
      count: gone.length,
      bytes: gone.reduce((n, x) => n + x.bytes, 0),
      rigs: 0,
      oldest: ats[0] ?? null,
      newest: ats.at(-1) ?? null,
    },
    error,
  );
}

/** What the supervisor's part of the policies needs: its home, its harness, control on the bus. */
interface SupervisorRetention {
  home: string;
  harness: HarnessClient;
  control: ControlOnBus;
  clock?: (() => Date) | undefined;
}

/**
 * What the rig keeps of the kinds a policy may remove there, told to control: the harness's
 * builds, and the advisors' records here, each of a run still open marked so. A kind that can't be
 * read is sent with why, and its items none.
 */
export async function sendSpace(o: SupervisorRetention): Promise<void> {
  const now = (o.clock ?? (() => new Date()))();
  const fromHarness = await o.harness.call(SPACE);
  const open = new Set(fromHarness.open_runs);
  let records: SpaceInventory;
  try {
    records = packItems(advisorItems(o.home, open));
  } catch (err) {
    records = { bytes: 0, runs: [], items: [], error: errorText(err).slice(0, 500) };
  }
  const body: RigSpace = {
    read_at: now.toISOString(),
    kinds: {
      builds: fromHarness.builds,
      ...(fromHarness.trial_logs ? { trial_logs: fromHarness.trial_logs } : {}),
      advisor_records: records,
    },
  };
  await ask(o.control, "space", body);
}

/** The removal under way, which the next waits for. */
let removing: Promise<void> = Promise.resolve();

/**
 * A policy's signed command its harness took: the advisors' records it covers go now, and the
 * harness records what went. Any other kind is the harness's own. Never rejects: a failure is
 * logged, and the next run of the policy tries again.
 */
export function onRetentionTaken(o: SupervisorRetention, cmd: SignedCommand): Promise<void> {
  if (cmd.envelope.kind !== "retention_run") return Promise.resolve();
  const read = CommandPayloads.retention_run.safeParse(cmd.envelope.payload);
  if (!read.success || read.data.rule.kind !== "advisor_records") return Promise.resolve();
  const p = read.data;
  // One removal at a time: two runs of a policy never remove at once.
  const next = removing.then(async () => {
    try {
      const open = new Set((await o.harness.call(SPACE)).open_runs);
      const body = removeAdvisorRecords(o.home, p, open, (o.clock ?? (() => new Date()))());
      await o.harness.call(RETENTION_REMOVED, { body });
      log("supervisor", "a retention policy removed advisors' records", {
        policy: p.policy,
        command: cmd.envelope.id,
        removed: body.count,
        bytes: body.bytes,
        ...(body.error ? { error: body.error } : {}),
      });
    } catch (err) {
      const what = { policy: p.policy, command: cmd.envelope.id, error: errorText(err) };
      log("supervisor", "a retention policy's advisors' records not removed", what, "error");
    }
  });
  removing = next;
  return next;
}
