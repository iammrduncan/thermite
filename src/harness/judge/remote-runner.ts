import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ModelFetch,
  ModelFetchState,
  type ModelPoll,
  type RunAsk,
} from "../../core/api/harness/runs.ts";
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

/** How often the core asks a runner how its fetch of a run's model files stands (goal 213). */
const MODEL_POLL_MS = 15_000;
/** How long a fetch may go with no new byte before the core gives up on it, in words. */
const MODEL_STALL_MS = 15 * 60_000;

/**
 * A runner's fetch of a run's model files as the core last heard of it (goal 213), for the rig's
 * report: its files and bytes so far, since when, and when the core last asked.
 */
export interface FetchProgress {
  run: string;
  files: number;
  done: number;
  bytes: number;
  /** Null while a file's size is not known yet. */
  total: number | null;
  since: string;
  at: string;
}

/** How the core reaches one runner process. */
export interface RunLink {
  /** An ask, failed when no answer comes in `answerMs` (the link's own limit when not given). */
  ask(a: RunAsk, answerMs?: number): Promise<unknown>;
  /** A git bundle for one of the runner's mirrors, which must hold `commit` after. */
  sendGit(repo: string, commit: string, bundle: Buffer): Promise<void>;
  /**
   * Model files the runner's supervisor fetches from their sources and gives its process, in
   * turns (goal 213): `start` begins the fetch, `status` asks how it stands; each answers at once
   * with every file's state (ModelFetchState).
   */
  fetchModels(models: ModelFetch[], poll: ModelPoll): Promise<unknown>;
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
  /** Tests only: how often to ask how a fetch of model files stands, and when it has stalled. */
  modelPollMs?: number | undefined;
  modelStallMs?: number | undefined;
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
  /** Its fetch under way, as last heard; none once the files are there or the fetch failed. */
  private fetching: FetchProgress | undefined;
  /**
   * The files a lane's run found missing since the first, each with its bytes as last heard
   * (goal 217): one the harness took in since counts as done in what the lane is told.
   */
  private laneFetch: { run: string; bytes: Map<string, number> } | undefined;

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

  /** Its fetch of a run's model files under way, as the core last heard of it (goal 213). */
  get fetch(): FetchProgress | undefined {
    return this.fetching;
  }

