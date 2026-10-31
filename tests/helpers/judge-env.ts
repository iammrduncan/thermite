import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type CommandKind, generateSigningKeys, signEnvelope } from "../../src/core/commands.ts";
import { parseContract } from "../../src/core/contract.ts";
import {
  runSupervised,
  type SupervisedResult,
  type SupervisedRun,
} from "../../src/harness/broker/process.ts";
import { LocalRunner, type RunOutcome, type RunRequest } from "../../src/harness/broker/runner.ts";
import { Judge, type PromotionPolicy } from "../../src/harness/judge/judge.ts";
import { Ledger } from "../../src/harness/ledger/index.ts";
import { HarnessService } from "../../src/harness/service/index.ts";
import { CpuDriver } from "../../src/harness/targets/cpu.ts";

/**
 * A throwaway harness with a small Node-based project and kit, for judge tests that run on any
 * machine (no C toolchain, no root). The seed kernel does pointless extra work, so a candidate
 * that removes it is clearly faster.
 */

export const SEED_KERNEL = `// The kernel: sum of i % 7 over [0, n). The seed also idles for a time proportional to n,
// a stand-in for wasted work that, unlike a CPU loop, a busy test machine does not stretch: a
// clear win stays clearly measurable when tests share the machine.
export function work(n) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n / 50000);
  let s = 0;
  for (let i = 0; i < n; i++) s += i % 7;
  return s;
}
`;

export const FAST_KERNEL = `export function work(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += i % 7;
  return s;
}
`;

/** FAST_KERNEL in other words: a second change with the same effect. */
export const FAST_KERNEL_RESTATED = `${FAST_KERNEL}// same idea, restated\n`;

export const WRONG_KERNEL = `export function work(n) {
  return n * 3;
}
`;

export const CRASH_KERNEL = `export function work() {
  process.exit(3);
}
`;

const RUN = `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { work } from "./work.mjs";
const [params, out] = process.argv.slice(2);
const p = JSON.parse(readFileSync(params, "utf8"));
writeFileSync(join(out, "result.json"), JSON.stringify({ value: work(p.n) }));
`;

/** A run driver kept in the kit and copied into each run (`run.copy`), not built in. */
const DRIVE = `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [kernel, params, out] = process.argv.slice(2);
const { work } = await import(pathToFileURL(kernel).href);
const p = JSON.parse(readFileSync(params, "utf8"));
writeFileSync(join(out, "result.json"), JSON.stringify({ value: work(p.n) }));
`;

const CHECK = `import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [params, out] = process.argv.slice(2);
const p = JSON.parse(readFileSync(params, "utf8"));
// The sum of i % 7 over [0, n): 21 for each whole 7, then 0 + 1 + ... + (n % 7 - 1).
const expected = Math.floor(p.n / 7) * 21 + ((p.n % 7) * ((p.n % 7) - 1)) / 2;
const f = join(out, "result.json");
const got = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).value : null;
const reasons = got === expected ? [] : ["wrong result " + got + ", expected " + expected];
process.stdout.write(JSON.stringify({ pass: reasons.length === 0, reasons, value: got }) + "\\n");
`;

const KIT = {
  schema_version: 1,
  name: "js-sum",
  target: "cpu",
  build: {
    copy: ["bench"],
    command: ["sh", "-c", "mkdir -p out && cp src/kernel/work.mjs .kit/bench/run.mjs out/"],
    outputs: ["out/work.mjs", "out/run.mjs"],
    timeout_s: 30,
  },
  cells: {
    small: { n: 20000000, work: 20000000 },
    held: { n: 15000000, work: 15000000 },
    big: { n: 100000000, work: 100000000 },
  },
  run: {
    command: ["node", "{build:out/run.mjs}", "{params_json}", "{out}"],
    timeout_s: 30,
    rss_mib: 512,
  },
  metrics: { ops_per_s: { unit: "op/s", work: "work" } },
  verifiers: { correctness: { cells: ["small"] } },
  check: { command: ["node", "{kit:check.mjs}", "{params_json}", "{out}"], timeout_s: 30 },
};

