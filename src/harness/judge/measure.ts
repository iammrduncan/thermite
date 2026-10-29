import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cellParams, cellTimeoutS, type Kit, paramsText } from "../../core/kit.ts";
import { type Role, type Runner, type RunOutcome, walk } from "../broker/index.ts";
import type { BuildManifest, BuildStore } from "./builds.ts";
import { expandArgv } from "./kits.ts";
import { clipReason } from "./reasons.ts";

/**
 * One timed run of one arm on one cell. The run user executes the arm's verified build with
 * the cell's parameters, beside the kit's driver where the kit has one (run.driver, as the
 * driver's user); the judge measures the wall time around the run, and the kit's check, as the
 * checker's user, reads the outputs. The score is computed here from the judge's own clock.
 */

export interface Arm {
  /** baseline: a hill climb's starting point, measured on its own (goal 115). */
  name: "champion" | "candidate" | "retained" | "twin" | "baseline";
  dir: string;
  manifest: BuildManifest;
}

export interface CheckResult {
  pass: boolean;
  reasons: string[];
  details: Record<string, unknown>;
}

export type ArmRun =
  | {
      kind: "ok";
      wallMs: number;
      metrics: Record<string, number>;
      check: CheckResult;
      outcome: RunOutcome;
    }
  /** The candidate process failed: crash, non-zero exit, or killed for a limit. */
  | { kind: "crash"; failure: CrashFailure; reason: string; outcome: RunOutcome }
  /** The run completed but its outputs failed the kit's check. */
  | {
      kind: "invalid";
      failure: InvalidFailure;
      reason: string;
      check: CheckResult;
      outcome: RunOutcome;
    };

/**
 * How a run failed, as the judge saw it, apart from its reason's text: a held-out cell's record
 * names only this (goal 082). A crash: stopped for time, memory or disk, or it exited with an
 * error. Invalid: its outputs were refused, the kit's check failed, or a metric the check reports
 * was not a number above zero.
 */
export type CrashFailure = "timeout" | "memory" | "disk" | "exit";
export type InvalidFailure = "outputs" | "check" | "metric";

export interface MeasureContext {
  runner: Runner;
  store: BuildStore;
  kit: Kit;
  kitDir: string;
  runsDir: string;
  /** The imported models (`<sha256>` files, read-only): `{models:<sha256>}` in run and check. */
  modelsDir: string;
  /** Tells the live view how a run went (never a measurement; held-out cells are not named). */
  note?: ((arm: string, cell: string, outcome: string) => void) | undefined;
  /** The user that times runs on this executor's judge card: run, or run-1 to run-7. */
  runRole?: Role | undefined;
  /** The user of the kit's check on this card: checker, or checker-1 to checker-7. */
  checkerRole?: Role | undefined;
  /** The user of the kit's driver on this card: driver, or driver-1 to driver-7. */
  driverRole?: Role | undefined;
  /**
   * A hill climb's baseline folder (goal 115): the kit's check gets it as THERMITE_BASELINE_DIR,
   * writable during the baseline job (a folder the job hands the checker) and read-only (sealed)
   * in every later job of the run. The kit's run command and driver never get it.
   */
  baselineDir?: string | undefined;
}

/**
 * The outputs a check may read: regular files and directories only, each file with one link,
 * within depth and count caps. A symlink or hard link could point the judge's check at kit
 * references or other private files.
 */
export function outputProblems(dir: string, maxEntries = 10_000, maxDepth = 32): string[] {
  const problems: string[] = [];
  let entries = 0;
  const stack: [string, number][] = [[dir, 0]];
  while (stack.length && problems.length < 5) {
    const [p, depth] = stack.pop() as [string, number];
    const st = lstatSync(p);
    if (++entries > maxEntries) return [`more than ${maxEntries} output entries`];
    if (st.isDirectory()) {
      if (depth >= maxDepth) problems.push(`output tree deeper than ${maxDepth}`);
      else for (const e of readdirSync(p)) stack.push([join(p, e), depth + 1]);
    } else if (!st.isFile()) {
      problems.push(`not a regular file: ${p.slice(dir.length + 1)}`);
    } else if (st.nlink > 1) {
      problems.push(`hard link: ${p.slice(dir.length + 1)}`);
    }
  }
  return problems;
}

/**
 * Copies the kit's `run.copy` paths into `dest` for one run: regular files and directories
 * only, owned by the judge and read-only, so the run user can read them but not change them.
 * A link is refused, because it could reach the kit's references.
 */
