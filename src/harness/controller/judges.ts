import { log } from "../../common/log.ts";
import { RIG_ID } from "../../core/ids.ts";
import type { DevRuns } from "../agents/index.ts";
import type { GpuCard } from "../broker/index.ts";
import { type FollowerLink, Judge, jobsAtStart, RemoteDevice } from "../judge/index.ts";
import type { Ledger } from "../ledger/index.ts";
import type { HarnessService } from "../service/index.ts";
import type { TargetDriver } from "../targets/index.ts";
import type { ControllerContext } from "./context.ts";

/**
 * The judge's executors: the jobs a dead controller held, taken back at the start, and the
 * executors, made once the API serves. loops.ts runs them. A rig's leader has an executor for each
 * judge GPU of its followers too (goal 205), which builds and measures on the follower.
 */

/**
 * A follower of the rig (goal 205): how many judge GPUs it serves, and how many workers' GPUs its
 * lanes' trials run on (step 2).
 */
export interface Follower {
  machine: string;
  cards: number;
  workers: number;
}

/**
 * The rig's followers (goal 205): THERMITE_FOLLOWERS, `<machine>=<judge GPUs>[+<workers' GPUs>]`
 * separated by commas, as control sets it on the leader. A follower serves the judge, the lanes,
 * or both. Not set: a rig of one machine.
 */
export function followersOf(env: NodeJS.ProcessEnv): Follower[] {
  const text = env.THERMITE_FOLLOWERS?.trim();
  if (!text) return [];
  return text.split(",").map((part) => {
    const [machine = "", n = ""] = part.trim().split("=");
    const [j = "", w = "0"] = n.split("+");
    const cards = Number(j);
    const workers = Number(w);
    const count = (x: number) => Number.isInteger(x) && x >= 0 && x <= 8;
    if (!RIG_ID.test(machine) || !count(cards) || !count(workers) || cards + workers < 1)
      throw new Error(
        `THERMITE_FOLLOWERS: "${part}" is not <machine>=<judge GPUs>[+<workers' GPUs>], each 0 to 8 and not both 0`,
      );
    return { machine, cards, workers };
  });
}

/** Each executor's id: `executor-<i>` for the rig's own judge GPUs, as always, then the followers'. */
function executorIdsOf(judging: TargetDriver[], followers: Follower[]): string[] {
  return [
    ...judging.map((_, i) => `executor-${i}`),
    ...followers.flatMap((f) =>
      Array.from({ length: f.cards }, (_, k) => `executor-${f.machine}-${k}`),
    ),
  ];
}

/**
 * Startup reconciliation: anything still leased by this rig's executor belonged to a process
 * that died. Re-queue it now and record it once as crash_infra. Returns the executors' ids.
 */
export function reclaimJobs(
  ledger: Ledger,
  judging: TargetDriver[],
  followers: Follower[] = [],
): string[] {
  const executorIds = executorIdsOf(judging, followers);
  jobsAtStart(ledger, executorIds, (msg, fields) => log("harness", msg, fields));
  return executorIds;
}

/**
 * An executor for each judge card that judges, each timing on its own card; then one for each
 * judge GPU of each follower, through the leader's link to it (service.followers).
 */
export function createJudges(
  ctx: ControllerContext,
  {
    service,
    devRuns,
    judging,
    judgeCards,
    executorIds,
    followers = [],
    link,
    driver,
  }: {
    service: HarnessService;
    devRuns: DevRuns;
    judging: TargetDriver[];
    judgeCards: GpuCard[];
    executorIds: string[];
    followers?: Follower[] | undefined;
    /** The leader's link to its followers, when it has some. */
    link?: FollowerLink | undefined;
    /** The rig's own target driver: its kind of target is its followers' too. */
    driver: TargetDriver;
  },
): Judge[] {
  const { numbers, runner } = ctx;
  const remote = followers.flatMap((f) =>
    Array.from({ length: f.cards }, (_, k) => ({ machine: f.machine, card: k })),
  );
  if (remote.length && !link) throw new Error("a rig with followers needs its link to them");
  const count = judging.length + remote.length;
  // Each judge GPU's place among the rig's, and its id: a GPU's UUID, else its place.
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
        ...cardOf(i, judgeCards[i]?.uuid ?? `local:${i}`),
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
        device: new RemoteDevice({
          link: (link as FollowerLink).to(r.machine),
          card: r.card,
          info: { type: driver.type, separated: runner.separated },
          ledger: service.ledger,
          mirrorFor: (repo) => service.mirrorFor(repo),
          scratchDir: service.paths.scratchDir,
        }),
        ...cardOf(judging.length + j, `${r.machine}:${r.card}`),
      }),
  );
  const executors = [...local, ...others];
  log("harness", "judge ready", {
    separated: runner.separated,
    promotion: service.promotion,
    judge_cards: executors.length,
    ...(followers.length
      ? {
          followers: followers.map(
            (f) => `${f.machine}=${f.cards}${f.workers ? `+${f.workers}` : ""}`,
          ),
        }
      : {}),
  });
  return executors;
}
