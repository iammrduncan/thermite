import { log } from "../../common/log.ts";
import { RIG_ID } from "../../core/ids.ts";
import type { DevRuns } from "../agents/index.ts";
import type { GpuCard } from "../broker/index.ts";
import { Judge, jobsAtStart, RemoteRunner, type RunnerLink } from "../judge/index.ts";
import type { Ledger } from "../ledger/index.ts";
import type { HarnessService } from "../service/index.ts";
import type { TargetDriver } from "../targets/index.ts";
import type { ControllerContext } from "./context.ts";

/**
 * The judge's executors: the jobs a dead controller held, taken back at the start, and the
 * executors, made once the API serves. loops.ts runs them. A rig's core has an executor for each
 * runner of its runner processes too (goal 206), which builds and measures there.
 */

/** A runner process of the rig, and how many runners it serves (goal 206). */
interface RunnerProcess {
  name: string;
  cards: number;
}

/**
 * The rig's runner processes (goal 206): THERMITE_RUNNERS, `<name>=<runners>` separated by commas,
 * as control sets it on the core. Not set: the core runs on its own runner alone.
 */
export function runnersOf(env: NodeJS.ProcessEnv): RunnerProcess[] {
  const text = env.THERMITE_RUNNERS?.trim();
  if (!text) return [];
  return text.split(",").map((part) => {
    const [name = "", n = ""] = part.trim().split("=");
    const cards = Number(n);
    if (!RIG_ID.test(name) || !Number.isInteger(cards) || cards < 1 || cards > 8)
      throw new Error(`THERMITE_RUNNERS: "${part}" is not <name>=<runners, 1 to 8>`);
    return { name, cards };
  });
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
  // per runner of each runner process.
  const executorIds = [
    ...judging.map((_, i) => `executor-${i}`),
    ...runners.flatMap((r) => Array.from({ length: r.cards }, (_, k) => `executor-${r.name}-${k}`)),
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
    runners = [],
    link,
    driver,
  }: {
    service: HarnessService;
    devRuns: DevRuns;
    judging: TargetDriver[];
    judgeCards: GpuCard[];
    executorIds: string[];
    runners?: RunnerProcess[] | undefined;
    /** The core's link to its runner processes, when it has some. */
    link?: RunnerLink | undefined;
    /** The core's own target driver: its kind of target is its runners' too. */
    driver: TargetDriver;
  },
): Judge[] {
  const { numbers, runner } = ctx;
  const remote = runners.flatMap((r) =>
    Array.from({ length: r.cards }, (_, k) => ({ name: r.name, card: k })),
  );
  if (remote.length && !link) throw new Error("a core with runners needs its link to them");
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
  const others = remote.map(
    (r, j) =>
      new Judge({
        service,
        runner,
        driver,
        owner: executorIds[judging.length + j] as string,
        calibrationBlocks: numbers.calibrationBlocks,
        target: new RemoteRunner({
          name: `${r.name}-${r.card}`,
          link: (link as RunnerLink).to(r.name),
          card: r.card,
          info: { type: driver.type, separated: runner.separated },
          ledger: service.ledger,
          mirrorFor: (repo) => service.mirrorFor(repo),
          scratchDir: service.paths.scratchDir,
        }),
        ...cardOf(judging.length + j, `${r.name}:${r.card}`),
      }),
  );
  const executors = [...local, ...others];
  log("harness", "judge ready", {
    separated: runner.separated,
    promotion: service.promotion,
    judge_cards: executors.length,
    ...(runners.length ? { runners: runners.map((r) => `${r.name}=${r.cards}`) } : {}),
  });
  return executors;
}
