import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { totalmem } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { freeSpace, gib } from "../../common/disk.ts";
import { folderBytes } from "../../common/fs.ts";
import { RUNNER_BUILDS_MAX, type RunAsk, type RunnerBuilds } from "../../core/api/harness/runs.ts";
import { laneCacheEnv, prepareWorkspace } from "../agents/index.ts";
import type { Role, Runner } from "../broker/index.ts";
import { fetchBundle, hasCommit, initMirror, refTips } from "../git.ts";
import { importFile } from "../imports.ts";
import {
  BUILD_KEY,
  baselineDir,
  CoreRunner,
  exportKit,
  keepBaselineDir,
  loadKit,
  prepareBaselineDir,
  removeBaselineDir,
  removeBuild,
} from "../judge/index.ts";
import type { Ledger } from "../ledger/index.ts";
import { onGpu, readThrottle, type TargetDriver } from "../targets/index.ts";

/**
 * A runner process (goal 206): the target resources of its machine, each a runner by its place
 * among them (`card`), with the broker's users of that card, as the core's own runner has. It
 * answers the core's asks (core/api/harness/runs.ts): it keeps the commits it was sent in mirrors
 * of its own, the kits it exported, its builds, the runs' kept baselines and model files, and
 * refuses any folder it did not name itself. A runner takes one run at a time: a build or a
 * measurement on a card waits for the one before it there.
 */

/** Where the core's bundles go in a runner's mirror: each sent ref under it. */
const SENT = "refs/thermite/imports/core";
/** How long a card's use may take to read, for its core's check (goal 231). */
const USE_WAIT_MS = 5000;

interface RunHostOptions {
  runner: Runner;
  /** One driver for each card, in order. */
  drivers: TargetDriver[];
  paths: { stateDir: string; scratchDir: string; inboxDir: string };
  /** The runner process's own ledger: its builds. */
  ledger: Ledger;
}

export class RunHost {
  private readonly o: RunHostOptions;
  private readonly cards: CoreRunner[];
  /** Each build's time and bytes, by its key: a build never changes once stored (goal 259). */
  private readonly buildSizes = new Map<string, { at: number; bytes: number }>();
  /** Each card's run in progress: the next waits for it. */
  private readonly busy = new Map<number, Promise<unknown>>();

  constructor(o: RunHostOptions) {
    if (!o.drivers.length) throw new Error("a runner process needs a target resource");
    this.o = o;
    this.cards = o.drivers.map(
      (driver, index) =>
        new CoreRunner({ runner: o.runner, driver, paths: o.paths, ledger: o.ledger, index }),
    );
  }

  /** A mirror of the runner's, by its name. */
  private mirror(repo: string): string {
    return join(this.o.paths.stateDir, "git", `${repo}.git`);
  }

  private card(i: number): CoreRunner {
    const c = this.cards[i];
    if (!c) throw new RunRefusal(`this runner process has no runner ${i}`);
    return c;
  }

  /** One run at a time on a card: `run` starts once the card's last one ended. */
  private async one<T>(card: number, run: () => Promise<T>): Promise<T> {
    const before = this.busy.get(card) ?? Promise.resolve();
    const now = before.catch(() => undefined).then(run);
    this.busy.set(card, now);
    try {
      return await now;
    } finally {
      if (this.busy.get(card) === now) this.busy.delete(card);
    }
  }

  /** A folder under `top` the runner named, resolved; anything else is refused. */
  private within(top: string, p: string, what: string): string {
    const full = resolve(p);
    if (!full.startsWith(resolve(top) + sep)) throw new RunRefusal(`not a ${what}: ${p}`);
    return full;
  }

  private runFolder(p: string): string {
    return this.within(join(this.o.paths.scratchDir, "runs"), p, "run's folder of this runner");
  }

  /** The kit at a commit, exported once from the runner's mirror of it. */
  private async kit(repo: string, commit: string) {
    const dir = await exportKit(this.o.paths.stateDir, this.mirror(repo), commit);
    return { kit: loadKit(dir), dir };
  }