export function copyForRun(kitDir: string, paths: readonly string[], dest: string): void {
  const copy = (from: string, to: string, rel: string) => {
    const st = lstatSync(from);
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const e of readdirSync(from)) copy(join(from, e), join(to, e), `${rel}/${e}`);
    } else if (st.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, st.mode & 0o111 ? 0o555 : 0o444);
    } else {
      throw new Error(`kit run.copy: not a regular file or directory: ${rel}`);
    }
  };
  mkdirSync(dest, { recursive: true });
  for (const rel of paths) {
    const from = join(kitDir, rel);
    if (!existsSync(from)) throw new Error(`kit run.copy: ${rel} is not in the kit`);
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    copy(from, join(dest, rel), rel);
  }
  walk(dest, (p, isDir) => {
    if (isDir) chmodSync(p, 0o555);
  });
}

export async function runArm(ctx: MeasureContext, arm: Arm, cell: string): Promise<ArmRun> {
  const r = await runArmInner(ctx, arm, cell);
  ctx.note?.(arm.name, cell, r.kind === "ok" ? "ok" : `${r.kind}: ${r.reason}`);
  return r;
}

async function runArmInner(ctx: MeasureContext, arm: Arm, cell: string): Promise<ArmRun> {
  const params = cellParams(ctx.kit, cell);
  if (!params) throw new Error(`kit ${ctx.kit.name} has no cell ${cell}`);
  // The build must be exactly what was verified at build time.
  const tampered = ctx.store.verify(arm.dir, arm.manifest);
  if (tampered.length) throw new Error(`build store tampered: ${arm.manifest.key} ${tampered}`);

  // <run>/ (0711, unguessable name) holds <run>/work/, handed to the run user with a copy of the
  // parameters and its out/; with a driver, <run>/drive/, handed to the driver's user with its
  // own copy and the out/; <run>/kit/, the run's read-only copy of the kit's run.copy paths,
  // which stays the judge's; and then <run>/check/, handed to the checker's user with the judge's
  // own copy of the parameters and the outputs, taken from the run's folder.
  const dir = join(ctx.runsDir, randomUUID());
  const work = join(dir, "work");
  const driver = ctx.kit.run.driver;
  const drive = join(dir, "drive");
  const writer = driver ? drive : work;
  const out = join(writer, "out");
  const kit = join(dir, "kit");
  const checkDir = join(dir, "check");
  mkdirSync(work, { recursive: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(checkDir);
  chmodSync(dir, 0o711);
  const text = paramsText(params);
  const json = `${JSON.stringify(params)}\n`;
  for (const at of [work, checkDir, ...(driver ? [drive] : [])]) {
    writeFileSync(join(at, "params.txt"), text, { mode: 0o600 });
    writeFileSync(join(at, "params.json"), json, { mode: 0o600 });
  }
  try {
    if (ctx.kit.run.copy.length) copyForRun(ctx.kitDir, ctx.kit.run.copy, kit);
    const vars = (at: string) => ({
      build: arm.dir,
      params: join(at, "params.txt"),
      params_json: join(at, "params.json"),
      out,
      kit: ctx.kit.run.copy.length ? kit : "/nonexistent",
      models: ctx.modelsDir,
    });
    // The cell's own limit when it sets one, else the kit's; the driver's run has the same.
    const limits = (at: string) => ({
      cwd: at,
      env: {},
      timeoutMs: cellTimeoutS(ctx.kit, cell) * 1000,
      rssLimitBytes: ctx.kit.run.rss_mib * 1024 * 1024,
      disk: { path: at, limitBytes: ctx.kit.run.disk_mib * 1024 * 1024 },
    });
    const runRole = ctx.runRole ?? "run";
    await ctx.runner.handOver(work, runRole);
    const candidate = {
      role: runRole,
      argv: expandArgv(ctx.kit.run.command, vars(work)),
      ...limits(work),
    };
    let outcome: RunOutcome;
    if (driver) {
      const driverRole = ctx.driverRole ?? "driver";
      await ctx.runner.handOver(drive, driverRole);
      const pair = await ctx.runner.runPair(
        { role: driverRole, argv: expandArgv(driver, vars(drive)), ...limits(drive) },
        candidate,
      );
      await ctx.runner.reclaim(drive);
      outcome = pairOutcome(pair.driver, pair.candidate);
    } else outcome = await ctx.runner.run(candidate);
    await ctx.runner.reclaim(work);
    if (outcome.killedFor) {
      return {
        kind: "crash",
        failure: outcome.killedFor,
        reason: `killed: ${outcome.killedFor}`,
        outcome,
      };
    }
    if (outcome.exitCode !== 0) {
      return {
        kind: "crash",
        failure: "exit",
        reason: clipReason(`exit ${outcome.exitCode ?? outcome.signal}: ${outcome.stderr}`),
        outcome,
      };
    }
    const problems = existsSync(out) ? outputProblems(out) : ["no output directory"];
    if (problems.length) {
      const check = { pass: false, reasons: problems, details: {} };
      return {
        kind: "invalid",
        failure: "outputs",
        reason: clipReason(`outputs refused: ${problems.join("; ")}`),
        check,
        outcome,
      };
    }

    // The outputs go to the check's folder, which the checker's user alone may then enter.
    renameSync(out, join(checkDir, "out"));
    const checkerRole = ctx.checkerRole ?? "checker";
    await ctx.runner.handOver(checkDir, checkerRole);
    const check = await runCheck(ctx, checkerRole, checkDir, {
      build: arm.dir,
      params: join(checkDir, "params.txt"),
      params_json: join(checkDir, "params.json"),
      out: join(checkDir, "out"),
      kit: ctx.kitDir,
      models: ctx.modelsDir,
    });
    if (!check.pass) {
      return {
        kind: "invalid",
        failure: "check",
        reason: clipReason(check.reasons.join("; ")) || "check failed",
        check,
        outcome,
      };
    }
    const seconds = outcome.wallMs / 1000;
    const metrics: Record<string, number> = {};
    for (const [name, m] of Object.entries(ctx.kit.metrics)) {
      if ("from" in m && m.from === "check") {
        // The judge's check worked it out from the outputs; it must be a number above zero.
        const v = Number(check.details[m.field]);
        if (!Number.isFinite(v) || v <= 0) {
          return {
            kind: "invalid",
            failure: "metric",
            reason: `the check reported no ${m.field} above zero (got ${JSON.stringify(check.details[m.field] ?? null)})`,
            check,
            outcome,
          };
        }
        metrics[name] = v;
        continue;
      }
      if (!(seconds > 0)) throw new Error(`kit metric ${name}: bad time ${seconds}`);
      if ("from" in m) {
        metrics[name] = seconds;
        continue;
      }
      const amount = Number(params[m.work]);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`kit metric ${name}: bad work ${params[m.work]} or time ${seconds}`);
      }
      metrics[name] = amount / seconds;
    }
    return { kind: "ok", wallMs: outcome.wallMs, metrics, check, outcome };
  } finally {
    await ctx.runner.remove(dir).catch(() => rmSync(dir, { recursive: true, force: true }));
  }
}

