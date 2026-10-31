import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { parseListen } from "../common/env.ts";
import { log, startLogging } from "../common/log.ts";
import { createHarnessApi } from "./api/index.ts";
import {
  addIsolationCheck,
  addModelCheck,
  addSmokeCheck,
  agentLinks,
  agentParts,
  controllerContext,
  createJudges,
  createScheduler,
  gpuSplitAtStart,
  openState,
  promotionPolicy,
  reclaimJobs,
  rigHardware,
  rigSettings,
  startLoops,
  targetDrivers,
} from "./controller/index.ts";
import { DiskWatch } from "./disk.ts";
import { HarnessService } from "./service/index.ts";

/**
 * The harness controller: owns the ledger, serves the API and drives the executor.
 *
 * Its parts are in controller/: what they share is context.ts (built once here), then targets.ts,
 * state.ts, agents.ts, checks.ts, judges.ts and loops.ts. The order of this function is the rig's
 * behaviour at its start: the folders, the targets, the private folders' modes, the wipe, the
 * ledger and the keys, the settings, the service, the hardware, the reconciliation, the agents'
 * shared parts, the isolation check before the API, the judge or any agent, then the API, the
 * judge, the agents, the loops and the stop. A part that needs another's result takes it as an
 * argument.
 */
async function main(): Promise<void> {
  // Exports and builds are read by other users (the supervisor, the run user): no group or
  // world write.
  process.umask(0o022);
  const env = process.env;
  startLogging("harness", env);
  const ctx = await controllerContext(env);
  const { rig, paths, controlPublicKeyPem, tokens, runner } = ctx;
  const targets = targetDrivers(ctx);
  const { driver } = targets;
  const { ledger, rigKeys } = openState(ctx);
  const promotion = promotionPolicy(env);
  const settings = rigSettings(ctx, promotion);
  const { gpuSet, judgeNow } = gpuSplitAtStart(env);
  const service = new HarnessService({
    rig,
    ledger,
    paths,
    controlPublicKeyPem,
    rigKeys,
    promotion,
    targetType: driver.type,
    settings,
  });
  if (gpuSet >= 2) service.gpuSplit = { set: gpuSet, judge: judgeNow };
  // A drain's deadline when its command gives none, and the disk's floor on each place the
  // harness writes to (goal 173).
  service.drainMinutes = ctx.numbers.drainMinutes;
  service.disk = new DiskWatch({
    ledger,
    floorGib: ctx.numbers.diskFloorGib,
    places: [
      { name: "state", path: paths.stateDir },
      { name: "scratch", path: paths.scratchDir },
      { name: "outbox", path: paths.outboxDir },
    ],
  });
  service.onWipe = () => {
    log("harness", "wipe requested: exiting so the next start wipes the state");
    process.exit(0);
  };
  const judging = await rigHardware(ctx, service, targets);
  const executorIds = reclaimJobs(ledger, judging);
  const parts = agentParts(ctx, ledger, service, targets);

  // A check a previous controller left running is over.
  service.reconcileRigChecks();
  addIsolationCheck(ctx, service);
  // The isolation check at every start, before the API, the judge or any agent runs: nothing of
  // theirs can be running yet, and control sees the result beside the rig's hardware.
  await service.checkAtStart("isolation");

  const { host, port } = parseListen(env.THERMITE_LISTEN ?? "0.0.0.0:8700");
  const server = serve({
    fetch: createHarnessApi(service, tokens, {
      devRuns: parts.devRuns,
      research: parts.research,
      lanes: {
        runner,
        laneTool: [
          process.execPath,
          fileURLToPath(new URL("./agents/lanetool.js", import.meta.url)),
        ],
      },
    }).fetch,
    hostname: host,
    port,
  });
  log("harness", "listening", {
    rig,
    host,
    port,
    target: (await driver.identify()).id,
    build: service.build,
  });

  const executors = createJudges(ctx, {
    service,
    promotion,
    devRuns: parts.devRuns,
    judging,
    judgeCards: targets.judgeCards,
    executorIds,
  });
  const links = agentLinks(ctx, service, port);
  addModelCheck(service, links);
  addSmokeCheck(ctx, service, driver);
  const scheduler = createScheduler(ctx, {
    service,
    settings,
    links,
    parts,
    split: { gpuSet, judgeNow },
  });
  startLoops(ctx, { ledger, service, settings, scheduler, executors, executorIds, server });
}

main().catch((err) => {
  log("harness", "fatal", { error: err instanceof Error ? err.stack : String(err) }, "error");
  process.exit(1);
});
