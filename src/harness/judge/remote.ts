import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { DeviceAsk } from "../../core/api/harness/device.ts";
import { bundleOf } from "../git.ts";
import type { Ledger } from "../ledger/index.ts";
import type { Readiness, TargetDriver, TargetIdentity, ThrottleSample } from "../targets/index.ts";
import { type BaselineFile, keepBaselineDir } from "./baseline.ts";
import type { BuildResult } from "./builds.ts";
import type {
  DeviceBuild,
  JudgeDevice,
  KeptBaseline,
  Measured,
  MeasureSpec,
  Sealed,
} from "./device.ts";
import type { Arm, ArmRun } from "./measure.ts";

/**
 * A judge GPU of a follower (goal 205), as the leader's judge uses it: each of the device's steps
 * is an ask of the follower (core/api/harness/device.ts), carried by the link, which is the
 * leader's supervisor and the bus. Before a build it sends the commits the follower lacks, as a
 * git bundle; before a run on a run's kept baseline, that baseline's files. The leader keeps the
 * builds' records and every baseline's files, as it does for a card of its own.
 */

/** How the leader reaches one follower. */
interface DeviceLink {
  ask(a: DeviceAsk): Promise<unknown>;
  /** A git bundle for one of the follower's mirrors, which must hold `commit` after. */
  sendGit(repo: string, commit: string, bundle: Buffer): Promise<void>;
}

/** What the leader knows of the follower's device: from its `info` answer. */
interface FollowerInfo {
  type: string;
  separated: boolean;
}

interface RemoteDeviceOptions {
  link: DeviceLink;
  /** The judge card of the follower's this device is. */
  card: number;
  info: FollowerInfo;
  ledger: Ledger;
  /** The leader's mirror of a repository, by its name. */
  mirrorFor: (repo: string) => string;
  scratchDir: string;
}

export class RemoteDevice implements JudgeDevice {
  readonly driver: TargetDriver;
  private readonly o: RemoteDeviceOptions;
  /** Commits the follower has, as `<repo>@<commit>`. */
  private readonly sent = new Set<string>();
  /** Runs' kept baselines the follower has, as `<run>/<job>`. */
  private readonly baselines = new Set<string>();
  /** The follower's word on each run's values (a driver's plausibility), by the values. */
  private readonly implausible = new WeakMap<object, string[]>();

  constructor(o: RemoteDeviceOptions) {
    this.o = o;
    const ask = async <T>(what: "identify" | "ready" | "env" | "after_block" | "recover") =>
      ((await this.ask({ op: "driver", card: o.card, ask: what })) as { answer: T }).answer;
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

  private async ask(a: DeviceAsk): Promise<Record<string, unknown>> {
    return (await this.o.link.ask(a)) as Record<string, unknown>;
  }

  /** Sends the follower a commit it lacks, with what it needs, as a git bundle. */
  private async sendCommit(repo: string, commit: string): Promise<void> {
    const key = `${repo}@${commit}`;
    if (this.sent.has(key)) return;
    const has = (await this.ask({ op: "git_has", repo, commit })) as {
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

  async build(input: DeviceBuild): Promise<BuildResult> {
    await this.sendCommit(input.kitRepo, input.kitCommit);
    await this.sendCommit(input.repo, input.commit);
    const r = (await this.ask({
      op: "build",
      card: this.o.card,
      repo: input.repo,
      commit: input.commit,
      kit_repo: input.kitRepo,
      kit_commit: input.kitCommit,
      actor: input.actor,
    })) as BuildResult;
    // The build's record is the leader's too, as a build on its own card is.
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

  /** Sends the follower a run's kept baseline from the leader's copy, once. */
  private async sendBaseline(b: { kept: string; run: string; job: number }): Promise<void> {
    const key = `${b.run}/${b.job}`;
    if (this.baselines.has(key)) return;
    const files: { path: string; base64: string }[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirOf(dir)) {
        const p = join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p, r);
        else files.push({ path: r, base64: readFileSync(p).toString("base64") });
      }
    };
    walk(b.kept, "");
    await this.ask({ op: "baseline_put", run: b.run, job: b.job, files });
    this.baselines.add(key);
  }

  async measure(spec: MeasureSpec, arm: Arm, cell: string): Promise<Measured> {
    await this.sendCommit(spec.kitRepo, spec.kitCommit);
    const b = spec.baseline;
    if (b && "kept" in b) await this.sendBaseline(b);
    const m = (await this.ask({
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
    const t = (await this.ask({ op: "throttle" })) as { sample: ThrottleSample | null };
    return t.sample ?? undefined;
  }

  async baselineWork(job: number): Promise<string> {
    return ((await this.ask({ op: "baseline_work", card: this.o.card, job })) as { dir: string })
      .dir;
  }

  async keepBaseline(written: string, kept: KeptBaseline): Promise<Sealed> {
    const r = (await this.ask({
      op: "baseline_keep",
      written,
      run: kept.run,
      job: kept.job,
    })) as Sealed & { contents?: { path: string; base64: string }[] };
    if (!r.ok) return r;
    // The leader's copy, kept as a baseline job on its own card keeps its checks' folder.
    const tmp = join(this.o.scratchDir, `baseline-${randomUUID()}`);
    try {
      mkdirSync(tmp, { recursive: true });
      for (const f of r.contents ?? []) {
        const at = resolve(tmp, f.path);
        if (!at.startsWith(resolve(tmp) + sep)) throw new Error(`not a baseline's file: ${f.path}`);
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, Buffer.from(f.base64, "base64"));
      }
      keepBaselineDir(tmp, kept.dir);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    this.baselines.add(`${kept.run}/${kept.job}`);
    const files: BaselineFile[] = r.files;
    return { ok: true, files, bytes: r.bytes };
  }

  async reclaim(dir: string): Promise<void> {
    await this.ask({ op: "folder", act: "reclaim", dir });
  }

  async remove(dir: string): Promise<void> {
    await this.ask({ op: "folder", act: "remove", dir });
  }
}

/** A folder's entries, none when it is gone. */
function readdirOf(dir: string) {
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
}
