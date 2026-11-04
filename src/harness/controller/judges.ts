import { log } from "../../common/log.ts";
import { RIG_ID } from "../../core/ids.ts";
import type { DevRuns } from "../agents/index.ts";
import type { GpuCard } from "../broker/index.ts";
import { FollowerLink, Judge, jobsAtStart, RemoteDevice } from "../judge/index.ts";
import type { Ledger } from "../ledger/index.ts";
import type { HarnessService } from "../service/index.ts";
import type { TargetDriver } from "../targets/index.ts";
import type { ControllerContext } from "./context.ts";

/**
 * The judge's executors: the jobs a dead controller held, taken back at the start, and the
 * executors, made once the API serves. loops.ts runs them. A rig's leader has an executor for each
 * judge GPU of its followers too (goal 205), which builds and measures on the follower.
 */

/** A follower of the rig and how many judge GPUs it serves (goal 205). */
interface Follower {
  machine: string;
  cards: number;
}

/**
 * The rig's followers (goal 205): THERMITE_FOLLOWERS, `<machine>=<judge GPUs>` separated by
 * commas, as control sets it on the leader. Not set: a rig of one machine.
 */
export function followersOf(env: NodeJS.ProcessEnv): Follower[] {
  const text = env.THERMITE_FOLLOWERS?.trim();
  if (!text) return [];
  return text.split(",").map((part) => {
    const [machine = "", n = ""] = part.trim().split("=");
    const cards = Number(n);
    if (!RIG_ID.test(machine) || !Number.isInteger(cards) || cards < 1 || cards > 8)
      throw new Error(`THERMITE_FOLLOWERS: "${part}" is not <machine>=<judge GPUs, 1 to 8>`);
    return { machine, cards };
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
  }: {
    service: HarnessService;
    devRuns: DevRuns;
    judging: TargetDriver[];
    judgeCards: GpuCard[];
    executorIds: string[];
    followers?: Follower[] | undefined;
  },
): Judge[] {
  const { numbers, runner } = ctx;
  const remote = followers.flatMap((f) =>
    Array.from({ length: f.cards }, (_, k) => ({ machine: f.machine, card: k })),
  );
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
  const link = remote.length ? new FollowerLink({ outboxDir: service.paths.outboxDir }) : undefined;
  service.followers = link;
  const driver = judging[0] as TargetDriver;
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
    ...(followers.length ? { followers: followers.map((f) => `${f.machine}=${f.cards}`) } : {}),
  });
  return executors;
}
