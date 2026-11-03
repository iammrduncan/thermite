import { join } from "node:path";
import { log } from "../../common/log.ts";
import {
  cardsOf,
  type GpuCard,
  type GpuLayout,
  MAX_GPU_SET,
  parseIndexList,
  readLayout,
  runRole,
} from "../broker/index.ts";
import { collectHardware } from "../hardware.ts";
import type { HarnessService } from "../service/index.ts";
import { CpuDriver, CudaDriver, smiAs, smiAsRun, type TargetDriver } from "../targets/index.ts";
import type { ControllerContext } from "./context.ts";

/**
 * The rig's targets: the GPU's device nodes as the broker set them up, a target driver for each
 * judge card, the GPU split the broker gave this start, and the hardware the rig runs on, with
 * the cards that judge.
 */

export interface Targets {
  /** The broker's record of the GPU's device nodes: none on a CPU rig or without the broker. */
  devCard: { layout?: GpuLayout; error?: string } | undefined;
  judgeCards: GpuCard[];
  devCards: GpuCard[];
  /** One driver per judge card; the first is the rig's driver. */
  drivers: TargetDriver[];
  driver: TargetDriver;
}

export function targetDrivers(ctx: ControllerContext): Targets {
  const { env, paths, runner } = ctx;
  const target = env.THERMITE_TARGET ?? "cpu";
  // The broker restricts the GPU's device nodes (and sets up a dedicated development card when
  // one is configured); without its record of that, a GPU rig neither times nor runs dev runs.
  let devCard: { layout?: GpuLayout; error?: string } | undefined;
  if (env.THERMITE_DEV_GPU_INDEX !== undefined && target !== "cuda-gpu") {
    throw new Error("THERMITE_DEV_GPU_INDEX needs THERMITE_TARGET=cuda-gpu");
  }
  if (
    target === "cuda-gpu" &&
    (env.THERMITE_DEV_GPU_INDEX !== undefined || env.THERMITE_BROKER_SOCKET)
  ) {
    devCard = readLayout(env.THERMITE_BROKER_SOCKET);
    log(
      "harness",
      devCard.error
        ? "GPU devices unavailable: the rig will not time"
        : devCard.layout
          ? "dedicated development card"
          : "GPU device nodes restricted to the gpu group",
      devCard,
    );
  }
  // One driver per judge card: each executor times on its own card, as its own user.
  const judgeCards = devCard?.layout ? cardsOf(devCard.layout).judges : [];
  const devCards = devCard?.layout ? cardsOf(devCard.layout).devs : [];
  let drivers: TargetDriver[];
  if (target === "cpu") drivers = [new CpuDriver(env.THERMITE_TARGET_CLASS ?? "generic-cpu")];
  else if (target === "cuda-gpu") {
    const first = parseIndexList(env.THERMITE_GPU_INDEX ?? "0", "THERMITE_GPU_INDEX")[0] ?? 0;
    const cards = judgeCards.length ? judgeCards : [{ index: first, uuid: undefined }];
    drivers = cards.map(
      (c, i) =>
        new CudaDriver({
          targetClass: env.THERMITE_TARGET_CLASS ?? "cuda-gpu",
          index: c.index,
          uuid: c.uuid,
          smi: smiAs(
            runner,
            runRole(i),
            join(paths.scratchDir, "thermite", i ? `gpu-query-${i}` : "gpu-query"),
          ),
          unusable: devCard?.error,
        }),
    );
  } else throw new Error(`no target driver ${target}; this build has cpu and cuda-gpu`);
  const driver = drivers[0] as TargetDriver;
  return { devCard, judgeCards, devCards, drivers, driver };
}

/**
 * A rig configured with its GPU set: the broker split it for this start (the lists it gave).
 * gpuSet is 0 for a rig without one; judgeNow is the number of judge cards when the set has two
 * cards or more.
 */
export function gpuSplitAtStart(env: NodeJS.ProcessEnv): { gpuSet: number; judgeNow: number } {
  const gpuSet = env.THERMITE_GPUS
    ? parseIndexList(env.THERMITE_GPUS, "THERMITE_GPUS", MAX_GPU_SET).length
    : 0;
  const judgeNow =
    gpuSet >= 2 ? parseIndexList(env.THERMITE_GPU_INDEX ?? "0", "THERMITE_GPU_INDEX").length : 0;
  return { gpuSet, judgeNow };
}

/**
 * What the rig runs on, for the dashboard: collected once, before the judge starts timing, and
 * kept as the service's hardware. Returns the drivers of the judge cards that judge.
 */
export async function rigHardware(
  ctx: ControllerContext,
  service: HarnessService,
  targets: Targets,
): Promise<TargetDriver[]> {
  const { env, paths, runner } = ctx;
  const { devCard, judgeCards, devCards, drivers, driver } = targets;
  const gpuQuery = join(paths.scratchDir, "thermite", "gpu-query");
  const layout = devCard?.layout;
  service.hardware = await collectHardware({
    driver,
    cards:
      driver.type !== "cuda-gpu" || devCard?.error
        ? []
        : layout
          ? [
              ...judgeCards.map((c, i) => ({
                role: "judge" as const,
                select: c.uuid,
                smi: i
                  ? smiAs(runner, runRole(i), join(paths.scratchDir, "thermite", `gpu-query-${i}`))
                  : smiAsRun(runner, gpuQuery),
              })),
              ...devCards.map((c, k) => ({
                role: "dev" as const,
                select: c.uuid,
                smi: k
                  ? smiAs(
                      runner,
                      "lane-1",
                      join(paths.scratchDir, "thermite", `gpu-query-dev-${k}`),
                      k,
                    )
                  : smiAs(
                      runner,
                      "lane-1-dev",
                      join(paths.scratchDir, "thermite", "gpu-query-dev"),
                    ),
              })),
            ]
          : [
              {
                role: "shared",
                select: env.THERMITE_GPU_INDEX ?? "0",
                smi: smiAsRun(runner, gpuQuery),
              },
            ],
    deviceMode:
      driver.type !== "cuda-gpu"
        ? "none"
        : env.THERMITE_DEV_GPU_INDEX !== undefined
          ? "dedicated"
          : "shared",
    stateDir: paths.stateDir,
    scratchDir: paths.scratchDir,
  });
  if (devCard?.error) service.hardware.errors.push(devCard.error);
  // One GPU model per rig: its judge cards share one target class. Mixed cards are separate rigs;
  // until then only the first judge card judges.
  const cardModels = new Set(
    service.hardware.devices.filter((d) => d.role === "judge").map((d) => d.name),
  );
  const judging = cardModels.size > 1 ? drivers.slice(0, 1) : drivers;
  if (cardModels.size > 1)
    service.hardware.errors.push(
      `the judge cards are different models (${[...cardModels].join(", ")}): only the first judges; put different models in separate rigs`,
    );
  log("harness", "hardware", {
    devices: service.hardware.devices.map((d) => `${d.role}: ${d.name} ${d.uuid}`),
    errors: service.hardware.errors,
  });
  return judging;
}
