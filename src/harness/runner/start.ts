import { serve } from "@hono/node-server";
import { parseListen } from "../../common/env.ts";
import { log } from "../../common/log.ts";
import { controllerContext, openState, targetDrivers } from "../controller/index.ts";
import { runnerApi } from "./api.ts";
import { RunHost } from "./host.ts";

/**
 * The harness started as a runner of a rig (goal 206, THERMITE_ROLE=runner): the broker and its
 * roles as on any rig, its own state and ledger for its builds, and its target resources served
 * to the rig's core through its supervisor. It runs no run of its own: no scheduler, no planner,
 * no judge's queue and no agent.
 */
export async function startRunner(env: NodeJS.ProcessEnv): Promise<void> {
  const ctx = await controllerContext(env);
  const { rig, paths, tokens, runner } = ctx;
  const targets = targetDrivers(ctx);
  const { ledger } = openState(ctx);
  const host = new RunHost({ runner, drivers: targets.drivers, paths, ledger });
  const { host: address, port } = parseListen(env.THERMITE_LISTEN ?? "0.0.0.0:8700");
  serve({ fetch: runnerApi(host, tokens, rig).fetch, hostname: address, port });
  log("harness", "listening as a runner", {
    rig,
    host: address,
    port,
    target: (await targets.driver.identify()).id,
    runners: targets.drivers.length,
  });
}