  /**
   * What the runner process keeps (goal 206), for its rig's page: its state volume's size and free
   * space, and how many builds and kits it holds.
   */
  private store(): { total_gib?: number; free_gib?: number; builds: number; kits: number } {
    const { stateDir } = this.o.paths;
    const count = (dir: string) => {
      try {
        return readdirSync(dir).filter((n) => !n.includes(".tmp-")).length;
      } catch {
        return 0;
      }
    };
    let disk: { total_gib: number; free_gib: number } | undefined;
    try {
      const f = freeSpace(stateDir);
      disk = { total_gib: gib(f.total), free_gib: gib(f.free) };
    } catch {}
    return {
      ...disk,
      builds: count(join(stateDir, "builds")),
      kits: count(join(stateDir, "kits")),
    };
  }

  /**
   * The judge's builds this runner keeps (goal 259): each as [its key, when it was made, its bytes],
   * oldest first, for its core's Space and a retention policy, which only its core can judge.
   */
  private keptBuilds(): RunnerBuilds {
    const dir = join(this.o.paths.stateDir, "builds");
    const all: [string, number, number][] = [];
    for (const key of existsSync(dir) ? readdirSync(dir) : []) {
      if (!BUILD_KEY.test(key)) continue;
      let at: number;
      try {
        at = statSync(join(dir, key, "manifest.json")).mtimeMs;
      } catch {
        continue;
      }
      let size = this.buildSizes.get(key);
      if (size?.at !== at) {
        size = { at, bytes: folderBytes(join(dir, key)) };
        this.buildSizes.set(key, size);
      }
      all.push([key, Math.floor(at), size.bytes]);
    }
    all.sort((a, b) => a[1] - b[1]);
    return {
      builds: all.slice(0, RUNNER_BUILDS_MAX),
      more: Math.max(0, all.length - RUNNER_BUILDS_MAX),
    };
  }

  /**
   * The use now of the cards asked (goal 231), each `{card, util_pct, mem_used_mib,
   * mem_total_mib}`; a card that can't say within USE_WAIT_MS is left out.
   */
  private async gpus(cards: number[]): Promise<object[]> {
    const read = async (card: number) => {
      const c = this.cards[card];
      if (!c?.driver.use) return [];
      const timer = new Promise<undefined>((r) =>
        setTimeout(() => r(undefined), USE_WAIT_MS).unref?.(),
      );
      const u = await Promise.race([c.driver.use().catch(() => undefined), timer]);
      return u ? [{ card, ...u }] : [];
    };
    return (await Promise.all(cards.map(read))).flat();
  }

