import { log } from "../../common/log.ts";
import { RIG_ID } from "../../core/ids.ts";
import type { DevRuns } from "../agents/index.ts";
import type { GpuCard } from "../broker/index.ts";
import {
  Judge,
  jobsAtStart,
  type Pool,
  RemoteRunner,
  type RunnerLink,
  RunnerPools,
} from "../judge/index.ts";
import type { Ledger } from "../ledger/index.ts";
import type { HarnessService } from "../service/index.ts";
import type { TargetDriver } from "../targets/index.ts";
import type { ControllerContext } from "./context.ts";

/**
 * The judge's executors: the jobs a dead controller held, taken back at the start, and the
 * executors, made once the API serves. loops.ts runs them. A rig's core has an executor for each
 * runner of its runner processes too (goal 206), which builds and measures there.
 */

/** A runner process of the rig, and the pool of each runner it serves (goal 206). */
interface RunnerProcess {
  name: string;
  pools: Pool[];
}

const POOL = /^(judge|shared|lane-[1-9][0-9]?)$/;

/**
 * The rig's runner processes (goal 206): THERMITE_RUNNERS, `<name>=<pool>[+<pool>…]` separated
 * by commas, as control sets it on the core: one pool for each runner the process serves, in its
 * order: `judge`, `shared` (the judge's and every lane's, first come, first served) or one lane's
 * (`lane-2`). Not set: the core runs on its own runner alone.
 */
export function runnersOf(env: NodeJS.ProcessEnv): RunnerProcess[] {
  const text = env.THERMITE_RUNNERS?.trim();
  if (!text) return [];
  return text.split(",").map((part) => {
    const [name = "", list = ""] = part.trim().split("=");
    const pools = list.split("+");
    if (!RIG_ID.test(name) || pools.length > 8 || !pools.every((p) => POOL.test(p)))
      throw new Error(
        `THERMITE_RUNNERS: "${part}" is not <name>=<pool>[+<pool>…], each judge, shared or lane-<n>, at most 8`,
      );
    return { name, pools: pools as Pool[] };
  });
}

/** Every runner of the rig's runner processes, by its process and place, with its pool. */
function runnersIn(processes: RunnerProcess[]) {
  return processes.flatMap((r) => r.pools.map((pool, card) => ({ name: r.name, card, pool })));
}

/**
 * Startup reconciliation: anything still leased by this rig's executor belonged to a process
 * that died. Re-queue it now and record it once as crash_infra. Returns the executors' ids.
 */
export function reclaimJobs(
  ledger: Ledger,
  judging: TargetDriver[],
  runners: RunnerProcess[] = [],
): string[] {
  // One executor per judge card that judges (executor-0 is the first card's, as always), then one
  // per runner of each runner process that the judge may use.
  const executorIds = [
    ...judging.map((_, i) => `executor-${i}`),
    ...runnersIn(runners)
      .filter((r) => r.pool === "judge" || r.pool === "shared")
      .map((r) => `executor-${r.name}-${r.card}`),
  ];
  jobsAtStart(ledger, executorIds, (msg, fields) => log("harness", msg, fields));
  return executorIds;
}

/** An executor for each judge card that judges, each timing on its own card. */
export function createJudges(
  ctx: ControllerContext,
  {
    service,
    devRuns,
    judging,
    judgeCards,
    executorIds,
    pools,
  }: {
    service: HarnessService;
    devRuns: DevRuns;
    judging: TargetDriver[];
    judgeCards: GpuCard[];
    executorIds: string[];
    /** The runners of the rig's other machines in their pools, when it has some. */
    pools?: RunnerPools | undefined;
  },
): Judge[] {
  const { numbers, runner } = ctx;
  const remote = pools?.judges() ?? [];
  const count = judging.length + remote.length;
  // Each runner's place among the judge's, and its id: a GPU's UUID, else its place.
  const cardOf = (index: number, uuid: string) =>
    count > 1 ? { card: { index, uuid, count } } : {};
  const local = judging.map(
    (d, i) =>
      new Judge({
        service,
        runner,
        driver: d,
        owner: executorIds[i] as string,
        calibrationBlocks: numbers.calibrationBlocks,
        deviceGate: devRuns,
        ...cardOf(i, judgeCards[i]?.uuid ?? `core:${i}`),
      }),
  );
  const others = remote.map((r, j) => {
    const owner = executorIds[judging.length + j] as string;
    return new Judge({
      service,
      runner,
      driver: r.runner.driver,
      owner,
      calibrationBlocks: numbers.calibrationBlocks,
      target: r.runner,
      // One run at a time on a runner: the judge holds it for a whole job, in turn with the
      // lanes on a shared one.
      slot: {
        shared: r.shared,
        hold: () => (pools as RunnerPools).holdForJudge(r.runner, owner),
      },
      ...cardOf(judging.length + j, r.runner.name),
    });
  });
  const executors = [...local, ...others];
  log("harness", "judge ready", {
    separated: runner.separated,
    promotion: service.promotion,
    judge_cards: executors.length,
    ...(remote.length ? { runners: remote.map((r) => r.runner.name) } : {}),
  });
  return executors;
}

/**
 * The runners of the rig's other machines in their pools (goal 206): one RemoteRunner for each
 * runner of each runner process, reached through the core's link; none without runner processes.
 */
export function runnerPools(
  service: HarnessService,
  runners: RunnerProcess[],
  link: RunnerLink | undefined,
  core: { type: string; separated: boolean },
): RunnerPools | undefined {
  if (!runners.length || !link) return undefined;
  return new RunnerPools(
    runnersIn(runners).map((r) => ({
      pool: r.pool,
      runner: new RemoteRunner({
        name: `${r.name}-${r.card}`,
        link: link.to(r.name),
        card: r.card,
        // Its kind of target is the core's: a rig's machines run one image.
        info: core,
        ledger: service.ledger,
        mirrorFor: (repo) => service.mirrorFor(repo),
        scratchDir: service.paths.scratchDir,
      }),
    })),
  );
}
