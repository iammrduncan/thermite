import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ModelFetch, RunAsk } from "../../core/api/harness/runs.ts";
import { bundleOf } from "../git.ts";
import type { Ledger } from "../ledger/index.ts";
import type { Readiness, TargetDriver, TargetIdentity, ThrottleSample } from "../targets/index.ts";
import { type BaselineFile, keepBaselineDir } from "./baseline.ts";
import type { BuildResult } from "./builds.ts";
import type { Arm, ArmRun } from "./measure.ts";
import type { KeptBaseline, Measured, MeasureSpec, RigRunner, RunBuild, Sealed } from "./runner.ts";

/**
 * A runner of another machine (goal 206), as the core's judge uses it: each of its steps is an
 * ask of the runner process (core/api/harness/runs.ts), carried by the link, which is the core's
 * supervisor and the bus. Before a build it sends the commits the runner lacks, as a git bundle;
 * before a run on a run's kept baseline, that baseline's files. The core keeps the builds' records
 * and every baseline's files, as it does for its own runner.
 */

/** How the core reaches one runner process. */
export interface RunLink {
  /** An ask, failed when no answer comes in `answerMs` (the link's own limit when not given). */
  ask(a: RunAsk, answerMs?: number): Promise<unknown>;
  /** A git bundle for one of the runner's mirrors, which must hold `commit` after. */
  sendGit(repo: string, commit: string, bundle: Buffer): Promise<void>;
  /** Model files the runner's supervisor fetches from their sources and gives its process. */
  fetchModels(models: ModelFetch[]): Promise<void>;
}

interface RemoteRunnerOptions {
  /** The runner's name in the rig. */
  name: string;
  link: RunLink;
  /** The runner's place among its process's. */
  card: number;
  /**
   * Its kind of target and whether its roles are separated, as its process said: the core's
   * until its process answers (setInfo).
   */
  info: { type: string; separated: boolean };
  ledger: Ledger;
  /** The core's mirror of a repository, by its name. */
  mirrorFor: (repo: string) => string;
  scratchDir: string;
}

export class RemoteRunner implements RigRunner {
  readonly name: string;
  readonly driver: TargetDriver;
  private readonly o: RemoteRunnerOptions;
  /** Commits the runner has, as `<repo>@<commit>`. */
  private readonly sent = new Set<string>();
  /** Runs' kept baselines the runner has, as `<run>/<job>`. */
  private readonly baselines = new Set<string>();
  /** The runner's word on each run's values (a driver's plausibility), by the values. */
  private readonly implausible = new WeakMap<object, string[]>();
  /** Runs whose model files the runner has. */
  private readonly modelsHeld = new Set<string>();

  constructor(o: RemoteRunnerOptions) {
    this.o = o;
    this.name = o.name;
    const ask = async <T>(what: "identify" | "ready" | "env" | "after_block" | "recover") =>
      ((await o.link.ask({ op: "driver", card: o.card, ask: what })) as { answer: T }).answer;
    const info = () => this.o.info;
    this.driver = {
      get type() {
        return info().type;
      },
      identify: () => ask<TargetIdentity>("identify"),
      readyForTiming: () => ask<Readiness>("ready"),
      envSnapshot: () => ask<Record<string, unknown>>("env"),
      afterBlock: () => ask<string[]>("after_block"),
      recover: () => ask<Readiness>("recover"),
      plausibility: (metrics) => this.implausible.get(metrics) ?? [],
    };
  }

  get separated(): boolean {
    return this.o.info.separated;
  }

  /** Its kind of target and whether its roles are separated, as its process answered. */
  setInfo(info: { type: string; separated: boolean }): void {
    this.o.info = { type: info.type, separated: info.separated };
  }

  /**
   * What the core knows the runner holds, forgotten: it answers again after it was away, and may
   * be a new machine by the same name. It is sent what it lacks again.
   */
  forget(): void {
    this.sent.clear();
    this.baselines.clear();
    this.modelsHeld.clear();
  }

  /** Sends the runner a commit of one of the core's mirrors, as a bundle of what it lacks, once. */
  private async sendCommit(repo: string, commit: string): Promise<void> {
    const key = `${repo}@${commit}`;
    if (this.sent.has(key)) return;
    const has = (await this.o.link.ask({ op: "git_has", repo, commit })) as {
      has: boolean;
      heads: string[];
    };
    if (!has.has) {
      const file = join(this.o.scratchDir, `send-${randomUUID()}.bundle`);
      try {
        await bundleOf(this.o.mirrorFor(repo), commit, has.heads, file);
        await this.o.link.sendGit(repo, commit, readFileSync(file));
      } finally {
        rmSync(file, { force: true });
      }
    }
    this.sent.add(key);
  }

  async build(input: RunBuild): Promise<BuildResult> {
    const { kitRepo } = input;
    await this.sendCommit(input.repo, input.commit);
    await this.sendCommit(kitRepo, input.kitCommit);
    const r = (await this.o.link.ask({
      op: "build",
      card: this.o.card,
      repo: input.repo,
      commit: input.commit,
      kit_repo: kitRepo,
      kit_commit: input.kitCommit,
      actor: input.actor,
    })) as BuildResult;
    // The build's record is the core's too, as a build on its own runner is.
    if (!r.ok || !r.cached)
      this.o.ledger.builds.record({
        key: r.ok ? r.manifest.key : r.key,
        repo: input.repo,
        commit: input.commit,
        kitCommit: input.kitCommit,
        ok: r.ok,
        manifest: r.ok ? r.manifest : { reason: r.reason },
        actor: input.actor,
      });
    return r;
  }