/**
 * One run of a kit's driver and the candidate, as one: the driver's time and how it ended, unless
 * the candidate was stopped for a limit, which ends the run as a crash of its own.
 */
function pairOutcome(driver: RunOutcome, candidate: RunOutcome): RunOutcome {
  if (candidate.killedFor && !driver.killedFor)
    return { ...driver, killedFor: candidate.killedFor, stderr: candidate.stderr };
  return {
    ...driver,
    stderr: `${driver.stderr}${candidate.stderr ? `\ncandidate: ${candidate.stderr}` : ""}`,
  };
}

/**
 * The kit's check, as the checker's user, in its own folder (`cwd`): it reads the outputs, the
 * parameters, the kit, the build and the models, and writes only its folder and, in a baseline
 * job, the baseline's.
 */
async function runCheck(
  ctx: MeasureContext,
  role: Role,
  cwd: string,
  vars: Record<string, string>,
): Promise<CheckResult> {
  const r = await ctx.runner.run({
    role,
    argv: expandArgv(ctx.kit.check.command, vars),
    cwd,
    env: ctx.baselineDir ? { THERMITE_BASELINE_DIR: ctx.baselineDir } : {},
    timeoutMs: ctx.kit.check.timeout_s * 1000,
  });
  const last = r.stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(last) as { pass?: unknown; reasons?: unknown };
    const { pass, reasons, ...details } = parsed;
    return {
      pass: pass === true,
      reasons: Array.isArray(reasons) ? reasons.map(String) : [],
      details,
    };
  } catch {
    return {
      pass: false,
      reasons: [clipReason(`check produced no result (exit ${r.exitCode}): ${r.stderr}`)],
      details: {},
    };
  }
}
