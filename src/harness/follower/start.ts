import { serve } from "@hono/node-server";
import { parseListen } from "../../common/env.ts";
import { log } from "../../common/log.ts";
import { controllerContext, openState, targetDrivers } from "../controller/index.ts";
import { followerApi } from "./api.ts";
import { DeviceServer } from "./device.ts";

/**
 * The harness started as a follower of a rig's leader (goal 205, THERMITE_ROLE=follower): the
 * broker and its roles as on any rig, its own state and ledger for its builds, and its judge GPUs
 * served to the leader through its supervisor. It runs no run of its own: no scheduler, no
 * planner and no judge's queue.
 */
export async function startFollower(env: NodeJS.ProcessEnv): Promise<void> {
  const ctx = await controllerContext(env);
  const { rig, paths, tokens, runner } = ctx;
  const targets = targetDrivers(ctx);
  const { ledger } = openState(ctx);
  const device = new DeviceServer({ runner, drivers: targets.drivers, paths, ledger });
  const { host, port } = parseListen(env.THERMITE_LISTEN ?? "0.0.0.0:8700");
  serve({ fetch: followerApi(device, tokens, rig).fetch, hostname: host, port });
  log("harness", "listening as a follower", {
    rig,
    host,
    port,
    target: (await targets.driver.identify()).id,
    judge_cards: targets.drivers.length,
  });
}
