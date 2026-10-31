import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import {
  BASELINE_RETRY_MS,
  type Baseline,
  type BaselineFailure,
  baselineDir,
  baselineDue,
  baselineState,
  sealBaselineDir,
  startingPoint,
} from "../../../src/harness/judge/baseline.ts";
import { Judge } from "../../../src/harness/judge/judge.ts";
import { CpuDriver } from "../../../src/harness/targets/cpu.ts";
import {
  CRASH_KERNEL,
  FAST_KERNEL,
  makeJudgeEnv,
  SEED_KERNEL,
  WRONG_KERNEL,
} from "../../helpers/judge-env.ts";

/**
 * A hill climb's baseline (goal 115): the judge's first job measures the starting point, nothing
 * of the run is judged before it, a starting point that can't be measured puts the run in setup,
 * the guards' total allowance holds against it, and the kit's check may keep files for later
 * checks in a judge-only folder.
 */

async function setup(opts: Parameters<typeof makeJudgeEnv>[0] = {}) {
  const env = makeJudgeEnv({ realRuns: true, ...opts });
  const out = await env.service.applyCommand(env.assign);
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  // Every patch is made from the seed, so it is applied to the seed.
  const submit = async (kernel: string, hypothesis: string) =>
    (
      await env.service.submitAttempt(
        {
          run: "js-1",
          parent: env.seed,
          patch_base64: env.patch(kernel),
          hypothesis,
          known_flaws: [],
        },
        "proposer",
      )
    ).attempt;
  const baseline = () => env.ledger.latestEventBody("baseline", "js-1") as Baseline | undefined;
  const failure = () =>
    env.ledger.latestEventBody("baseline_failed", "js-1") as BaselineFailure | undefined;
  const jobs = () =>
    env.ledger.db.prepare("select id, kind, state, attempt from job order by id").all() as {
      id: number;
      kind: string;
      state: string;
      attempt: string | null;
    }[];
  const verdicts = (id: string) =>
    env.ledger.db
      .prepare("select verdict, reasons from verdict where attempt = ? order by id")
      .all(id) as { verdict: string; reasons: string }[];
  return { ...env, submit, baseline, failure, jobs, verdicts };
}

/** Two quick cells, so the baseline has values on each. */
const TWO_CELLS = {
  kitCells: {
    small: { n: 20000000, work: 20000000 },
    tiny: { n: 5000000, work: 5000000 },
    held: { n: 15000000, work: 15000000 },
  },
  contract: { cells: ["small", "tiny"] },
};

