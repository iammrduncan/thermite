import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { parseListen } from "../../common/env.ts";
import { log } from "../../common/log.ts";
import { DevRuns, programOf } from "../agents/index.ts";
import { controllerContext, openState, targetDrivers } from "../controller/index.ts";
import { followerApi } from "./api.ts";
import { DeviceServer } from "./device.ts";
import { LaneHost } from "./lanes.ts";

/**
 * The harness started as a follower of a rig's leader (goal 205, THERMITE_ROLE=follower): the
 * broker and its roles as on any rig, its own state and ledger for its builds, and its judge GPUs
 * and the lanes the leader gives it served through its supervisor. It runs no run of its own: no
 * scheduler, no planner and no judge's queue.
 */
export async function startFollower(env: NodeJS.ProcessEnv): Promise<void> {
  const ctx = await controllerContext(env);
  const { rig, paths, tokens, runner } = ctx;
  const targets = targetDrivers(ctx);
  const { ledger } = openState(ctx);
  const { host, port } = parseListen(env.THERMITE_LISTEN ?? "0.0.0.0:8700");
  // Its lanes' trials (step 2): dev runs on its workers' cards, never waiting for a judge here.
  let lanes: LaneHost | undefined;
  const devRuns = new DevRuns({
    runner,
    ledger,
    scratchDir: paths.scratchDir,
    gpu: targets.driver.type === "cuda-gpu",
    dedicated: targets.devCard?.layout !== undefined,
    judgeShares: false,
    cards: targets.devCards.length || undefined,
    unavailable: targets.devCard?.error,
    isOpen: (trial) => lanes?.isOpen(trial) === true,
  });
  lanes = new LaneHost({
    runner,
    scratchDir: paths.scratchDir,
    mirror: (repo) => device.mirror(repo),
    port,
    runTrial: (spec, link) => programOf(link.model).runTrial({ mode: "code", spec }, link),
    devRuns,
  });
  const device = new DeviceServer({ runner, drivers: targets.drivers, paths, ledger, lanes });
  const laneRunner = {
    runner,
    scratchDir: paths.scratchDir,
    laneTool: [process.execPath, fileURLToPath(new URL("../agents/lanetool.js", import.meta.url))],
  };
  serve({
    fetch: followerApi(device, tokens, rig, { host: lanes, lanes: laneRunner, devRuns }).fetch,
    hostname: host,
    port,
  });
  log("harness", "listening as a follower", {
    rig,
    host,
    port,
    target: (await targets.driver.identify()).id,
    judge_cards: targets.drivers.length,
  });
}
