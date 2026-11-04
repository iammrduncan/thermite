import { errorText } from "../../common/errors.ts";
import { log } from "../../common/log.ts";
import type { RunnerSetting } from "../../core/rig-settings.ts";
import {
  type Pool,
  RemoteRunner,
  type RunLink,
  RunnerAway,
  type RunnerLink,
  RunnerPools,
} from "../judge/index.ts";
import type { HarnessService } from "../service/index.ts";

/**
 * The core's runners of other machines as they come and go (goal 206): the rig's `runners`
 * setting names its runner processes and the pool of each runner they serve. The core takes a
 * change while it works: a process added joins (its runners' places in their pools, and an
 * executor of the judge's for each runner of the judge's or the shared pool), and takes runs once
 * it answers its check; one taken away, or whose pools changed, leaves, and its run under way
 * fails, which the judge tries again and a lane is told of. The core checks each process every
 * CHECK_EVERY_MS: one that fails AWAY_AFTER checks in a row is away, its run under way fails, and
 * it takes runs again once it answers.
 */

/** How often the core checks that each runner process answers, and how long a check waits. */
const CHECK_EVERY_MS = 15_000;
const CHECK_WAIT_MS = 20_000;
/** Checks failed in a row before a runner process is away. */
const AWAY_AFTER = 2;

/** The judge's executors on runners of other machines, made and stopped as they come and go. */
export interface RunnerExecutors {
  /** A runner the judge may use joined: its executor starts. */
  add(runner: RemoteRunner, shared: boolean): void;
  /** It left: its executor stops once its job under way failed and went back to the queue. */
  remove(runner: RemoteRunner): void;
}

interface Process {
  setting: RunnerSetting;
  runners: { runner: RemoteRunner; pool: Pool }[];
  up: boolean;
  /** Checks failed in a row. */
  failed: number;
  checking: boolean;
  /** Why it does not take runs although it answers, said once. */
  unfit?: string | undefined;
  /** Its kind of target, as it last answered while it fit. */
  type?: string | undefined;
  /** When it last answered its check, and since when it is away. */
  answeredAt?: number | undefined;
  awaySince?: number | undefined;
  /**
   * Why its runs fail now: it left or is away. A run's next ask fails at once, as a runner away,
   * never as the judge's infrastructure failure. Its check is asked all the same.
   */
  away?: string | undefined;
}

export class RunnerHub {
  readonly pools = new RunnerPools();
  private readonly processes = new Map<string, Process>();
  private readonly o: {
    service: HarnessService;
    link: RunnerLink;
    /**
     * The core's kind of target, whether its roles are separated, and whether the judge measures
     * on its own machine too. When it does, a runner measures on the core's kind of target; when
     * not, on its other runners', and the rig's target is theirs.
     */
    core: { type: string; separated: boolean; judges: boolean };
    /** Set once the judge's loops run. */
    executors?: RunnerExecutors | undefined;
    checkEveryMs?: number | undefined;
    checkWaitMs?: number | undefined;
  };

  constructor(o: RunnerHub["o"]) {
    this.o = o;
  }

  /** The judge's executors, once its loops run: the runners that joined before get theirs. */
  set executors(e: RunnerExecutors) {
    this.o.executors = e;
    for (const p of this.processes.values()) for (const r of p.runners) this.addExecutor(r);
  }

  /** The rig's runner processes now: those that changed leave, the new ones join. */
  apply(list: readonly RunnerSetting[]): void {
    const want = new Map(list.map((r) => [r.name, r]));
    for (const [name, p] of this.processes) {
      const w = want.get(name);
      if (w && w.pools.join("+") === p.setting.pools.join("+")) continue;
      this.leave(name, `the runner ${name} ${w ? "changed its pools" : "left the rig"}`);
    }
    for (const r of list) if (!this.processes.has(r.name)) this.join(r);
  }

  /** Each runner process now: its pools, whether it takes runs, and why not when it answers. */
  state(): { name: string; pools: string[]; up: boolean; why?: string }[] {
    return [...this.processes.values()].map((p) => ({
      name: p.setting.name,
      pools: [...p.setting.pools],
      up: p.up,
      ...(p.unfit ? { why: p.unfit } : {}),
    }));
  }

  /**
   * The rig's runners for its report to control: each process, whether it takes runs, when it
   * last answered or since when it is away, and who holds each of its runners; and who waits.
   */
  report(): {
    processes: {
      name: string;
      pools: string[];
      up: boolean;
      why?: string;
      answered_at: string | null;
      away_since: string | null;
      runners: { name: string; pool: string; holder: string | null }[];
    }[];
    waiting: string[];
  } {
    const at = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
    return {
      processes: [...this.processes.values()].map((p) => ({
        name: p.setting.name,
        pools: [...p.setting.pools],
        up: p.up,
        ...(p.unfit ? { why: p.unfit } : p.away && !p.up ? { why: p.away } : {}),
        answered_at: at(p.answeredAt),
        away_since: at(p.awaySince),
        runners: p.runners.map((r) => ({
          name: r.runner.name,
          pool: r.pool,
          holder: this.pools.holderOf(r.runner) ?? null,
        })),
      })),
      waiting: this.pools.waiting(),
    };
  }