describe("a hill climb's baseline (goal 115)", () => {
  test("the judge's first job measures the starting point alone on every cell, and the run's other jobs wait for it", async () => {
    const env = await setup(TWO_CELLS);
    // A change submitted before the judge's first tick: its job is queued first.
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    // Of a run that waits for its baseline, no job but a baseline job is leased.
    assert.equal(env.ledger.jobs.lease("t", 60_000, undefined, undefined, ["js-1"]), undefined);
    const judge = new Judge({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      driver: new CpuDriver("test", { maxLoadFraction: Number.POSITIVE_INFINITY }),
      owner: "judge-test",
      promotion: "auto",
      readyRetries: 0,
      calibrationBlocks: 2,
    });
    assert.equal(await judge.tick(), true);
    // The baseline ran, ahead of the change's earlier job, and no calibration was queued yet.
    assert.deepEqual(
      env.jobs().map((j) => `${j.kind}:${j.state}`),
      ["evaluate:queued", "baseline:done"],
    );
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "queued");
    const b = env.baseline();
    assert.ok(b, env.explain(id));
    assert.equal(b.champion_seq, 1);
    assert.equal(b.commit, env.seed);
    assert.equal(b.attempt, null);
    assert.equal(b.blocks, 3);
    assert.equal(b.runs_per_cell, 1);
    assert.deepEqual(b.primary, { metric: "ops_per_s", direction: "max" });
    assert.deepEqual(b.units, { ops_per_s: "op/s" });
    // Every measured cell, never a held-out one, each with the median, spread and count.
    assert.deepEqual(Object.keys(b.cells).sort(), ["small", "tiny"]);
    for (const cell of ["small", "tiny"]) {
      const v = b.cells[cell]?.ops_per_s;
      assert.ok(v && v.median > 0 && v.mad >= 0 && v.n === 3, JSON.stringify(b.cells));
    }
    assert.deepEqual(b.files, []);
    assert.match(
      b.summary,
      /^ops_per_s small [\d.e+]+ ±[\d.]+%, tiny [\d.e+]+ ±[\d.]+% \(median of 3 blocks\)$/,
    );
    // The values are the median of the blocks' measurements, kept as the baseline's arm.
    const rows = env.ledger.db
      .prepare(
        "select cell, value from measurement where arm = 'baseline' and metric = 'ops_per_s' order by id",
      )
      .all() as { cell: string; value: number }[];
    assert.equal(rows.length, 6);
    const small = rows
      .filter((r) => r.cell === "small")
      .map((r) => r.value)
      .sort((x, y) => x - y);
    assert.equal(b.cells.small?.ops_per_s?.median, small[1]);
    assert.deepEqual(baselineState(env.ledger, "js-1")?.state, "measured");
    // Then the change, and only after the baseline, the calibration.
    assert.equal(await judge.tick(), true);
    assert.ok(env.ledger.verdicts.current(id), env.explain(id));
    const cal = env.jobs().find((j) => j.kind === "calibrate");
    const base = env.jobs().find((j) => j.kind === "baseline");
    assert.ok(cal && base && cal.id > base.id);
  });

  test("a baseline that failed in the judge itself is tried again at once; after a second failure, 10 minutes later", async () => {
    const env = await setup();
    const fail = () => {
      const id = env.ledger.jobs.enqueue({
        kind: "baseline",
        spec: { run: "js-1", champion_seq: 1, commit: env.seed },
        actor: "test",
      });
      env.ledger.db
        .prepare("update job set state = 'failed', updated_at = ? where id = ?")
        .run(new Date().toISOString(), id);
    };
    fail();
    assert.equal((baselineDue(env.ledger, "js-1") || undefined)?.seq, 1, "the first: at once");
    fail();
    assert.equal(baselineDue(env.ledger, "js-1"), false, "the second: it waits");
    const later = Date.now() + BASELINE_RETRY_MS + 1000;
    assert.equal((baselineDue(env.ledger, "js-1", later) || undefined)?.seq, 1);
  });
  test("a run from before, with no baseline, gets its baseline when it is resumed", async () => {
    const env = await setup();
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    env.ledger.runs.setStatus("js-1", "paused", "t", "owner");
    // Paused: its jobs wait and no baseline is queued.
    assert.equal(await env.judge.tick(), false);
    assert.deepEqual(
      env.jobs().map((j) => j.kind),
      ["evaluate"],
    );
    env.ledger.runs.setStatus("js-1", "running", null, "owner");
    assert.equal(await env.judge.tick(), true);
    assert.equal(env.baseline()?.champion_seq, 1);
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "queued");
    await env.drain();
    assert.ok(env.ledger.verdicts.current(id), env.explain(id));
  });

  test("a starting point that can't be measured puts the run in setup; a setup change the judge can measure becomes the starting point", async () => {
    const env = await setup({ seedKernel: CRASH_KERNEL });
    await env.drain();
    // The seed crashes on its cell: no baseline, and the reasons in words.
    assert.equal(env.baseline(), undefined);
    const f = env.failure();
    assert.ok(f);
    assert.equal(f.champion_seq, 1);
    assert.equal(f.commit, env.seed);
    assert.match(f.reasons, /^cell small: exit 3/);
    assert.match(
      f.summary,
      /the judge could not measure champion #1 \([0-9a-f]{8}\): cell small: exit 3/,
    );
    assert.equal(baselineState(env.ledger, "js-1")?.state, "setup");
    // It is not tried again on its own.
    assert.equal(await env.judge.tick(), false);

    // A setup change the judge can't measure either: its verdict gives the reasons.
    const wrong = await env.submit(WRONG_KERNEL, "a closed form");
    assert.equal(env.jobs().find((j) => j.attempt === wrong)?.kind, "baseline");
    await env.drain();
    const w = env.verdicts(wrong);
    assert.deepEqual(
      w.map((v) => v.verdict),
      ["invalid"],
    );
    assert.match(
      w[0]?.reasons ?? "",
      /^the judge could not measure this setup change, so the run is still in setup: cell small: wrong result/,
    );
    assert.equal(env.ledger.champions.current("js-1").seq, 1);
    assert.equal(baselineState(env.ledger, "js-1")?.state, "setup");

    // A setup change that runs: the starting point, and its values the baseline.
    const fix = await env.submit(FAST_KERNEL, "make it run");
    await env.drain();
    assert.deepEqual(
      env.verdicts(fix).map((v) => v.verdict),
      ["starting_point"],
      env.explain(fix),
    );
    const champ = env.ledger.champions.current("js-1");
    assert.equal(champ.seq, 2);
    assert.equal(champ.attempt, fix);
    assert.equal(String(env.ledger.attempts.get(fix)?.lifecycle), "promoted");
    const row = env.ledger.db
      .prepare("select promoted_by from champion where run = 'js-1' and seq = 2")
      .get() as { promoted_by: string };
    assert.match(row.promoted_by, /:setup$/);
    assert.equal(env.ledger.latestEventBody("champion_promoted", "js-1")?.setup, true);
    assert.deepEqual(startingPoint(env.ledger, "js-1").seq, 2);
    const b = env.baseline();
    assert.ok(b);
    assert.equal(b.champion_seq, 2);
    assert.equal(b.attempt, fix);
    assert.ok((b.cells.small?.ops_per_s?.median ?? 0) > 0);
    assert.equal(baselineState(env.ledger, "js-1")?.state, "measured");

    // From now on, changes are screened against the champion, as usual.
    const next = await env.submit(`${FAST_KERNEL}// again\n`, "the same again");
    assert.equal(env.jobs().find((j) => j.attempt === next)?.kind, "evaluate");
    await env.drain();
    assert.ok(env.ledger.verdicts.current(next), env.explain(next));
  });

  test("in setup, a resume measures the starting point again", async () => {
    const env = await setup({ seedKernel: CRASH_KERNEL });
    await env.drain();
    assert.ok(env.failure());
    env.ledger.runs.setStatus("js-1", "paused", "t", "owner");
    env.ledger.runs.setStatus("js-1", "running", null, "owner");
    assert.equal(await env.judge.tick(), true);
    const failures = env.ledger.db
      .prepare("select count(*) as n from event where kind = 'baseline_failed'")
      .get() as { n: number };
    assert.equal(Number(failures.n), 2);
    assert.equal(await env.judge.tick(), false);
  });

  test("a setup change measured after the run left setup is screened as any change is", async () => {
    const env = await setup({ seedKernel: CRASH_KERNEL });
    await env.drain();
    const a = await env.submit(FAST_KERNEL, "make it run");
    const b = await env.submit(`${FAST_KERNEL}// restated\n`, "make it run, restated");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(a)?.verdict, "starting_point", env.explain(a));
    // b was queued as a setup change; once a is the starting point, it is judged against it.
    const kinds = env
      .jobs()
      .filter((j) => j.attempt === b)
      .map((j) => j.kind);
    assert.deepEqual(kinds, ["baseline", "evaluate"], env.explain(b));
    assert.notEqual(env.ledger.verdicts.current(b)?.verdict, "starting_point");
  });

  test("a guard's total allowance holds against the baseline: within each step's allowance, past the total from the start is a tradeoff", async () => {
    // The kernel's module says its quality; the check reports it, a guard metric.
    const run = `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as k from "./work.mjs";
const [params, out] = process.argv.slice(2);
const p = JSON.parse(readFileSync(params, "utf8"));
writeFileSync(join(out, "result.json"), JSON.stringify({ value: k.work(p.n), quality: k.quality ?? 100 }));
`;
    const check = `import { readFileSync } from "node:fs";
import { join } from "node:path";
const [params, out] = process.argv.slice(2);
const p = JSON.parse(readFileSync(params, "utf8"));
let expected = 0;
for (let i = 0; i < p.n; i++) expected += i % 7;
const r = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
const reasons = r.value === expected ? [] : ["wrong result"];
process.stdout.write(JSON.stringify({ pass: reasons.length === 0, reasons, quality: r.quality }) + "\\n");
`;
    const env = await setup({
      kitRun: run,
      kitCheck: check,
      kitMetrics: {
        ops_per_s: { unit: "op/s", work: "work" },
        quality: { unit: "points", from: "check", field: "quality" },
      },
      contract: {
        guards: [
          {
            metric: "quality",
            direction: "max",
            max_step_regression: 0.03,
            max_total_regression: 0.03,
          },
        ],
      },
    });
    await env.drain(); // the baseline: quality 100
    assert.equal(env.baseline()?.cells.small?.quality?.median, 100);
    // A champion at quality 98 by another path: its step left no guard estimate to add up.
    const step = await env.submit(`${SEED_KERNEL}export const quality = 98;\n`, "a step");
    env.ledger.db.prepare("update job set state = 'cancelled' where attempt = ?").run(step);
    env.ledger.verdicts.record({
      attempt: step,
      verdict: "win_confirmed",
      reasons: "t",
      judgedBy: "t",
    });
    assert.ok(
      env.ledger.champions.promote({
        run: "js-1",
        expectedSeq: 1,
        attempt: step,
        commitSha: String(env.ledger.attempts.get(step)?.commit_sha),
        by: "t",
      }).ok,
    );
    // Faster, and quality 96: 2.04% below the champion (within the 3% step), 4% below the start.
    const id = await env.submit(
      `${FAST_KERNEL}export const quality = 96;\n`,
      "faster, a bit worse",
    );
    await env.drain();
    const v = env.verdicts(id);
    assert.deepEqual(
      v.map((x) => x.verdict),
      ["win_screened", "tradeoff"],
      env.explain(id),
    );
    assert.match(
      v[1]?.reasons ?? "",
      /the guard's total allowance against the starting point is spent: quality -4\.00% against the starting point \(allowed -3\.00%, and its noise 0\.00%\)/,
    );
    const guards = JSON.parse(
      String(
        (
          env.ledger.db
            .prepare("select guards from verdict where attempt = ? order by id desc limit 1")
            .get(id) as { guards: string }
        ).guards,
      ),
    ) as { metric: string; vs_start?: { spent: boolean } }[];
    assert.equal(guards[0]?.vs_start?.spent, true);
    assert.equal(env.ledger.champions.current("js-1").attempt, step);
  });

  test("the kit's check keeps files in the baseline's folder: written during the baseline, read-only later, never the run command's", async () => {
    // The run says whether it got the folder; the check writes a reference during the baseline
    // and compares with it later.
    const run = `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { work } from "./work.mjs";
const [params, out] = process.argv.slice(2);
const p = JSON.parse(readFileSync(params, "utf8"));
writeFileSync(join(out, "result.json"), JSON.stringify({ value: work(p.n), dir: process.env.THERMITE_BASELINE_DIR ?? null }));
`;
    const check = `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [params, out] = process.argv.slice(2);
const p = JSON.parse(readFileSync(params, "utf8"));
const r = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
const dir = process.env.THERMITE_BASELINE_DIR;
let wrote = 0, refused = 0, same = 0;
if (dir) {
  const ref = join(dir, "ref-" + p.n + ".json");
  try { writeFileSync(ref, JSON.stringify({ value: r.value })); wrote = 1; } catch { refused = 1; }
  try { same = JSON.parse(readFileSync(ref, "utf8")).value === r.value ? 1 : 0; } catch {}
}
process.stdout.write(JSON.stringify({ pass: true, reasons: [], has_dir: dir ? 1 : 0, wrote, refused, same, run_had_dir: r.dir ? 1 : 0 }) + "\\n");
`;
    const env = await setup({ kitRun: run, kitCheck: check });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    const b = env.baseline();
    assert.ok(b, env.explain(id));
    const dir = baselineDir(env.paths.stateDir, "js-1", b.job);
    const content = readFileSync(join(dir, "ref-20000000.json"));
    // Each file's path, size and SHA-256 in the record.
    assert.deepEqual(b.files, [
      {
        path: "ref-20000000.json",
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ]);
    assert.equal(b.bytes, content.length);
    // The judge's, entered by the checkers' group alone (the broker gives it in the image), and
    // sealed: read by the group, written by no one.
    assert.equal(statSync(join(env.paths.stateDir, "baselines")).mode & 0o777, 0o710);
    assert.equal(statSync(join(env.paths.stateDir, "baselines", "js-1")).mode & 0o777, 0o710);
    assert.equal(statSync(dir).mode & 0o777, 0o550);
    assert.equal(statSync(join(dir, "ref-20000000.json")).mode & 0o777, 0o440);
    // The checks wrote to a folder of the job's in scratch, which is gone.
    assert.ok(!existsSync(join(env.paths.scratchDir, "runs", `job-${b.job}`, "baseline")));
    // What each check saw, from the receipts: the baseline's could write, later ones could only
    // read the same reference; no run command got the folder.
    const seen = (kind: string) =>
      (
        env.ledger.db
          .prepare(
            "select r.body from receipt r join job j on j.id = r.job where j.kind = ? order by r.created_at",
          )
          .all(kind) as { body: string }[]
      ).flatMap((r) =>
        (
          JSON.parse(r.body) as {
            runs: { check?: Record<string, number> }[];
          }
        ).runs.map((x) => x.check ?? {}),
      );
    const atBaseline = seen("baseline");
    assert.ok(atBaseline.length >= 3);
    for (const c of atBaseline) {
      assert.deepEqual(
        { has_dir: c.has_dir, wrote: c.wrote, same: c.same, run_had_dir: c.run_had_dir },
        { has_dir: 1, wrote: 1, same: 1, run_had_dir: 0 },
      );
    }
    const later = [...seen("evaluate"), ...seen("confirm")];
    assert.ok(later.length >= 6);
    for (const c of later) {
      assert.deepEqual(
        { has_dir: c.has_dir, wrote: c.wrote, refused: c.refused, run_had_dir: c.run_had_dir },
        { has_dir: 1, wrote: 0, refused: 1, run_had_dir: 0 },
      );
    }
    // The candidate's runs compare with the starting point's reference: same value, same file.
    assert.ok(later.every((c) => c.same === 1));
  });

  test("the baseline's folder is capped: a check that keeps more than 64 MiB fails the baseline, with why", async () => {
    const check = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.THERMITE_BASELINE_DIR;
if (dir) { try { writeFileSync(join(dir, "big.bin"), Buffer.alloc(65 * 1024 * 1024)); } catch {} }
process.stdout.write(JSON.stringify({ pass: true, reasons: [] }) + "\\n");
`;
    const env = await setup({ kitCheck: check });
    await env.drain();
    assert.equal(env.baseline(), undefined);
    assert.match(
      env.failure()?.reasons ?? "",
      /^the kit's check wrote to the baseline's folder: it holds more than 64 MiB, the most it may keep$/,
    );
  });
});

describe("the baseline's folder (goal 115)", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "thermite-baseline-"));

  test("sealing hashes each file in path order and makes them read-only", () => {
    const d = dir();
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "b.txt"), "bb");
    writeFileSync(join(d, "sub", "a.txt"), "a");
    const r = sealBaselineDir(d);
    assert.ok(r.ok);
    assert.deepEqual(
      r.files.map((f) => [f.path, f.bytes]),
      [
        ["b.txt", 2],
        ["sub/a.txt", 1],
      ],
    );
    assert.equal(r.files[0]?.sha256, createHash("sha256").update("bb").digest("hex"));
    assert.equal(statSync(join(d, "sub")).mode & 0o777, 0o500);
    assert.equal(statSync(join(d, "b.txt")).mode & 0o777, 0o400);
  });

  test("a link, too many files or too many bytes is refused", () => {
    const linked = dir();
    symlinkSync("/etc/hosts", join(linked, "hosts"));
    const l = sealBaselineDir(linked);
    assert.ok(!l.ok && /hosts is not a regular file/.test(l.reason));
    const many = dir();
    for (const n of ["1", "2", "3"]) writeFileSync(join(many, n), n);
    const m = sealBaselineDir(many, { bytes: 1000, files: 2 });
    assert.ok(!m.ok && /more than 2 files/.test(m.reason));
    const big = dir();
    writeFileSync(join(big, "x"), Buffer.alloc(2048));
    const g = sealBaselineDir(big, { bytes: 1024 * 1024, files: 10 });
    assert.ok(g.ok);
    const h = dir();
    writeFileSync(join(h, "x"), Buffer.alloc(2 * 1024 * 1024));
    const k = sealBaselineDir(h, { bytes: 1024 * 1024, files: 10 });
    assert.ok(!k.ok && /more than 1 MiB/.test(k.reason));
  });
});
