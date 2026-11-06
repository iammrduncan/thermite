import assert from "node:assert/strict";
import {
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
import { KitSchema } from "../../../src/core/kit.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import type { BuildManifest, BuildStore } from "../../../src/harness/judge/builds.ts";
import { type ArmRun, copyForRun, runArm } from "../../../src/harness/judge/measure.ts";

function kitDir(): string {
  const kit = mkdtempSync(join(tmpdir(), "thermite-kit-"));
  mkdirSync(join(kit, "run", "lib"), { recursive: true });
  mkdirSync(join(kit, "data"));
  mkdirSync(join(kit, "refs"));
  writeFileSync(join(kit, "run", "cell.py"), "print('cell')\n", { mode: 0o644 });
  writeFileSync(join(kit, "run", "lib", "tool.sh"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(kit, "data", "corpus.txt"), "text\n");
  writeFileSync(join(kit, "refs", "a1.json"), "{}\n");
  return kit;
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe("run.copy", () => {
  test("copies only the listed paths, read-only, keeping the execute bit", () => {
    const kit = kitDir();
    const dest = join(mkdtempSync(join(tmpdir(), "thermite-run-")), "kit");
    copyForRun(kit, ["run", "data/corpus.txt"], dest);
    assert.equal(readFileSync(join(dest, "run", "cell.py"), "utf8"), "print('cell')\n");
    assert.equal(mode(join(dest, "run", "cell.py")), 0o444);
    assert.equal(mode(join(dest, "run", "lib", "tool.sh")), 0o555);
    assert.equal(mode(join(dest, "data", "corpus.txt")), 0o444);
    for (const d of [dest, join(dest, "run"), join(dest, "run", "lib"), join(dest, "data")]) {
      assert.equal(mode(d), 0o555, d);
    }
    assert.throws(() => statSync(join(dest, "refs")), /ENOENT/);
  });

  test("a link or a missing path is refused", () => {
    const kit = kitDir();
    symlinkSync("../refs/a1.json", join(kit, "run", "a1.json"));
    const run = mkdtempSync(join(tmpdir(), "thermite-run-"));
    assert.throws(() => copyForRun(kit, ["run"], join(run, "a")), /not a regular file/);
    assert.throws(() => copyForRun(kit, ["nothing"], join(run, "b")), /not in the kit/);
  });
});

/**
 * One run of a kit with a driver (run.driver), measured as the judge measures it, in this process
 * (LocalRunner: no users, the same pipes and limits). The candidate squares each number it reads;
 * the driver sends one, reads the answer and writes it as the output; the check reads that.
 */
async function drivenRun(o: {
  candidate: string;
  driver: string;
  check?: string;
  metrics?: Record<string, unknown>;
  uses?: ReadonlySet<string>;
}): Promise<{
  r: ArmRun;
  ms: number;
}> {
  const scratch = mkdtempSync(join(tmpdir(), "thermite-driven-"));
  const kit = join(scratch, "kit");
  mkdirSync(join(kit, "run"), { recursive: true });
  writeFileSync(join(kit, "run", "candidate.mjs"), o.candidate);
  writeFileSync(join(kit, "run", "driver.mjs"), o.driver);
  writeFileSync(
    join(kit, "check.mjs"),
    o.check ??
      `import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2] + "/result.json", "utf8"));
process.stdout.write(JSON.stringify({ pass: true, reasons: [], value: r.value, cwd: process.cwd() }) + "\\n");
`,
  );
  const runsDir = join(scratch, "runs");
  mkdirSync(runsDir);
  const node = process.execPath;
  const k = KitSchema.parse({
    schema_version: 1,
    name: "driven",
    target: "cpu",
    build: { command: ["true"], outputs: ["x"] },
    cells: { five: { n: 5 } },
    run: {
      copy: ["run"],
      command: [node, "{kit:run/candidate.mjs}"],
      driver: [node, "{kit:run/driver.mjs}", "{params_json}", "{out}"],
      timeout_s: 20,
    },
    metrics: o.metrics ?? { time: { from: "time" } },
    check: { command: [node, "{kit:check.mjs}", "{out}"] },
  });
  const started = Date.now();
  const r = await runArm(
    {
      runner: new LocalRunner(scratch),
      store: { verify: () => [] } as unknown as BuildStore,
      kit: k,
      kitDir: kit,
      runsDir,
      modelsDir: join(scratch, "models"),
      ...(o.uses ? { uses: o.uses } : {}),
    },
    { name: "candidate", dir: scratch, manifest: { key: "k" } as unknown as BuildManifest },
    "five",
  );
  return { r, ms: Date.now() - started };
}

const SQUARES = `import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) process.stdout.write(String(Number(line) ** 2) + "\\n");
`;
const DRIVER = `import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const p = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(p.n + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  writeFileSync(process.argv[3] + "/result.json", JSON.stringify({ value: Number(line) }));
  process.exit(0);
}
`;

describe("a kit's driver beside the candidate", () => {
  test("each reads what the other writes; the driver writes the outputs, and the check reads them in a folder of its own", async () => {
    const { r } = await drivenRun({ candidate: SQUARES, driver: DRIVER });
    assert.equal(r.kind, "ok", JSON.stringify(r));
    if (r.kind !== "ok") return;
    assert.equal(r.check.details.value, 25);
    assert.match(String(r.check.details.cwd), /\/check$/);
    assert.ok(r.metrics.time && r.metrics.time > 0);
  });

  test("the run ends when the driver's does: a candidate that would go on is ended", async () => {
    const forever = `${SQUARES}setInterval(() => {}, 1000);\n`;
    const { r, ms } = await drivenRun({ candidate: forever, driver: DRIVER });
    assert.equal(r.kind, "ok", JSON.stringify(r));
    assert.ok(ms < 15_000, `ended at once, not at its time limit (${ms} ms)`);
  });

  test("the contract's metrics are needed in every run; the kit's others are kept where the check gives them (goal 182)", async () => {
    // The check reports value, and no prefill_tps: a metric of the kit for another campaign.
    const metrics = {
      time: { from: "time" },
      squared: { from: "check", field: "value" },
      prefill: { unit: "tok/s", from: "check", field: "prefill_tps" },
      tokens: { unit: "tok/s", work: "prompt_tokens" },
    };
    const run = (uses?: ReadonlySet<string>) =>
      drivenRun({ candidate: SQUARES, driver: DRIVER, metrics, ...(uses ? { uses } : {}) });
    const { r } = await run(new Set(["squared"]));
    assert.equal(r.kind, "ok", JSON.stringify(r));
    if (r.kind !== "ok") return;
    assert.equal(r.metrics.squared, 25);
    assert.ok(r.metrics.time && r.metrics.time > 0, "time is always there");
    assert.deepEqual(Object.keys(r.metrics).sort(), ["squared", "time"]);
    // The contract decides by prefill: a run without it is invalid, as before.
    const needed = (await run(new Set(["squared", "prefill"]))).r;
    assert.equal(needed.kind, "invalid");
    if (needed.kind !== "invalid") return;
    assert.equal(needed.failure, "metric");
    assert.equal(needed.reason, "the check reported no prefill_tps above zero (got null)");
    // A rate the contract decides by, on a cell without its work: an infrastructure error.
    await assert.rejects(run(new Set(["tokens"])), /kit metric tokens: bad work undefined/);
    // No contract named: every metric of the kit is needed.
    assert.equal((await run()).r.kind, "invalid");
  });

  test("a metric that may be zero takes a zero; another metric, or a negative value, does not (goal 211)", async () => {
    const check = (kl: string) => `import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2] + "/result.json", "utf8"));
process.stdout.write(JSON.stringify({ pass: true, reasons: [], value: r.value, kl: ${kl} }) + "\\n");
`;
    const run = (kl: string, mayBeZero: boolean) =>
      drivenRun({
        candidate: SQUARES,
        driver: DRIVER,
        check: check(kl),
        metrics: {
          time: { from: "time" },
          kl: { from: "check", field: "kl", ...(mayBeZero ? { may_be_zero: true } : {}) },
        },
        uses: new Set(["kl"]),
      });
    const zero = (await run("0", true)).r;
    assert.equal(zero.kind, "ok", JSON.stringify(zero));
    if (zero.kind === "ok") assert.equal(zero.metrics.kl, 0);
    const refused = (await run("0", false)).r;
    assert.ok(refused.kind === "invalid" && refused.failure === "metric");
    assert.equal(
      refused.kind === "invalid" ? refused.reason : "",
      "the check reported no kl above zero (got 0)",
    );
    const negative = (await run("-0.5", true)).r;
    assert.equal(
      negative.kind === "invalid" ? negative.reason : "",
      "the check reported no kl of zero or above (got -0.5)",
    );
    // A field the check left out is no number, even where zero would do.
    const missing = (await run("null", true)).r;
    assert.equal(
      missing.kind === "invalid" ? missing.reason : "",
      "the check reported no kl of zero or above (got null)",
    );
  });

  test("a driver that fails is the run's crash, with its words", async () => {
    const failing = `process.stderr.write("the candidate never answered\\n"); process.exit(3);\n`;
    const { r } = await drivenRun({ candidate: SQUARES, driver: failing });
    assert.equal(r.kind, "crash");
    if (r.kind !== "crash") return;
    assert.equal(r.failure, "exit");
    assert.match(r.reason, /exit 3: the candidate never answered/);
  });
});
