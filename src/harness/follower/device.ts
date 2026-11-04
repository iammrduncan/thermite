import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { DeviceAsk } from "../../core/api/harness/device.ts";
import type { Runner } from "../broker/index.ts";
import { fetchBundle, hasCommit, initMirror, refTips } from "../git.ts";
import { importFile } from "../imports.ts";
import {
  type Arm,
  baselineDir,
  exportKit,
  keepBaselineDir,
  LocalDevice,
  loadKit,
  prepareBaselineDir,
  removeBaselineDir,
} from "../judge/index.ts";
import type { Ledger } from "../ledger/index.ts";
import type { TargetDriver } from "../targets/index.ts";

/**
 * A follower's judge GPUs (goal 205): it answers its leader's asks (core/api/harness/device.ts)
 * with a LocalDevice for each card, as the leader's judge would on a card of its own. It keeps
 * the commits it was sent in mirrors of its own, the kits it exported, its builds and the runs'
 * kept baselines, and refuses any folder it did not name itself.
 */

/** Where the leader's bundles go in a follower's mirror: each sent ref under it. */
const SENT = "refs/thermite/imports/leader";

interface DeviceServerOptions {
  runner: Runner;
  /** One driver for each judge card, in order. */
  drivers: TargetDriver[];
  paths: { stateDir: string; scratchDir: string; inboxDir: string };
  /** The follower's own ledger: its builds. */
  ledger: Ledger;
}

export class DeviceServer {
  private readonly o: DeviceServerOptions;
  private readonly cards: LocalDevice[];

  constructor(o: DeviceServerOptions) {
    if (!o.drivers.length) throw new Error("a follower's device needs a judge card");
    this.o = o;
    this.cards = o.drivers.map(
      (driver, index) =>
        new LocalDevice({ runner: o.runner, driver, paths: o.paths, ledger: o.ledger, index }),
    );
  }

  /** A mirror of the follower's, by its name. */
  private mirror(repo: string): string {
    return join(this.o.paths.stateDir, "git", `${repo}.git`);
  }

  private card(i: number): LocalDevice {
    const c = this.cards[i];
    if (!c) throw new DeviceRefusal(`this follower has no judge card ${i}`);
    return c;
  }

  /** A folder under `top` the follower named, resolved; anything else is refused. */
  private within(top: string, p: string, what: string): string {
    const full = resolve(p);
    if (!full.startsWith(resolve(top) + sep)) throw new DeviceRefusal(`not a ${what}: ${p}`);
    return full;
  }

  private runFolder(p: string): string {
    return this.within(join(this.o.paths.scratchDir, "runs"), p, "run's folder of this follower");
  }

  /** The kit at a commit, exported once from the follower's mirror of it. */
  private async kit(repo: string, commit: string) {
    const dir = await exportKit(this.o.paths.stateDir, this.mirror(repo), commit);
    return { kit: loadKit(dir), dir };
  }