/** The same kit with its run driver in `run.copy` instead of the build. */
const RUN_COPY_KIT = {
  ...KIT,
  build: {
    ...KIT.build,
    copy: [],
    command: ["sh", "-c", "mkdir -p out && cp src/kernel/work.mjs out/"],
    outputs: ["out/work.mjs"],
  },
  run: {
    ...KIT.run,
    copy: ["bench/drive.mjs"],
    command: ["node", "{kit:bench/drive.mjs}", "{build:out/work.mjs}", "{params_json}", "{out}"],
  },
};

/** A file's text, or undefined when it cannot be read. */
const readText = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

/** A finished process's result, with its wall time and 1% of noise. */
const outcome = (exitCode: number, ms: number, stdout = ""): SupervisedResult => ({
  exitCode,
  signal: null,
  killedFor: null,
  wallMs: ms * (1 + (Math.random() - 0.5) * 0.02),
  peakRssBytes: 40 * 1024 * 1024,
  peakDiskBytes: 0,
  peakEntries: 0,
  leftovers: 0,
  swept: [],
  stdout,
  stderr: "",
});

/** The sum of i % 7 over [0, n), as every correct kernel returns it. */
const sum7 = (n: number) => Math.floor(n / 7) * 21 + ((n % 7) * ((n % 7) - 1)) / 2;

/**
 * Each stock kernel's result and wall time in milliseconds, as a model of the real run: Node
 * starts in 30 ms, a loop takes 1 ns an element, and the seed idles n / 50,000 ms, as
 * SEED_KERNEL does. Null exit code 3: the crash kernel.
 */
const KERNELS = new Map<string, (n: number) => { value: number | null; ms: number }>([
  [SEED_KERNEL, (n) => ({ value: sum7(n), ms: 30 + n / 1e6 + n / 50_000 })],
  [FAST_KERNEL, (n) => ({ value: sum7(n), ms: 30 + n / 1e6 })],
  [FAST_KERNEL_RESTATED, (n) => ({ value: sum7(n), ms: 30 + n / 1e6 })],
  [WRONG_KERNEL, (n) => ({ value: n * 3, ms: 31 })],
  [CRASH_KERNEL, () => ({ value: null, ms: 30 })],
]);

/**
 * The judge's runner for tests that are not about the judge (the owner, 2026-10-24: faster
 * iterations): they need judged attempts, not the judge's timing. A run of the stock kit's
 * driver on a stock kernel is answered in this process: the result file the run would write, and
 * a wall time from KERNELS with 1% of noise, so a judged attempt takes milliseconds, not seconds.
 * Every other run (a build, another kernel, a kit's own run script) runs for real. The judge's
 * statistics, verdicts and records are the real judge's.
 */
class StandInRunner extends LocalRunner {
  override async run(req: RunRequest): Promise<RunOutcome> {
    return this.answer(req) ?? super.run(req);
  }

  /**
   * The judge's check of a run (Runner.check): the stock kit's check.mjs is answered here, as it
   * would answer; any other check runs for real.
   */
  check = async (spec: SupervisedRun): Promise<SupervisedResult> => {
    const [exe, script, params, out] = spec.argv;
    if (exe !== "node" || !script || !params || !out || readText(script) !== CHECK)
      return runSupervised(spec);
    const p = JSON.parse(readText(params) ?? "null") as { n?: unknown } | null;
    const result = readText(join(out, "result.json"));
    if (typeof p?.n !== "number") return runSupervised(spec);
    const got = result === undefined ? null : (JSON.parse(result) as { value?: unknown }).value;
    const expected = sum7(p.n);
    const reasons = got === expected ? [] : [`wrong result ${got}, expected ${expected}`];
    return outcome(0, 40, `${JSON.stringify({ pass: !reasons.length, reasons, value: got })}\n`);
  };

