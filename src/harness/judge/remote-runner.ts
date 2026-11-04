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
interface RunLink {
  ask(a: RunAsk): Promise<unknown>;
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
  /** Its kind of target and whether its roles are separated, as its process said. */
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

  constructor(o: RemoteRunnerOptions) {
    this.o = o;
    this.name = o.name;
    const ask = async <T>(what: "identify" | "ready" | "env" | "after_block" | "recover") =>
      ((await o.link.ask({ op: "driver", card: o.card, ask: what })) as { answer: T }).answer;
    this.driver = {
      type: o.info.type,
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

  async measure(spec: MeasureSpec, arm: Arm, cell: string): Promise<Measured> {
    await this.sendCommit(spec.kitRepo, spec.kitCommit);
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
}
