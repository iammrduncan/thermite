import { log } from "../../common/log.ts";
import type { DevRuns } from "../agents/index.ts";
import type { GpuCard } from "../broker/index.ts";
import { Judge, jobsAtStart, type PromotionPolicy } from "../judge/index.ts";
import type { Ledger } from "../ledger/index.ts";
import type { HarnessService } from "../service/index.ts";
import type { TargetDriver } from "../targets/index.ts";
import type { ControllerContext } from "./context.ts";

/**
 * The judge's executors: the jobs a dead controller held, taken back at the start, and the
 * executors, made once the API serves. loops.ts runs them.
 */

/**
 * Startup reconciliation: anything still leased by this rig's executor belonged to a process
 * that died. Re-queue it now and record it once as crash_infra. Returns the executors' ids.
 */
export function reclaimJobs(ledger: Ledger, judging: TargetDriver[]): string[] {
  // One executor per judge card that judges (executor-0 is the first card's, as always).
  const executorIds = judging.map((_, i) => `executor-${i}`);
  jobsAtStart(ledger, executorIds, (msg, fields) => log("harness", msg, fields));
  return executorIds;
}

/** An executor for each judge card that judges, each timing on its own card. */
export function createJudges(
  ctx: ControllerContext,
  {
    service,
    promotion,
    devRuns,
    judging,
    judgeCards,
    executorIds,
  }: {
    service: HarnessService;
    promotion: PromotionPolicy;
    devRuns: DevRuns;
    judging: TargetDriver[];
    judgeCards: GpuCard[];
    executorIds: string[];
  },
): Judge[] {
  const { numbers, runner } = ctx;
  const executors = judging.map(
    (d, i) =>
      new Judge({
        service,
        runner,
        driver: d,
        owner: executorIds[i] as string,
        promotion,
        calibrationBlocks: numbers.calibrationBlocks,
        deviceGate: devRuns,
        ...(judging.length > 1
          ? {
              card: {
                index: i,
                uuid: (judgeCards[i] as { uuid: string }).uuid,
                count: judging.length,
              },
            }
          : {}),
      }),
  );
  log("harness", "judge ready", {
    separated: runner.separated,
    promotion,
    judge_cards: executors.length,
  });
  return executors;
}