  /** Answers one ask of the leader. */
  async ask(a: DeviceAsk): Promise<object> {
    switch (a.op) {
      case "info":
        return {
          type: this.card(0).driver.type,
          separated: this.o.runner.separated,
          cards: this.cards.length,
        };
      case "git_has": {
        const m = this.mirror(a.repo);
        const has = existsSync(join(m, "HEAD")) && (await hasCommit(m, a.commit));
        return { has, heads: has ? [] : await refTips(m, SENT) };
      }
      case "build": {
        const k = await this.kit(a.kit_repo, a.kit_commit);
        return this.card(a.card).build({
          repo: a.repo,
          mirror: this.mirror(a.repo),
          commit: a.commit,
          kit: k.kit,
          kitDir: k.dir,
          kitRepo: a.kit_repo,
          kitCommit: a.kit_commit,
          actor: a.actor,
        });
      }
      case "measure": {
        const card = this.card(a.card);
        const k = await this.kit(a.spec.kit_repo, a.spec.kit_commit);
        const dir = this.within(card.store.storeDir, a.arm.dir, "build of this follower");
        const b = a.spec.baseline;
        let baseline: { written: string } | { kept: string; run: string; job: number } | undefined;
        if (b && "written" in b) baseline = { written: this.runFolder(b.written) };
        else if (b) {
          const kept = baselineDir(this.o.paths.stateDir, b.run, b.job);
          if (!existsSync(kept)) throw new DeviceRefusal(`no kept baseline of ${b.run} here`);
          baseline = { kept, run: b.run, job: b.job };
        }
        const m = await card.measure(
          {
            job: a.spec.job,
            kit: k.kit,
            kitDir: k.dir,
            kitRepo: a.spec.kit_repo,
            kitCommit: a.spec.kit_commit,
            ...(baseline ? { baseline } : {}),
            ...(a.spec.uses ? { uses: new Set(a.spec.uses) } : {}),
          },
          { name: a.arm.name, dir, manifest: a.arm.manifest as unknown as Arm["manifest"] },
          a.cell,
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
        return { sample: (await this.card(0).throttle()) ?? null };
      case "baseline_work":
        return { dir: await this.card(a.card).baselineWork(a.job) };
      case "baseline_keep": {
        const written = this.runFolder(a.written);
        const to = prepareBaselineDir(this.o.paths.stateDir, a.run, a.job);
        const sealed = await this.card(0).keepBaseline(written, {
          dir: to,
          run: a.run,
          job: a.job,
        });
        if (!sealed.ok) {
          removeBaselineDir(to);
          return sealed;
        }
        const files = sealed.files.map((f) => ({
          path: f.path,
          base64: readFileSync(join(to, f.path)).toString("base64"),
        }));
        return { ...sealed, contents: files };
      }
      case "baseline_put": {
        if (existsSync(baselineDir(this.o.paths.stateDir, a.run, a.job))) return { ok: true };
        // Written in a folder of its own, then kept as a baseline job keeps its checks' folder.
        const tmp = join(this.o.paths.scratchDir, "runs", `put-${randomUUID()}`);
        try {
          for (const f of a.files) {
            const at = this.within(tmp, join(tmp, f.path), "file of the baseline");
            mkdirSync(dirname(at), { recursive: true });
            writeFileSync(at, Buffer.from(f.base64, "base64"));
          }
          mkdirSync(tmp, { recursive: true });
          keepBaselineDir(tmp, prepareBaselineDir(this.o.paths.stateDir, a.run, a.job));
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
        return { ok: true };
      }
      case "folder": {
        const dir = this.runFolder(a.dir);
        if (a.act === "reclaim") await this.card(0).reclaim(dir);
        else await this.card(0).remove(dir);
        return { ok: true };
      }
      case "models_have": {
        const models = join(this.o.paths.stateDir, "models");
        return { missing: a.sha256s.filter((sha) => !existsSync(join(models, sha))) };
      }
      case "models_take": {
        // Each checked against its SHA-256 as it is copied in, as an assignment's models are.
        for (const m of a.models)
          await importFile({
            inboxDir: this.o.paths.inboxDir,
            rel: m.path,
            expectedSha256: m.sha256,
            storeDir: join(this.o.paths.stateDir, "models"),
          });
        return { ok: true };
      }
    }
  }

  /** Takes a bundle of commits the leader sent for one mirror; `commit` must be in it. */
  async takeGit(repo: string, commit: string, bundle: Buffer): Promise<void> {
    const m = this.mirror(repo);
    await initMirror(m);
    const file = join(this.o.paths.scratchDir, `bundle-${randomUUID()}`);
    writeFileSync(file, bundle, { mode: 0o600 });
    try {
      await fetchBundle(m, file, "leader", commit);
    } finally {
      rmSync(file, { force: true });
    }
  }
}

/** An ask the follower refuses: a card it lacks, or a folder it did not name. */
export class DeviceRefusal extends Error {}
