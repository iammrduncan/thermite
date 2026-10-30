import type { ServerType } from "@hono/node-server";
import { every } from "../../common/health.ts";
import { log } from "../../common/log.ts";
import type { Scheduler } from "../agents/index.ts";
import type { Judge } from "../judge/index.ts";
import type { Ledger } from "../ledger/index.ts";
import { settlePropagations } from "../propagation.ts";
import type { RigSettingsStore } from "../rig-settings.ts";
import { AWAKE_EVERY_MS, AwakeWatch, type HarnessService } from "../service/index.ts";
import type { ControllerContext } from "./context.ts";

/** How often each loop comes around when it has nothing to do (goal 173: its limit follows). */
const JUDGE_IDLE_MS = 1000;
const SCHEDULER_MS = 2000;
const EXPORTS_MS = 5000;

/**
 * The controller's loops: the judging loops, the scheduler's, the exports' and the awake loop, and
 * the stop on SIGTERM or SIGINT. Each ticks the service's `loops` once a round, for the health
 * route (goal 173): a judge in a job and the scheduler in the planner's call are busy, never late.
 * The exports loop also reads the disk against its floor and ends a drain at its deadline. The
 * awake loop records the time the harness did not run (service/gaps.ts).
 */
export function startLoops(
  ctx: ControllerContext,
  {
    ledger,
    service,
    settings,
    scheduler,
    executors,
    executorIds,
    server,
  }: {
    ledger: Ledger;
    service: HarnessService;
    settings: RigSettingsStore;
    scheduler: Scheduler;
    executors: Judge[];
    executorIds: string[];
    server: ServerType;
  },
): void {
  const { numbers } = ctx;
  const exportEveryMs = numbers.exportEveryMs;
  const { loops } = service;
  let stopping = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // What holds the judge's new jobs: a drain, or the disk at its floor (goal 173). The job under
  // way ends as it would.
  const held = () => service.draining !== undefined || service.disk?.held !== undefined;
  // Three independent loops: a judging job never holds up the scheduler (trials, epochs) or the
  // exports, and a slow planner call never holds up the judge.
  // One judging loop per judge card.
  const judgeLoop = async (executor: Judge, id: string) => {
    const name = `judge:${id}`;
    loops.add(name, JUDGE_IDLE_MS, () => (executor.job ? `job ${executor.job}` : undefined));
    while (!stopping) {
      let worked = false;
      try {
        // The judge off (Edit rig): jobs wait in the queue, nothing is measured. A draining rig,
        // or one at its disk floor, takes no new job (goals 079, 173): the one under way finishes
        // first and writes its verdict. It still takes back a lease that ran out, which starts
        // nothing: its holder is gone.
        if (settings.get().judge && !held()) worked = await executor.tick();
        else if (held()) executor.expireLeases();
      } catch (err) {
        log("harness", "executor error", { executor: id, error: String(err) }, "error");
      }
      loops.tick(name);
      if (!worked) await sleep(JUDGE_IDLE_MS);
    }
  };
  const scheduling = async () => {
    loops.add("scheduler", SCHEDULER_MS, () =>
      scheduler.planningFor ? `the planner's call for ${scheduler.planningFor}` : undefined,
    );
    while (!stopping) {
      try {
        await scheduler.tick();
      } catch (err) {
        log("harness", "scheduler error", { error: String(err) }, "error");
      }
      loops.tick("scheduler");
      await sleep(SCHEDULER_MS);
    }
  };
  const exporting = async () => {
    loops.add("exports", EXPORTS_MS);
    while (!stopping) {
      try {
        settlePropagations(ledger, "harness");
      } catch (err) {
        log("harness", "propagation settle error", { error: String(err) }, "error");
      }
      // The disk against its floor, and a drain at its deadline (goal 173).
      try {
        service.disk?.check();
        service.drainDeadline();
      } catch (err) {
        log("harness", "disk or drain check error", { error: String(err) }, "error");
      }
      // Hourly export for the supervisor to push (and an export command can force one). An
      // export's own event is not news, or an idle rig would export every hour forever. At the
      // disk floor it waits: the rig says why, once, and an export command is refused in words.
      const last = ledger.exports.last();
      const lastAt = last ? Date.parse(last.created_at) : 0;
      if (
        settings.get().exports &&
        !service.disk?.held &&
        ledger.recordedAfter(last?.through_event ?? 0, ["export_written"]) &&
        Date.now() - lastAt >= exportEveryMs
      ) {
        try {
          await service.export("scheduler");
        } catch (err) {
          log("harness", "export error", { error: String(err) }, "error");
        }
      }
      loops.tick("exports");
      await sleep(EXPORTS_MS);
    }
  };
  const running = Promise.all([
    ...executors.map((e, i) => judgeLoop(e, executorIds[i] as string)),
    scheduling(),
    exporting(),
  ]);
  // On a timer, so that no await of the other loops holds it: when its time jumps, the host slept
  // or the container was paused, and the research clocks leave that out.
  const awake = new AwakeWatch(ledger, service.clock().getTime());
  const awakeTimer = every(loops, "harness", "awake", AWAKE_EVERY_MS, () =>
    awake.note(service.clock().getTime()),
  );

  // A stop (goal 079): running trials stop and are recorded as interrupted, with the counters
  // their workers last reported. The judge's job under way is not waited for longer than a few
  // seconds: a container's stop gives little time, and its lease is taken back at the next start.
  // To let it finish, control drains the rig first (Update to these images).
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(awakeTimer);
    log("harness", "stopping", { signal });
    server.close();
    await scheduler
      .shutdown(`the harness is stopping (${signal})`)
      .catch((err) => log("harness", "trials not recorded at the stop", { error: String(err) }));
    const ended = await Promise.race([running.then(() => true), sleep(5000).then(() => false)]);
    if (ended) ledger.close();
    else
      log(
        "harness",
        "a judge job was under way at the stop: its lease is taken back at the next start",
      );
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