  /**
   * What the core knows the runner holds, forgotten: it answers again after it was away, and may
   * be a new machine by the same name. It is sent what it lacks again.
   */
  forget(): void {
    this.sent.clear();
    this.baselines.clear();
    this.modelsHeld.clear();
    this.fetching = undefined;
    this.laneFetch = undefined;
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
    // While the judge's lease is renewed for the build (goal 213): a large model takes long.
    if (input.run) await this.sendModels(input.run);
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
   * The run's model files the runner lacks, each with its source; none once it holds them all. A
   * model with no source can't reach a runner of another machine, and fails the job in words.
   */
  private async modelsMissing(run: string): Promise<ModelFetch[]> {
    if (this.modelsHeld.has(run)) return [];
    const models = this.o.ledger.commands.modelsOf(run);
    const have = models.length
      ? ((await this.o.link.ask({
          op: "models_have",
          sha256s: models.map((m) => m.sha256),
        })) as { missing: string[] })
      : { missing: [] };
    const missing = models.filter((m) => have.missing.includes(m.sha256));
    const nowhere = missing.filter((m) => !m.url);
    if (nowhere.length)
      throw new Error(
        `the model ${nowhere.map((m) => m.name).join(", ")} came with no source, so a runner of another machine can't fetch it`,
      );
    if (!missing.length) this.modelsHeld.add(run);
    return missing.map((m) => ({
      name: m.name,
      path: m.path,
      sha256: m.sha256,
      url: String(m.url),
    }));
  }

  /**
   * One turn of the runner's fetch of a run's `files`: begun (a file under way goes on, one that
   * failed is tried again) or asked how it stands, kept for the rig's report until the files are
   * there. A file that failed fails it, in words.
   */
  private async fetchTurn(
    run: string,
    files: ModelFetch[],
    poll: ModelPoll,
    /** Files of the same fetch the harness took in before this turn, and their bytes. */
    before: { files: number; bytes: number } = { files: 0, bytes: 0 },
  ): Promise<{ done: boolean; words: string; got: number; states: ModelFetchState[] }> {
    let states: ModelFetchState[];
    try {
      states = ModelFetchState.array().parse(await this.o.link.fetchModels(files, poll));
    } catch (err) {
      this.fetching = undefined;
      throw err;
    }
    const nameOf = (sha: string) => files.find((f) => f.sha256 === sha)?.name ?? sha.slice(0, 12);
    const failed = states.find((x) => x.state === "failed");
    if (failed) {
      this.fetching = undefined;
      throw new Error(
        `runner ${this.name} could not fetch the model file ${nameOf(failed.sha256)}: ${failed.error ?? "no reason given"}`,
      );
    }
    const got = states.reduce((n, x) => n + x.bytes, 0);
    const total = states.every((x) => x.total !== null)
      ? states.reduce((n, x) => n + (x.total ?? 0), 0)
      : null;
    const done = states.filter((x) => x.state === "done").length;
    const tried = states.find((x) => x.state !== "done" && x.error);
    const words = `${done + before.files} of ${files.length + before.files} files, ${gib(got + before.bytes)}${total !== null ? ` of ${gib(total + before.bytes)}` : ""} GiB${tried ? `; the last try of ${nameOf(tried.sha256)} failed: ${tried.error}` : ""}`;
    const all = states.length >= files.length && done === states.length;
    const at = new Date().toISOString();
    this.fetching = all
      ? undefined
      : {
          run,
          files: files.length + before.files,
          done: done + before.files,
          bytes: got + before.bytes,
          total: total !== null ? total + before.bytes : null,
          since: this.fetching?.run === run ? this.fetching.since : at,
          at,
        };
    return { done: all, words, got, states };
  }

  /**
   * The run's model files on the runner, once per run (goal 213): those it lacks, which its
   * supervisor fetches from their sources one after another, each checked by its SHA-256. The core
   * waits as long as bytes keep coming, however long that is, and fails in words when a file
   * fails or nothing came for MODEL_STALL_MS.
   */
  private async sendModels(run: string): Promise<void> {
    const files = await this.modelsMissing(run);
    if (!files.length) return;
    const pollMs = this.o.modelPollMs ?? MODEL_POLL_MS;
    const stallMs = this.o.modelStallMs ?? MODEL_STALL_MS;
    let turn = await this.fetchTurn(run, files, "start");
    let seen = turn.got;
    let since = Date.now();
    while (!turn.done) {
      if (Date.now() - since >= stallMs) {
        this.fetching = undefined;
        throw new Error(
          `runner ${this.name}'s fetch of the model files stopped at ${turn.words}: nothing came for ${Math.round(stallMs / 60_000)} minutes`,
        );
      }
      await sleep(pollMs);
      turn = await this.fetchTurn(run, files, "status");
      if (turn.got > seen) {
        seen = turn.got;
        since = Date.now();
      }
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
    // The run's model files first (goal 213), never waited for here: a lane is told they are on
    // their way, and its next run finds them.
    const run = this.o.ledger.trials.get(r.trial)?.run;
    const files = run ? await this.modelsMissing(run) : [];
    if (run && files.length) {
      // Each run asks only for the files still missing; the lane is told how the whole fetch
      // stands, with those the harness took in since its first run counted as done (goal 217).
      if (this.laneFetch?.run !== run) this.laneFetch = { run, bytes: new Map() };
      const seen = this.laneFetch.bytes;
      for (const f of files) if (!seen.has(f.sha256)) seen.set(f.sha256, 0);
      const landed = [...seen].filter(([sha]) => !files.some((f) => f.sha256 === sha));
      const turn = await this.fetchTurn(run, files, "start", {
        files: landed.length,
        bytes: landed.reduce((n, [, b]) => n + b, 0),
      });
      for (const x of turn.states) seen.set(x.sha256, x.total ?? x.bytes);
      if (!turn.done)
        return {
          ran: false,
          reason: `the run's model files are on their way to this machine (${turn.words}); run again in a few minutes`,
        };
      this.modelsHeld.add(run);
      this.laneFetch = undefined;
    }
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

/** Bytes as GiB, to one place. */
const gib = (n: number) => (n / 2 ** 30).toFixed(1);

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
