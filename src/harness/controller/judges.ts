import { log } from "../../common/log.ts";
import {
  RUNNER_PROCESSES,
  RUNNERS_PER_PROCESS,
  RunnerSetting,
  RunnerSettings,
} from "../../core/rig-settings.ts";
import type { DevRuns } from "../agents/index.ts";
import type { GpuCard } from "../broker/index.ts";
import { Judge, jobsAtStart, type RemoteRunner, type RunnerPools } from "../judge/index.ts";
import type { Ledger } from "../ledger/index.ts";
import type { HarnessService } from "../service/index.ts";
import type { TargetDriver } from "../targets/index.ts";
import type { ControllerContext } from "./context.ts";
import type { RunnerExecutors } from "./runners.ts";

/**
 * The judge's executors: the jobs a dead controller held, taken back at the start, and the
 * executors, made once the API serves. loops.ts runs them. A rig's core has an executor for each
 * runner of its runner processes that the judge may use too (goal 206), made and stopped as they
 * come and go, which builds and measures there.
 */

/**
 * The rig's runner processes when it starts (goal 206): THERMITE_RUNNERS, `<name>=<pool>[+<pool>…]`
 * separated by commas: one pool for each runner the process serves, in its order: `judge`, `shared`
 * (the judge's and every lane's, first come, first served) or one lane's (`lane-2`). It is the
 * `runners` setting's value until the owner sets one; the setting changes it while the rig works.
 * Not set: none, and the core runs on its own runner alone.
 */
export function runnersOf(env: NodeJS.ProcessEnv): RunnerSetting[] {
  const text = env.THERMITE_RUNNERS?.trim();
  if (!text) return [];
  const list = text.split(",").map((part) => {
    const [name = "", pools = ""] = part.trim().split("=");
    const r = RunnerSetting.safeParse({ name, pools: pools.split("+") });
    if (!r.success)
      throw new Error(
        `THERMITE_RUNNERS: "${part}" is not <name>=<pool>[+<pool>…], each judge, shared or lane-<n>, at most ${RUNNERS_PER_PROCESS}`,
      );
    return r.data as RunnerSetting;
  });
  if (!RunnerSettings.safeParse(list).success)
    throw new Error(
      `THERMITE_RUNNERS: at most ${RUNNER_PROCESSES} runner processes, each named once`,
    );
  return list;
}

/**
 * Startup reconciliation: anything still leased by one of the rig's executors belonged to a
 * process that died, the executors of runners that have left since included. Re-queue it now and
 * record it once as crash_infra. Returns the executors' ids of the core's own judge cards.
 */
export function reclaimJobs(ledger: Ledger, judging: TargetDriver[]): string[] {
  // One executor per judge card that judges: executor-0 is the first card's, as always. A
  // runner's executor is executor-<runner>.
  jobsAtStart(ledger, (msg, fields) => log("harness", msg, fields));
  return judging.map((_, i) => `executor-${i}`);
}

/**
 * How many runners the judge measures on now, its own cards and other machines' (goal 206): each
 * executor's card reads it, so a calibration is per card and a confirmation goes to another
 * card than its screen's only while there are several.
 */
export class JudgeCards {
  count = 0;

  /** An executor's place among the judge's runners, and its id: a GPU's UUID or a runner's name. */
  card(index: number, uuid: string): { index: number; uuid: string; count: number } {
    const cards = this;
    return {
      index,
      uuid,
      get count() {
        return cards.count;
      },
    };
  }
}

/** An executor for each judge card of the core's own that judges, each timing on its own card. */
export function createJudges(
  ctx: ControllerContext,
  {
    service,
    devRuns,
    judging,
    judgeCards,
    executorIds,
    cards,
  }: {
    service: HarnessService;
    devRuns: DevRuns;
    judging: TargetDriver[];
    judgeCards: GpuCard[];
    executorIds: string[];
    cards: JudgeCards;
  },
): Judge[] {
  const { numbers, runner } = ctx;
  cards.count += judging.length;
  const executors = judging.map(
    (d, i) =>
      new Judge({
        service,
        runner,
        driver: d,
        owner: executorIds[i] as string,
        calibrationBlocks: numbers.calibrationBlocks,
        deviceGate: devRuns,
        card: cards.card(i, judgeCards[i]?.uuid ?? `core:${i}`),
      }),
  );
  log("harness", "judge ready", {
    separated: runner.separated,
    promotion: service.promotion,
    judge_cards: executors.length,
  });
  return executors;
}

/**
 * The judge's executors on the runners of other machines (goal 206): one for each runner of the
 * judge's pool or the shared one, made when it joins and stopped when it leaves. `start` runs one
 * in the judge's loops while `live` says so.
 */
export function runnerExecutors(
  ctx: ControllerContext,
  {
    service,
    pools,
    cards,
    start,
  }: {
    service: HarnessService;
    pools: RunnerPools;
    cards: JudgeCards;
    start: (executor: Judge, id: string, live: () => boolean) => void;
  },
): RunnerExecutors {
  const live = new Set<RemoteRunner>();
  return {
    add: (r, shared) => {
      const owner = `executor-${r.name}`;
      live.add(r);
      cards.count++;
      const executor = new Judge({
        service,
        runner: ctx.runner,
        driver: r.driver,
        owner,
        calibrationBlocks: ctx.numbers.calibrationBlocks,
        target: r,
        // One run at a time on a runner: the judge holds it for a whole job, in turn with the
        // lanes on a shared one.
        slot: { shared, hold: () => pools.holdForJudge(r, owner) },
        card: cards.card(cards.count - 1, r.name),
      });
      start(executor, owner, () => live.has(r));
    },
    remove: (r) => {
      if (!live.delete(r)) return;
      cards.count--;
      // Its calibrations wait for it alone: they go with it.
      const { jobs, runs } = service.ledger;
      for (const inst of runs.list())
        for (const j of jobs.ofRun(inst.id, "calibrate"))
          if (j.state === "queued" && j.spec.card === r.name)
            jobs.cancel(j.id, `executor-${r.name}`, {
              run: inst.id,
              reason: `its runner ${r.name} left the rig`,
            });
    },
  };
}