  /** Checks every runner process on a timer; the function returned stops it. */
  start(): () => void {
    const timer = setInterval(() => {
      for (const name of this.processes.keys()) void this.check(name);
    }, this.o.checkEveryMs ?? CHECK_EVERY_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private join(setting: RunnerSetting): void {
    const { service, link, core } = this.o;
    const p: Process = { setting, runners: [], up: false, failed: 0, checking: false };
    const to = link.to(setting.name);
    const away = () => (p.away ? Promise.reject(new RunnerAway(p.away)) : undefined);
    const guarded: RunLink = {
      ask: (a, ms) => away() ?? to.ask(a, ms),
      sendGit: (repo, commit, bundle) => away() ?? to.sendGit(repo, commit, bundle),
      fetchModels: (models) => away() ?? to.fetchModels(models),
    };
    p.runners = setting.pools.map((pool, card) => ({
      pool,
      runner: new RemoteRunner({
        name: `${setting.name}-${card}`,
        link: guarded,
        card,
        info: core,
        ledger: service.ledger,
        mirrorFor: (repo) => service.mirrorFor(repo),
        scratchDir: service.paths.scratchDir,
      }),
    }));
    for (const r of p.runners) {
      this.pools.add(r.runner, r.pool);
      this.addExecutor(r);
    }
    this.processes.set(setting.name, p);
    log("harness", "a runner process joins the rig: it takes runs once it answers", {
      runner: setting.name,
      pools: setting.pools,
    });
    void this.check(setting.name);
  }

  private addExecutor(r: { runner: RemoteRunner; pool: Pool }): void {
    if (r.pool === "judge" || r.pool === "shared")
      this.o.executors?.add(r.runner, r.pool === "shared");
  }

  private leave(name: string, why: string): void {
    const p = this.processes.get(name);
    if (!p) return;
    this.processes.delete(name);
    p.away = why;
    for (const r of p.runners) {
      this.pools.remove(r.runner);
      if (r.pool === "judge" || r.pool === "shared") this.o.executors?.remove(r.runner);
    }
    this.o.link.fail(name, why);
    log("harness", "a runner process leaves the rig", { runner: name, why });
  }

  /**
   * Asks a runner process what it serves: up when it answers and fits the rig, away after
   * AWAY_AFTER failed checks in a row, when its run under way fails.
   */
  private async check(name: string): Promise<void> {
    const p = this.processes.get(name);
    if (!p || p.checking) return;
    p.checking = true;
    try {
      const info = (await this.o.link
        .to(name)
        .ask({ op: "info" }, this.o.checkWaitMs ?? CHECK_WAIT_MS)) as {
        type?: unknown;
        separated?: unknown;
        cards?: unknown;
      };
      if (this.processes.get(name) !== p) return;
      p.failed = 0;
      p.answeredAt = Date.now();
      const unfit = this.unfit(p, info);
      if (unfit) {
        if (p.unfit !== unfit)
          log(
            "harness",
            "a runner process answers but takes no runs",
            { runner: name, why: unfit },
            "warn",
          );
        p.unfit = unfit;
        this.setUp(p, false, unfit);
        return;
      }
      p.unfit = undefined;
      // Its own kind of target: a core on a CPU machine judges on runners with GPUs.
      const own = { type: String(info.type), separated: info.separated === true };
      p.type = own.type;
      for (const r of p.runners) r.runner.setInfo(own);
      const { service, core } = this.o;
      if (!core.judges && service.targetType !== own.type) {
        log("harness", "the rig measures on its runners' kind of target", {
          was: service.targetType,
          now: own.type,
        });
        service.targetType = own.type;
      }
      if (!p.up) log("harness", "a runner process answers: it takes runs", { runner: name });
      this.setUp(p, true);
    } catch (err) {
      if (this.processes.get(name) !== p) return;
      p.failed++;
      if (p.up && p.failed >= AWAY_AFTER) {
        log("harness", "a runner process stopped answering: its run under way fails", {
          runner: name,
          error: errorText(err),
        });
        this.setUp(p, false, `the runner ${name} stopped answering`);
      }
    } finally {
      p.checking = false;
    }
  }

  /** Why a process that answers can't take the rig's runs, or undefined. */
  private unfit(p: Process, info: { type?: unknown; separated?: unknown; cards?: unknown }) {
    const { core } = this.o;
    if (typeof info.type !== "string" || typeof info.separated !== "boolean")
      return "its answer names no kind of target: it runs another image";
    if (core.judges && info.type !== core.type)
      return `it measures on ${info.type}, and the rig's core on ${core.type}`;
    const others = [...this.processes.values()].find((o) => o !== p && o.up && o.type);
    if (others?.type && info.type !== others.type)
      return `it measures on ${info.type}, and the rig's other runners on ${others.type}`;
    if (typeof info.cards !== "number" || info.cards < p.setting.pools.length)
      return `it serves ${String(info.cards)} runners, and the rig gives it ${p.setting.pools.length} pools`;
    return undefined;
  }

  private setUp(p: Process, up: boolean, why?: string): void {
    const was = p.up;
    p.up = up;
    if (up) {
      p.away = undefined;
      p.awaySince = undefined;
    } else if (was) {
      p.away = why ?? `the runner ${p.setting.name} is away`;
      p.awaySince = Date.now();
    }
    for (const r of p.runners) {
      if (up && !was) r.runner.forget();
      this.pools.setUp(r.runner, up);
    }
    if (was && !up) this.o.link.fail(p.setting.name, why ?? `the runner ${p.setting.name} is away`);
  }
}