  /** A stock run's outcome, or undefined for a run this runner does not know. */
  private answer(req: RunRequest): RunOutcome | undefined {
    const at = (p: string | undefined) => (p === undefined ? "" : resolve(req.cwd, p));
    const read = readText;
    const [exe, script, ...rest] = req.argv;
    if (exe !== "node" || !script) return undefined;
    let kernel: string;
    let params: string;
    let out: string;
    if (basename(script) === "run.mjs" && read(at(script)) === RUN) {
      kernel = join(at(script), "..", "work.mjs");
      [params, out] = [at(rest[0]), at(rest[1])];
    } else if (basename(script) === "drive.mjs" && read(at(script)) === DRIVE) {
      [kernel, params, out] = [at(rest[0]), at(rest[1]), at(rest[2])];
    } else return undefined;
    const model = KERNELS.get(read(kernel) ?? "");
    const p = JSON.parse(read(params) ?? "null") as { n?: unknown } | null;
    if (!model || typeof p?.n !== "number") return undefined;
    const { value, ms } = model(p.n);
    if (value !== null) writeFileSync(join(out, "result.json"), JSON.stringify({ value }));
    return outcome(value === null ? 3 : 0, ms);
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  ).trim();
}

function repo(dir: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "init");
  return git(dir, "rev-parse", "HEAD");
}