  /** Answers one ask of the core. */
  async ask(a: RunAsk): Promise<object> {
    switch (a.op) {
      case "info":
        return {
          type: this.card(0).driver.type,
          separated: this.o.runner.separated,
          cards: this.cards.length,
          store: this.store(),
          ...(a.gpus?.length ? { gpus: await this.gpus(a.gpus) } : {}),
        };
      case "git_has": {
        const m = this.mirror(a.repo);
        const has = existsSync(join(m, "HEAD")) && (await hasCommit(m, a.commit));
        return { has, heads: has ? [] : await refTips(m, SENT) };
      }
      case "build": {
        const card = this.card(a.card);
        const k = await this.kit(a.kit_repo, a.kit_commit);
        return this.one(a.card, () =>
          card.build({
            repo: a.repo,
            mirror: this.mirror(a.repo),
            commit: a.commit,
            kit: k.kit,
            kitDir: k.dir,
            kitRepo: a.kit_repo,
            kitCommit: a.kit_commit,
            actor: a.actor,
          }),
        );
      }
      case "measure": {
        const card = this.card(a.card);
        const k = await this.kit(a.spec.kit_repo, a.spec.kit_commit);
        const b = a.spec.baseline;
        let baseline: { written: string } | { kept: string; run: string; job: number } | undefined;
        if (b && "written" in b) baseline = { written: this.runFolder(b.written) };
        else if (b) {
          const kept = baselineDir(this.o.paths.stateDir, b.run, b.job);
          if (!existsSync(kept)) throw new RunRefusal(`no kept baseline of ${b.run} here`);
          baseline = { kept, run: b.run, job: b.job };
        }
        const m = await this.one(a.card, () =>
          card.measure(
            {
              job: a.spec.job,
              kit: k.kit,
              kitDir: k.dir,
              kitRepo: a.spec.kit_repo,
              kitCommit: a.spec.kit_commit,
              ...(baseline ? { baseline } : {}),
              ...(a.spec.uses ? { uses: new Set(a.spec.uses) } : {}),
              ...(a.spec.at ? { at: a.spec.at } : {}),
            },
            // The build's folder is one this runner named in its build's answer.
            { ...a.arm, manifest: a.arm.manifest as never },
            a.cell,
          ),
        );
        const implausible = m.run.kind === "ok" ? card.driver.plausibility(m.run.metrics) : [];
        return { run: m.run, throttled: m.throttled ?? null, implausible };
      }
      case "driver": {
        const d = this.card(a.card).driver;
        const answer =
          a.ask === "identify"
            ? await d.identify()
            : a.ask === "ready"
              ? await d.readyForTiming()
              : a.ask === "env"
                ? await d.envSnapshot()
                : a.ask === "after_block"
                  ? await d.afterBlock()
                  : await d.recover();
        return { answer };
      }
      case "throttle":
        return { sample: readThrottle() ?? null };
      case "baseline_work":
        return { dir: await this.card(a.card).baselineWork(a.job) };
      case "baseline_keep": {
        const written = this.runFolder(a.written);
        const to = prepareBaselineDir(this.o.paths.stateDir, a.run, a.job);
        const sealed = await this.card(a.card).keepBaseline(written, {
          dir: to,
          run: a.run,
          job: a.job,
        });
        if (!sealed.ok) {
          removeBaselineDir(to);
          return sealed;
        }
        const contents = sealed.files.map((f) => ({
          path: f.path,
          base64: readFileSync(join(to, f.path)).toString("base64"),
        }));
        return { ...sealed, contents };
      }
      case "baseline_put": {
        if (existsSync(baselineDir(this.o.paths.stateDir, a.run, a.job))) return { ok: true };
        // Written in a folder of its own, then kept as a baseline job keeps its checks' folder.
        const tmp = join(this.o.paths.scratchDir, "runs", `put-${randomUUID()}`);
        try {
          mkdirSync(tmp, { recursive: true });
          for (const f of a.files) {
            const at = this.within(tmp, join(tmp, f.path), "file of the baseline");
            mkdirSync(dirname(at), { recursive: true });
            writeFileSync(at, Buffer.from(f.base64, "base64"));
          }
          keepBaselineDir(tmp, prepareBaselineDir(this.o.paths.stateDir, a.run, a.job));
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
        return { ok: true };
      }
      case "remove":
        await this.card(0).remove(this.runFolder(a.dir));
        return { ok: true };
      case "builds":
        return this.keptBuilds();
      case "remove_build": {
        const removed = removeBuild(join(this.o.paths.stateDir, "builds"), a.key);
        this.buildSizes.delete(a.key);
        return { removed };
      }
      case "models_have": {
        const models = join(this.o.paths.stateDir, "models");
        return { missing: a.sha256s.filter((sha) => !existsSync(join(models, sha))) };
      }
      case "models_take":
        // Each checked against its SHA-256 as it is copied in, as an assignment's models are.
        for (const m of a.models)
          await importFile({
            inboxDir: this.o.paths.inboxDir,
            rel: m.path,
            expectedSha256: m.sha256,
            storeDir: join(this.o.paths.stateDir, "models"),
          });
        return { ok: true };
      case "lane_run":
        this.card(a.card);
        return this.one(a.card, () => this.laneRun(a));
      case "lane_end": {
        const ws = this.workspaces.get(a.trial);
        this.workspaces.delete(a.trial);
        await this.o.runner.killRole(a.lane as Role).catch(() => 0);
        if (ws) await this.o.runner.remove(ws.dir).catch(() => undefined);
        return { ok: true };
      }
    }
  }

  /** Each trial's workspace on this runner, kept for its next runs until it ends. */
  private readonly workspaces = new Map<string, { dir: string; repo: string; lane: string }>();

  /**
   * A lane's command on its change: the trial's workspace, made from the parent once, set to the
   * parent with the change on it (what an earlier run built where git ignores it stays), then the
   * command, as the lane's user with the device's group, within the lane's limits.
   */
  private async laneRun(a: Extract<RunAsk, { op: "lane_run" }>): Promise<object> {
    const lane = a.lane as Role;
    let ws = this.workspaces.get(a.trial);
    if (!ws || ws.lane !== a.lane) {
      const made = await prepareWorkspace({
        runner: this.o.runner,
        scratchDir: this.o.paths.scratchDir,
        mirror: this.mirror(a.repo),
        commit: a.parent,
        lane,
      });
      ws = { ...made, lane: a.lane };
      this.workspaces.set(a.trial, ws);
    }
    const env = laneCacheEnv(this.o.paths.scratchDir, a.lane);
    const rss =
      (a.limits.rss_machine ? machineRssMib(a.limits.rss_mib) : a.limits.rss_mib) * 2 ** 20;
    const disk = { path: ws.dir, limitBytes: a.limits.disk_mib * 1024 * 1024 };
    const nproc = a.limits.processes !== undefined ? { nproc: a.limits.processes } : {};
    const setUp = await this.o.runner.run({
      role: lane,
      argv: [
        "sh",
        "-c",
        "git reset --hard -q && git clean -fdq && git apply --binary --whitespace=nowarn",
      ],
      cwd: ws.repo,
      env,
      stdin: Buffer.from(a.patch, "base64").toString("utf8"),
      rssLimitBytes: rss,
      disk,
      ...nproc,
      captureBytes: 32 * 1024,
    });
    if (setUp.exitCode !== 0)
      return {
        ran: false,
        reason: `the change did not apply on the parent: ${setUp.stderr.slice(-1500)}`,
      };
    try {
      const r = await this.o.runner.run({
        role: lane,
        argv: ["sh", "-c", a.command],
        cwd: ws.repo,
        env,
        ...(a.timeout_s !== undefined ? { timeoutMs: a.timeout_s * 1000 } : {}),
        rssLimitBytes: rss,
        disk,
        ...nproc,
        captureBytes: 32 * 1024,
        gpu: onGpu(this.card(0).driver.type),
        ...(onGpu(this.card(0).driver.type) ? {} : { keepBackground: true }),
      });
      return {
        ran: true,
        exit: r.exitCode ?? r.signal,
        killed: r.killedFor,
        wall_ms: Math.round(r.wallMs),
        peak_rss_mib: Math.round(r.peakRssBytes / 2 ** 20),
        // The run's memory limit here (goal 219): on the lane's own runner, the machine's.
        memory_limit_mib: Math.round(rss / 2 ** 20),
        stdout: r.stdout.slice(-6_000),
        stderr: r.stderr.slice(-3_000),
        note: "diagnostic only: this number never counts",
      };
    } finally {
      // Nothing a run started on the device outlives it.
      await this.o.runner.killRole(lane, { gpu: true }).catch(() => 0);
    }
  }

  /** Takes a bundle of commits the core sent for one mirror; `commit` must be in it. */
  async takeGit(repo: string, commit: string, bundle: Buffer): Promise<void> {
    const m = this.mirror(repo);
    await initMirror(m);
    const file = join(this.o.paths.scratchDir, `bundle-${randomUUID()}`);
    writeFileSync(file, bundle, { mode: 0o600 });
    try {
      await fetchBundle(m, file, "core", commit);
    } finally {
      rmSync(file, { force: true });
    }
  }
}

/** An ask the runner refuses: a runner it lacks, or a folder it did not name. */
export class RunRefusal extends Error {}

/**
 * A lane's run's memory on its own runner when no one set it (goal 219): the memory the runner's
 * process may use, the machine's or its container's limit when that is lower, less the larger of
 * 4 GiB and a tenth of it, for the runner's own processes; never less than the default the core
 * sent. So the run's own limit ends it, in words, before the container's kills a process. In a
 * 108 GiB container, about 97 GiB.
 */
export function machineRssMib(
  given: number,
  total = totalmem(),
  container = process.constrainedMemory(),
): number {
  const bytes = container > 0 && container < total ? container : total;
  const mib = Math.floor(bytes / 2 ** 20);
  return Math.max(given, mib - Math.max(4096, Math.ceil(mib / 10)));
}