  /** Sends the runner a run's kept baseline from the core's copy, once. */
  private async sendBaseline(b: { kept: string; run: string; job: number }): Promise<void> {
    const key = `${b.run}/${b.job}`;
    if (this.baselines.has(key)) return;
    const files: { path: string; base64: string }[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
        const p = join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p, r);
        else files.push({ path: r, base64: readFileSync(p).toString("base64") });
      }
    };
    walk(b.kept, "");
    await this.o.link.ask({ op: "baseline_put", run: b.run, job: b.job, files });
    this.baselines.add(key);
  }

  /**
   * The run's model files on the runner, once per run: those it lacks, which its supervisor
   * fetches from their sources (each checked by its SHA-256). A model with no source can't reach
   * a runner of another machine, and fails the job in words.
   */
  private async sendModels(run: string): Promise<void> {
    if (this.modelsHeld.has(run)) return;
    const models = this.o.ledger.commands.modelsOf(run);
    if (models.length) {
      const have = (await this.o.link.ask({
        op: "models_have",
        sha256s: models.map((m) => m.sha256),
      })) as { missing: string[] };
      const missing = models.filter((m) => have.missing.includes(m.sha256));
      const nowhere = missing.filter((m) => !m.url);
      if (nowhere.length)
        throw new Error(
          `the model ${nowhere.map((m) => m.name).join(", ")} came with no source, so a runner of another machine can't fetch it`,
        );
      if (missing.length)
        await this.o.link.fetchModels(
          missing.map((m) => ({
            name: m.name,
            path: m.path,
            sha256: m.sha256,
            url: String(m.url),
          })),
        );
    }
    this.modelsHeld.add(run);
  }

  async measure(spec: MeasureSpec, arm: Arm, cell: string): Promise<Measured> {
    await this.sendCommit(spec.kitRepo, spec.kitCommit);
    if (spec.run) await this.sendModels(spec.run);
    const b = spec.baseline;
    if (b && "kept" in b) await this.sendBaseline(b);
    const m = (await this.o.link.ask({
      op: "measure",
      card: this.o.card,
      spec: {
        job: spec.job,
        kit_repo: spec.kitRepo,
        kit_commit: spec.kitCommit,
        ...(b
          ? { baseline: "written" in b ? { written: b.written } : { run: b.run, job: b.job } }
          : {}),
        ...(spec.uses ? { uses: [...spec.uses] } : {}),
      },
      arm: { name: arm.name, dir: arm.dir, manifest: { ...arm.manifest } },
      cell,
    })) as { run: ArmRun; throttled: number | null; implausible: string[] };
    if (m.run.kind === "ok") this.implausible.set(m.run.metrics, m.implausible);
    spec.note?.(arm.name, cell, m.run.kind === "ok" ? "ok" : `${m.run.kind}: ${m.run.reason}`);
    return { run: m.run, throttled: m.throttled ?? undefined };
  }

  async throttle(): Promise<ThrottleSample | undefined> {
    const t = (await this.o.link.ask({ op: "throttle" })) as { sample: ThrottleSample | null };
    return t.sample ?? undefined;
  }

  async baselineWork(job: number): Promise<string> {
    const r = await this.o.link.ask({ op: "baseline_work", card: this.o.card, job });
    return (r as { dir: string }).dir;
  }

  async keepBaseline(written: string, to: KeptBaseline): Promise<Sealed> {
    const r = (await this.o.link.ask({
      op: "baseline_keep",
      card: this.o.card,
      written,
      run: to.run,
      job: to.job,
    })) as Sealed & { contents?: { path: string; base64: string }[] };
    if (!r.ok) return r;
    // The core's copy, kept as a baseline job on its own runner keeps its checks' folder.
    const tmp = join(this.o.scratchDir, `baseline-${randomUUID()}`);
    try {
      mkdirSync(tmp, { recursive: true });
      for (const f of r.contents ?? []) {
        const at = resolve(tmp, f.path);
        if (!at.startsWith(resolve(tmp) + sep)) throw new Error(`not a baseline's file: ${f.path}`);
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, Buffer.from(f.base64, "base64"));
      }
      keepBaselineDir(tmp, to.dir);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    this.baselines.add(`${to.run}/${to.job}`);
    const files: BaselineFile[] = r.files;
    return { ok: true, files, bytes: r.bytes };
  }

  async remove(dir: string): Promise<void> {
    await this.o.link.ask({ op: "remove", dir });
  }

  /**
   * A lane's command on its change, on this runner (goal 206): the parent commit sent first when
   * the runner lacks it. The answer is the run's output, which never counts.
   */
  async laneRun(r: LaneRun): Promise<object> {
    await this.sendCommit(r.repo, r.parent);
    return (await this.o.link.ask({
      op: "lane_run",
      card: this.o.card,
      lane: r.lane,
      trial: r.trial,
      repo: r.repo,
      parent: r.parent,
      patch: r.patch.toString("base64"),
      command: r.command,
      ...(r.timeoutS !== undefined ? { timeout_s: r.timeoutS } : {}),
      limits: {
        rss_mib: r.limits.rssMib,
        disk_mib: r.limits.diskMib,
        ...(r.limits.processes !== undefined ? { processes: r.limits.processes } : {}),
      },
    })) as object;
  }

  /** A trial ended: its workspace on this runner goes. */
  async laneEnd(lane: string, trial: string): Promise<void> {
    await this.o.link.ask({ op: "lane_end", lane, trial });
  }
}

/** A lane's run on a runner of another machine: its change on its parent, and its command. */
export interface LaneRun {
  lane: string;
  trial: string;
  /** The mirror the parent commit is in. */
  repo: string;
  parent: string;
  /** The change on the parent, as `git diff --binary` gives it. */
  patch: Buffer;
  command: string;
  timeoutS?: number | undefined;
  limits: { rssMib: number; diskMib: number; processes?: number | undefined };
}
