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

/** How long the model check waits for an answer unless the rig's settings say (goal 150). */
const CHECK_SECONDS = 120;

/** The model check in the program the route names (programs.ts). */
export function addModelCheck(
  service: HarnessService,
  { model, once }: Pick<AgentLinks, "model" | "once">,
): void {
  service.rigChecks.model = {
    run: async () => {
      const m = model();
      // As long as the rig's setting says (goal 150): a busy model can answer after 120 s.
      const seconds = service.settings.get().check_seconds ?? CHECK_SECONDS;
      return m
        ? keyHint(m, await programOf(m).modelCheck(m, once, seconds * 1000))
        : {
            ok: false,
            summary:
              "no model route yet: a rig given one by control takes it within a minute and checks it itself; else set one on control's settings page (or in the rig's settings)",
          };
    },
  };
}

/**
 * A failed check of one of OpenCode's own paid models through OpenCode's own client: control sends
 * it that way only when the provider has no key, and OpenCode then answers only that the model is
 * unavailable. The words say what it needs (issue 26).
 */
export function keyHint<R extends { ok: boolean; summary: string }>(
  m: { api?: string | undefined; model: string },
  r: R,
): R {
  if (r.ok || m.api !== "opencode" || m.model.endsWith("-free")) return r;
  return {
    ...r,
    summary: `${r.summary} (OpenCode serves ${m.model} only with its provider's key: add the key to the provider on control's Providers page, or choose a model whose name ends in -free)`,
  };
}

/**
 * The smoke check: a judge-only campaign from the smoke kit in the image, on the rig's target: the
 * core's own, or its runners' when its judge measures on them alone (goal 206), whose kind the
 * rig takes once one answers.
 */
export function addSmokeCheck(
  ctx: ControllerContext,
  service: HarnessService,
  driver: TargetDriver,
): void {
  const { env, paths } = ctx;
  service.rigChecks.smoke = {
    notNow: () => busyReason(paths.stateDir),
    run: async () => {
      const type = service.targetType ?? driver.type;
      return smokeCheck({
        service,
        targetType: type,
        targetClass: type === driver.type ? (await driver.identify()).class : type,
        checksDir: checksDir(env),
        scratchDir: paths.scratchDir,
      });
    },
  };
}