export function makeJudgeEnv(
  opts: {
    promotion?: PromotionPolicy;
    heldOut?: boolean;
    neverReady?: boolean;
    lanes?: { count: number; trials_per_epoch: number; keep_working?: boolean };
    /** A goal-mode campaign instead of a hill climb. */
    goal?: { opsPerSecond: number } | undefined;
    /** False: assign as a judge-only run (no worker agents). */
    agents?: boolean | undefined;
    /** Fields merged over the contract (for example acceptance.audit or infeasibility). */
    contract?: Record<string, unknown> | undefined;
    /** Another rig: its own harness on the same project, seed and kit as `share`. */
    rig?: string | undefined;
    /** The kit's run driver comes from `run.copy` instead of the build. */
    runCopy?: boolean | undefined;
    /** The kit's verifiers, instead of the default single `correctness`. */
    kitVerifiers?: Record<string, unknown> | undefined;
    /** The kit's metrics, instead of the default rate `ops_per_s`. */
    kitMetrics?: Record<string, unknown> | undefined;
    /** The kit's cells, instead of the default small, held and big. */
    kitCells?: Record<string, unknown> | undefined;
    /** The MCP servers the kit's kit.json names (goal 068). */
    kitMcpServers?: unknown[] | undefined;
    /** Fields merged over the kit's build (its command or its time limit). */
    kitBuild?: Record<string, unknown> | undefined;
    share?: { root: string; seed: string; kitCommit: string } | undefined;
    /** More fields for the assignment's payload (for example a briefing). */
    assign?: Record<string, unknown> | undefined;
    /** The project is this folder of its repository, beside files that are not the project. */
    folder?: string | undefined;
    /** The seed's kernel, instead of SEED_KERNEL (for example one that crashes: goal 115). */
    seedKernel?: string | undefined;
    /** The kit's run script (bench/run.mjs) and check (check.mjs), instead of the defaults. */
    kitRun?: string | undefined;
    kitCheck?: string | undefined;
    /**
     * Real runs of the stock kernels, timed by the judge: for the judge's own tests. Without it,
     * the stand-in runner answers them (StandInRunner).
     */
    realRuns?: boolean | undefined;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "thermite-judge-"));
  const paths = {
    stateDir: join(root, "state"),
    scratchDir: join(root, "scratch"),
    inboxDir: join(root, "inbox"),
    outboxDir: join(root, "outbox"),
  };
  for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
  mkdirSync(join(paths.inboxDir, "repos"), { recursive: true });

  const project = join(opts.share?.root ?? root, "project");
  let seed: string;
  let kitCommit: string;
  if (opts.share) {
    seed = opts.share.seed;
    kitCommit = opts.share.kitCommit;
    for (const b of ["p.bundle", "k.bundle"])
      copyFileSync(join(opts.share.root, "inbox", "repos", b), join(paths.inboxDir, "repos", b));
  } else {
    const at = opts.folder ? `${opts.folder}/` : "";
    seed = repo(project, {
      [`${at}src/kernel/work.mjs`]: opts.seedKernel ?? SEED_KERNEL,
      [`${at}README.md`]: "test\n",
      ...(opts.folder
        ? { "README.md": "the repository, not the project\n", "docs/other.md": "not the project\n" }
        : {}),
    });
    git(project, "bundle", "create", "--quiet", join(paths.inboxDir, "repos", "p.bundle"), "--all");
    const kitRepo = join(root, "kit");
    kitCommit = repo(kitRepo, {
      "kit.json": JSON.stringify(
        {
          ...(opts.runCopy ? RUN_COPY_KIT : KIT),
          ...(opts.kitVerifiers ? { verifiers: opts.kitVerifiers } : {}),
          ...(opts.kitMetrics ? { metrics: opts.kitMetrics } : {}),
          ...(opts.kitCells ? { cells: opts.kitCells } : {}),
          ...(opts.kitMcpServers ? { mcp_servers: opts.kitMcpServers } : {}),
          ...(opts.kitBuild ? { build: { ...KIT.build, ...opts.kitBuild } } : {}),
        },
        null,
        2,
      ),
      "bench/run.mjs": opts.kitRun ?? RUN,
      "bench/drive.mjs": DRIVE,
      "check.mjs": opts.kitCheck ?? CHECK,
    });
    git(kitRepo, "bundle", "create", "--quiet", join(paths.inboxDir, "repos", "k.bundle"), "--all");
  }

  const keys = generateSigningKeys();
  const ledger = Ledger.open(join(paths.stateDir, "ledger", "ledger.db"));
  const rig = opts.rig ?? "rig-a";
  const service = new HarnessService({
    rig,
    ledger,
    paths,
    controlPublicKeyPem: keys.publicKeyPem,
    rigKeys: generateSigningKeys(),
    promotion: opts.promotion ?? "auto",
  });
  const goalContract = opts.goal
    ? {
        schema_version: 1,
        campaign: "js-goal",
        version: 1,
        title: "Reach the sum goals",
        mode: "goal",
        project: {
          repo: "proj",
          commit: seed,
          ...(opts.folder ? { folder: opts.folder } : {}),
          kit: { repo: "js-kit", commit: kitCommit },
        },
        target: { type: "cpu", class: "test" },
        goals: [
          {
            id: "fast",
            description: "fast enough",
            verify: {
              type: "metric_threshold",
              metric: "ops_per_s",
              op: ">=",
              value: opts.goal.opsPerSecond,
              cells: ["big"],
            },
          },
          {
            id: "correct",
            description: "still correct",
            verify: { type: "code", verifier: "correctness" },
          },
          {
            id: "readable",
            description: "readable code",
            required: false,
            verify: { type: "review", criteria: ["clear"] },
          },
        ],
        deliverable: "a commit meeting every required goal",
        editable_paths: ["src/kernel/**"],
        ...opts.contract,
      }
    : undefined;
  const parsed = parseContract(
    goalContract ?? {
      schema_version: 1,
      campaign: "js-sum",
      version: 1,
      title: "Speed up the sum",
      mode: "hill_climb",
      project: {
        repo: "proj",
        commit: seed,
        ...(opts.folder ? { folder: opts.folder } : {}),
        kit: { repo: "js-kit", commit: kitCommit },
      },
      target: { type: "cpu", class: "test" },
      objective: { primary: { metric: "ops_per_s", direction: "max", min_effect: 0.05 } },
      cells: ["small"],
      held_out_cells: opts.heldOut ? ["held"] : [],
      editable_paths: ["src/kernel/**"],
      // The test kernel's win is far above the default audit trigger; tests of audits set
      // their own thresholds.
      acceptance: {
        looks: [3, 6],
        confirm_blocks: 4,
        audit: { ratio_to_median: 1000, absolute: 1000 },
      },
      ...(opts.lanes ? { lanes: opts.lanes } : {}),
      ...opts.contract,
    },
  );
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const assign = signEnvelope(
    {
      v: 1,
      id: randomUUID(),
      rig,
      kind: "assign_campaign",
      issued_by: "owner",
      issued_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      payload: {
        run: "js-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        seed: { repo: "proj", commit: seed },
        ...(opts.agents === false ? { agents: false } : {}),
        imports: [
          { kind: "repo_bundle", path: "repos/p.bundle", repo: "proj", commit: seed },
          { kind: "kit_bundle", path: "repos/k.bundle", repo: "js-kit", commit: kitCommit },
        ],
        ...opts.assign,
      },
    },
    keys.privateKeyPem,
  );

  const standIn = opts.realRuns ? undefined : new StandInRunner(paths.scratchDir);
  const judge = new Judge({
    service,
    runner: standIn ?? new LocalRunner(paths.scratchDir),
    // Host load is not what these tests are about (the judge refuses a loaded CPU; see cpu.test).
    driver: opts.neverReady
      ? new CpuDriver("test", { load: () => Number.POSITIVE_INFINITY })
      : new CpuDriver("test", { maxLoadFraction: Number.POSITIVE_INFINITY }),
    owner: "judge-test",
    promotion: opts.promotion ?? "auto",
    readyRetries: 0,
    calibrationBlocks: 0,
  });

  /** A change to the kernel, as a patch from the project's root (its folder, if it has one). */
  const patch = (kernel: string): string => {
    const wt = join(root, `wt-${randomUUID().slice(0, 8)}`);
    execFileSync("git", ["clone", "--quiet", project, wt]);
    writeFileSync(join(wt, opts.folder ?? "", "src", "kernel", "work.mjs"), kernel);
    execFileSync("git", ["add", "-A"], { cwd: wt });
    return execFileSync(
      "git",
      ["diff", "--cached", "--binary", ...(opts.folder ? [`--relative=${opts.folder}`] : [])],
      { cwd: wt },
    ).toString("base64");
  };

  /** Runs the judge until no job is left. */
  const drain = async (max = 50) => {
    for (let i = 0; i < max; i++) if (!(await judge.tick())) return;
    throw new Error("judge did not drain");
  };

  /**
   * Assigns the run and, for a hill climb, has the judge measure its starting point (goal 115):
   * the run's rounds wait for that baseline, and its other judge jobs too.
   */
  const start = async () => {
    const out = await service.applyCommand(assign);
    if (!(out.status === "applied" && out.accepted)) throw new Error(JSON.stringify(out));
    if (parsed.contract.mode !== "hill_climb") return out;
    const run = String(opts.assign?.run ?? "js-1");
    for (let i = 0; i < 5 && !ledger.latestEventBody("baseline", run); i++) await judge.tick();
    if (!ledger.latestEventBody("baseline", run))
      throw new Error("the judge did not measure the starting point");
    return out;
  };

  /** Signs any command for this rig with control's test key. */
  const sign = (kind: CommandKind, payload: unknown) =>
    signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig,
        kind,
        issued_by: "owner",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload,
      },
      keys.privateKeyPem,
    );

  /** What became of an attempt, for assertion messages: lifecycle, verdicts, jobs, events. */
  const explain = (attempt: string) =>
    JSON.stringify({
      lifecycle: ledger.attempts.get(attempt)?.lifecycle,
      verdicts: ledger.db
        .prepare("select verdict, reasons from verdict where attempt = ? order by id")
        .all(attempt),
      jobs: ledger.db
        .prepare(
          "select id, kind, state, attempt, substr(result, 1, 300) as result from job order by id",
        )
        .all(),
      events: ledger
        .eventsAfter(0, 10_000)
        .events.map((e) => `${e.kind}${e.subject ? `:${e.subject}` : ""}`)
        .slice(-40),
    });

  return {
    root,
    paths,
    service,
    ledger,
    judge,
    assign,
    sign,
    patch,
    drain,
    start,
    seed,
    kitCommit,
    keys,
    explain,
  };
}
