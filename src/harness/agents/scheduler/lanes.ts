import type { Contract } from "../../../core/contract.ts";
import { startingPoint } from "../../judge/index.ts";
import type { Ledger } from "../../ledger/index.ts";
import type { SchedulerContext } from "./context.ts";

/**
 * What each lane starts from: the champion, or the lane's best (the SLA keep rule), until a fork
 * round sends every lane back to the champion.
 */

const KEEP = new Set(["win_screened", "win_confirmed"]);
/** The lifecycle of a change the owner declined to promote (service/champion.ts). */
const DECLINED = "declined";

/**
 * Relative gain of the current champion over the run's starting point (the seed, or the
 * champion a setup change became: goal 115), from the confirmed steps since.
 */
export function championGain(ledger: Ledger, run: string): number {
  let gain = 1;
  const start = startingPoint(ledger, run).seq;
  for (const attempt of ledger.champions.attemptsAfter(run, start))
    gain *= 1 + (ledger.verdicts.confirmedWin(attempt)?.delta ?? 0);
  return gain - 1;
}

/**
 * Keeps each lane's best (SLA keep rule): a judged win of the lane, measured against the
 * current champion, that beats its previous best. Deltas measured against different champions
 * are never compared: when the champion moves, an older best is dropped. A best whose win did
 * not hold (failed confirmation, invalidation), that the owner declined or that became the
 * champion is dropped too, and a change the owner declined never becomes one.
 */
export function updateLaneBests(sched: SchedulerContext, run: string, lanes: string[]): void {
  const champion = sched.ledger.champions.current(run);
  for (const lane of lanes) {
    let best = sched.registry.laneBest(run, lane);
    if (best) {
      const a = sched.ledger.attempts.get(best);
      const verdict = sched.ledger.verdicts.current(best)?.verdict;
      const why =
        !a || a.invalidated_by !== null
          ? "invalidated"
          : String(a.lifecycle) === DECLINED
            ? "the owner declined it"
            : !verdict || !KEEP.has(verdict)
              ? `its verdict is now ${verdict ?? "none"}`
              : best === champion.attempt
                ? "it is the champion"
                : Number(a.baseline_champion_seq) !== champion.seq
                  ? "the champion has moved since it was measured"
                  : undefined;
      if (why) {
        sched.registry.clearLaneBest(run, lane, sched.o.owner, why);
        best = null;
      }
    }
    // After a fork round, only work done since the round may become a lane's best again.
    const round = sched.ledger.events.newest("fork_round", { subject: run });
    const current = (id: string) => {
      const a = sched.ledger.attempts.get(id);
      return (
        Number(a?.baseline_champion_seq) === champion.seq &&
        (!round || String(a?.created_at) > round.at)
      );
    };
    const bestDelta = best
      ? (sched.registry.evidence(run, 500, lane).find((e) => e.attempt === best)?.delta ?? null)
      : null;
    for (const e of sched.registry.evidence(run, 20, lane)) {
      if (!e.verdict || !KEEP.has(e.verdict) || e.delta === null || e.attempt === best) continue;
      if (e.lifecycle === DECLINED) continue;
      if (e.attempt === champion.attempt || !current(e.attempt)) continue;
      if (bestDelta === null || e.delta > bestDelta) {
        sched.registry.setLaneBest(run, lane, e.attempt, sched.o.owner);
        break;
      }
    }
  }
}

/**
 * Fork rounds (Fork-and-Flush): on a fixed schedule, never on a plateau, every lane starts again
 * from the champion. With a wall budget, at 33% and 66% of it; without one, every 20 epochs.
 */
export function maybeForkRound(
  sched: SchedulerContext,
  run: string,
  contract: Contract,
  n: number,
): void {
  const rounds = sched.ledger.events.count("fork_round", { subject: run });
  const w = contract.budget.wall_hours;
  let due = false;
  if (w !== undefined) {
    const created = String(sched.ledger.runs.createdAt(run));
    const used = (Date.now() - Date.parse(created)) / (w * 3_600_000);
    due = (rounds < 1 && used >= 1 / 3) || (rounds < 2 && used >= 2 / 3);
  } else {
    due = n > 1 && (n - 1) % 20 === 0;
  }
  if (!due) return;
  for (const lane of sched.ledger.trials.lanes(run))
    sched.registry.clearLaneBest(
      run,
      lane,
      sched.o.owner,
      "fork round: every lane starts from the champion",
    );
  sched.ledger.appendEvent(sched.o.owner, "fork_round", run, { epoch: n, round: rounds + 1 });
}
