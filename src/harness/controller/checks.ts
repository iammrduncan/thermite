import { programOf } from "../agents/index.ts";
import {
  busyReason,
  clusterApi,
  isolationBusy,
  isolationSelftest,
  isolationSummary,
  oneContainerTargets,
  readSupervisorIsolation,
  rigSecretFiles,
} from "../selftest/index.ts";
import type { HarnessService } from "../service/index.ts";
import { checksDir, smokeCheck } from "../smoke-check.ts";
import type { TargetDriver } from "../targets/index.ts";
import type { AgentLinks } from "./agents.ts";
import type { ControllerContext } from "./context.ts";

/**
 * The rig checks control can ask for, each added to the service at its place in the start: the
 * isolation selftest under the broker (before the API, the judge or any agent), then the model
 * route's check and the smoke check (once the API serves).
 */

/** The isolation selftest, under the broker only. */
export function addIsolationCheck(ctx: ControllerContext, service: HarnessService): void {
  const { env, paths } = ctx;
  if (env.THERMITE_BROKER_SOCKET) {
    const socketPath = env.THERMITE_BROKER_SOCKET;
    service.rigChecks.isolation = {
      // Open trials or judge jobs, or a planner call: each probe kills its role's processes.
      notNow: () => isolationBusy(paths.stateDir),
      run: async ({ force }) => {
        const report = await isolationSelftest({
          socketPath,
          stateDir: paths.stateDir,
          // The scratch root, as the command-line selftest uses it (the controller's own area,
          // paths.scratchDir, is a directory inside it).
          scratchDir: env.THERMITE_SCRATCH_DIR ?? "/scratch",
          outboxDir: paths.outboxDir,
          inboxDir: paths.inboxDir,
          secretFiles: rigSecretFiles(env, paths.stateDir),
          dedicated: env.THERMITE_DEV_GPU_INDEX !== undefined,
          force,
          controllerPid: process.pid,
          oneContainer: oneContainerTargets(env),
          snapshotDir: env.THERMITE_STATE_SNAPSHOT_DIR || undefined,
          clusterApi: clusterApi(env),
          supervisor: readSupervisorIsolation(paths.stateDir),
        });
        return { ok: report.ok, summary: isolationSummary(report), detail: { ...report } };
      },
    };
  }
}

/** The model check in the program the route names (programs.ts). */
export function addModelCheck(
  service: HarnessService,
  { model, once }: Pick<AgentLinks, "model" | "once">,
): void {
  service.rigChecks.model = {
    run: async () => {
      const m = model();
      return m
        ? programOf(m).modelCheck(m, once)
        : {
            ok: false,
            summary:
              "no model route: set one on control's settings page (or in the rig's settings)",
          };
    },
  };
}

/** The smoke check: a judge-only campaign from the smoke kit in the image, on this target. */
export function addSmokeCheck(
  ctx: ControllerContext,
  service: HarnessService,
  driver: TargetDriver,
): void {
  const { env, paths } = ctx;
  service.rigChecks.smoke = {
    notNow: () => busyReason(paths.stateDir),
    run: async () =>
      smokeCheck({
        service,
        targetType: driver.type,
        targetClass: (await driver.identify()).class,
        checksDir: checksDir(env),
        scratchDir: paths.scratchDir,
      }),
  };
}
