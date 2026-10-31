import { errorText } from "../../common/errors.ts";
import { EXPERIMENT_DETAILS } from "../../core/commands.ts";
import { readableDiff } from "../git.ts";
import type { Ledger } from "../ledger/index.ts";
import type { HarnessService } from "../service/index.ts";
import { startingPoint } from "./baseline.ts";

/**
 * Changes carried to a new champion (goal 135). A change written on an older champion is judged
 * against the current one, as any change. Then a port may follow: an experiment at the top of the
 * queue in which a worker implements a change again, from its original diff, on the current
 * champion; the judge judges the port as any change. Two cases, one step each, never every
 * combination:
 * - a change written on an older champion became champion: the champion it replaced is ported
 *   onto it (portReplaced);
 * - such a change lost to the current champion but helped on the champion it was written on: it
 *   is ported onto the current one (the judge's parent screen, then queuePort).
 */

/** What a port carries, from the job that found it, to queue once the job is recorded. */
export interface PortFound {
  run: string;
  attempt: string;
  why: string;
  effect: string;
}

/** Why a change that lost to the current champion but helped on its own is ported. */
export const PORT_WHY =
  "it was written on an older champion and lost to the current one, but helped on the champion it was written on: it may help here too";

const pct = (x: unknown) =>
  typeof x === "number" ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%` : "an unknown change";

/**
 * The seq of the older champion a change was written on, or undefined: written on the current
 * champion, on something that never was a champion (a lane's best), on a champion before the run's
 * starting point (one the judge could not measure: setup), or a champion itself.
 */
export function olderChampion(
  ledger: Ledger,
  run: string,
  attempt: string,
  currentSeq: number,
): number | undefined {
  if (ledger.champions.holds(attempt)) return undefined;
  const parentCommit = String(ledger.attempts.get(attempt)?.parent_commit ?? "");
  const from = startingPoint(ledger, run).seq;
  return ledger.champions.seqOfCommit(run, parentCommit, from, currentSeq);
}

/**
 * Queues a port of `attempt` onto the run's current champion, at the top of the queue, once for
 * each change and champion (`port_queued`). Returns the experiment, or undefined when it was
 * queued before.
 */
export async function queuePort(
  service: HarnessService,
  p: PortFound,
): Promise<string | undefined> {
  const ledger = service.ledger;
  const champion = ledger.champions.current(p.run);
  const done = ledger.events.newest("port_queued", {
    subject: p.attempt,
    body: { onto_seq: champion.seq },
  });
  // The current champion's change is in it already.
  if (done || p.attempt === champion.attempt) return undefined;
  const a = ledger.attempts.get(p.attempt);
  const inst = ledger.runs.get(p.run);
  if (!a || !inst) return undefined;
  const head = [
    `Port of ${p.attempt} onto champion #${champion.seq} (commit ${champion.commit_sha.slice(0, 12)}).`,
    `${p.attempt} was written on commit ${String(a.parent_commit).slice(0, 12)}. ${p.effect}`,
    `Why a port: ${p.why}.`,
    `What it did, as its worker wrote: ${String(a.hypothesis ?? "").slice(0, 800)}`,
    "Implement the same change on the current champion, fitted to the code it has now; keep what the champion added. Its diff, as it was written:",
  ].join("\n");
  let diff: string;
  try {
    diff = await readableDiff(
      service.mirrorFor(inst.seed_repo),
      String(a.parent_commit),
      String(a.commit_sha),
    );
  } catch (err) {
    diff = `(its diff could not be read: ${errorText(err)})`;
  }
  const room = EXPERIMENT_DETAILS - head.length - 40;
  const body =
    diff.length <= room
      ? diff
      : `${diff.slice(0, room)}\n… (the diff goes on: ${diff.length} characters)`;
  const x = service.queue.add(
    p.run,
    {
      title: `Port ${p.attempt} onto champion #${champion.seq}`,
      details: `${head}\n${body}`,
      ...(a.family ? { family: String(a.family) } : {}),
      why: p.why,
      by: "judge",
      position: "top",
    },
    "judge",
  );
  ledger.appendEvent("judge", "port_queued", p.attempt, {
    run: p.run,
    onto_seq: champion.seq,
    experiment: x.id,
    why: p.why,
  });
  return x.id;
}

/**
 * After the champion moved: when the new champion was written on an older champion than the one
 * it replaced, the replaced champion's change is not in it, and is ported onto it.
 */
export async function portReplaced(service: HarnessService, run: string): Promise<void> {
  const [cur, prev] = service.ledger.champions.newest(run, 2);
  if (!cur?.attempt || !prev?.attempt) return;
  const parent = String(service.ledger.attempts.get(cur.attempt)?.parent_commit ?? "");
  if (parent === prev.commit_sha) return;
  await queuePort(service, {
    run,
    attempt: prev.attempt,
    why: `champion #${cur.seq} was written on an older champion than #${prev.seq}, so #${prev.seq}'s change is not in it`,
    effect: `It became champion #${prev.seq}, ${pct(winDelta(service.ledger, prev.attempt))} over the champion before it.`,
  });
}

/** The gain a change was promoted with: its confirmed win's. */
function winDelta(ledger: Ledger, attempt: string): number | undefined {
  return ledger.verdicts.confirmedWin(attempt)?.delta ?? undefined;
}

/**
 * A parent screen's outcome (the judge's `parent_screen` job): an event with the change's effect
 * on the champion it was written on, and, when it helped there, a port onto the current one. No
 * verdict: the change's stands, against the current champion.
 */
export function parentScreened(
  run: string,
  attempt: string,
  olderSeq: number | undefined,
  verdict: string,
  delta: number | null,
) {
  const effect = `Measured against champion #${olderSeq ?? "?"}, the champion it was written on: ${pct(delta)} (${verdict}).`;
  const body = { verdict, delta, champion_seq: olderSeq ?? null, effect };
  return {
    result: { parent_screen: body },
    events: [{ kind: "parent_screened" as const, subject: attempt, body }],
    ...(verdict === "win_screened" ? { port: { run, attempt, effect, why: PORT_WHY } } : {}),
  };
}
