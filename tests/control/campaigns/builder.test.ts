import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import {
  type BuiltKit,
  buildCampaign,
  type CampaignDraft,
  shellCommand,
} from "../../../src/control/campaigns/builder.ts";
import { inFolder, suggestions } from "../../../src/control/repo-probe.ts";
import { parseContract } from "../../../src/core/contract.ts";
import { KitSchema, paramsText } from "../../../src/core/kit.ts";

const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";
const here = {
  source: "here",
  build: "make bench",
  outputs: ["bench"],
  cases: [
    { name: "small", params: { n: 64 }, work: 524288 },
    { name: "large", params: { n: 512 }, work: 268435456 },
    { name: "held", params: { n: 300 }, work: 54000000 },
  ],
  run: "{build}/bench --n {n} --out {out}/result.txt",
  check: 'test "$(cat {out}/result.txt)" = "{n}" && test -f {kit}/expected.txt',
  files: [{ name: "expected.txt", content_base64: Buffer.from("ok\n").toString("base64") }],
  held_out: ["held"],
} as const satisfies CampaignDraft["kit"];

const hillClimb: CampaignDraft = {
  mode: "hill_climb",
  campaign: "matmul-speed",
  title: "Make the matrix multiply faster",
  target: { type: "cpu", class: "generic-cpu" },
  project: {
    url: "https://git.example.com/team/fastmat.git",
    ref: "main",
    commit: C,
    repo: "fastmat",
    editable_paths: ["src/kernels/**"],
  },
  kit: here,
  score: { name: "throughput", unit: "FLOP/s", direction: "max", min_effect: 0.05 },
  lanes: 2,
};

/** Writes a built kit to a directory, as a rig would check it out. */
function checkout(kit: BuiltKit): string {
  const dir = mkdtempSync(join(tmpdir(), "thermite-kit-"));
  for (const [path, body] of Object.entries(kit.files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

describe("the new-campaign page's builder", () => {
  test("a hill climb with a kit described on the page is a contract and kit the harness accepts", () => {
    const b = buildCampaign(hillClimb);
    assert.ok(b.ok, JSON.stringify(!b.ok && b.errors));
    const parsed = parseContract({ ...b.contract });
    assert.ok(parsed.ok);
    if (!parsed.ok || parsed.contract.mode !== "hill_climb") return;
    assert.deepEqual(parsed.contract.cells, ["small", "large"]);
    assert.deepEqual(parsed.contract.held_out_cells, ["held"]);
    assert.equal(parsed.contract.objective.primary.metric, "throughput");
    assert.equal(parsed.contract.project.kit?.repo, "matmul-speed-kit");
    const kit = KitSchema.parse(JSON.parse(String(b.kit?.files["kit.json"])));
    assert.equal(kit.target, "cpu");
    assert.deepEqual(kit.cells.large, { n: 512, work: 268435456 });
    assert.deepEqual(kit.metrics, { throughput: { unit: "FLOP/s", work: "work" } });
    assert.deepEqual(kit.run.copy, ["run"]);
    // A file for the check only is not in what the run may read.
    assert.ok(b.kit?.files["check/expected.txt"]);
    assert.equal(b.kit?.files["run/expected.txt"], undefined);
  });

  test("the wrappers run the commands as written, with the case's parameters, and the check's exit is the verdict", () => {
    const b = buildCampaign(hillClimb);
    assert.ok(b.ok && b.kit);
    if (!b.ok || !b.kit) return;
    const kit = checkout(b.kit);
    const build = mkdtempSync(join(tmpdir(), "thermite-build-"));
    // A "build" whose bench writes the n it was given.
    writeFileSync(
      join(build, "bench"),
      '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --n) n="$2"; shift 2;; --out) out="$2"; shift 2;; *) shift;; esac; done\necho "$n" > "$out"\n',
    );
    chmodSync(join(build, "bench"), 0o755);
    const out = mkdtempSync(join(tmpdir(), "thermite-out-"));
    const params = join(out, "..", `params-${process.pid}.txt`);
    writeFileSync(params, paramsText({ n: 512, work: 268435456 }));
    execFileSync("sh", [join(kit, "run/run.sh"), build, out, params, join(kit, "run")]);
    const pass = execFileSync(
      "sh",
      [join(kit, "check/check.sh"), build, out, params, join(kit, "check")],
      { encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(pass.trim().split("\n").at(-1) ?? ""), { pass: true, reasons: [] });
    // A wrong output fails, with the check's exit status and its last words as the reason.
    writeFileSync(join(out, "result.txt"), "7\n");
    const fail = JSON.parse(
      execFileSync("sh", [join(kit, "check/check.sh"), build, out, params, join(kit, "check")], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .at(-1) ?? "",
    ) as { pass: boolean; reasons: string[] };
    assert.equal(fail.pass, false);
    assert.match(fail.reasons[0] ?? "", /^the check exited 1/);
  });

  test("{args} split as written, {input} from the kit's inputs, and a check's own score passed on", () => {
    const b = buildCampaign({
      ...hillClimb,
      kit: {
        ...here,
        cases: [{ name: "light", args: "--users 10 --tag 'a b'", input: "req.log", work: 1 }],
        inputs: [{ name: "req.log", content_base64: Buffer.from("GET /\n").toString("base64") }],
        run: "printf '%s|' {args} > {out}/args.txt; cat {input} > {out}/copy.log",
        check: 'echo noise; echo \'{"pass": true, "p99_ms": 12.5}\'',
        held_out: [],
      },
    });
    assert.ok(b.ok && b.kit, JSON.stringify(!b.ok && b.errors));
    if (!b.ok || !b.kit) return;
    const kit = checkout(b.kit);
    const out = mkdtempSync(join(tmpdir(), "thermite-out-"));
    const params = join(out, "..", `params-args-${process.pid}.txt`);
    writeFileSync(
      params,
      paramsText({ args: "--users 10 --tag 'a b'", input: "req.log", work: 1 }),
    );
    execFileSync("sh", [join(kit, "run/run.sh"), "/b", out, params, join(kit, "run")]);
    // Word-split as the shell splits a line: the quotes in the arguments stay as characters.
    assert.equal(readFileSync(join(out, "args.txt"), "utf8"), "--users|10|--tag|'a|b'|");
    assert.equal(readFileSync(join(out, "copy.log"), "utf8"), "GET /\n");
    const verdict = execFileSync(
      "sh",
      [join(kit, "check/check.sh"), "/b", out, params, join(kit, "check")],
      {
        encoding: "utf8",
      },
    );
    assert.deepEqual(JSON.parse(verdict.trim()), { pass: true, p99_ms: 12.5 });
  });

  test("a command with quotes survives the wrapper, and an unknown placeholder is refused in words", () => {
    const quoted = shellCommand(`echo 'it''s {n}' > {out}/x`, new Set(["n"]));
    assert.equal(quoted.text, `echo 'it''s "$P_n"' > "$OUT"/x`);
    const b = buildCampaign({
      ...hillClimb,
      kit: { ...here, run: "{build}/bench --size {size}" },
    });
    assert.equal(b.ok, false);
    assert.match(JSON.stringify(!b.ok && b.errors), /\{size\} is not a placeholder here/);
  });

  test("without work per case the score is time; a check's number or a rate when asked; goals become verifiers and thresholds", () => {
    const time = buildCampaign({
      ...hillClimb,
      kit: { ...here, cases: [{ name: "small", params: { n: 64 } }], held_out: [] },
      score: { kind: "time" },
    });
    assert.ok(time.ok, JSON.stringify(!time.ok && time.errors));
    if (time.ok) {
      const kit = KitSchema.parse(JSON.parse(String(time.kit?.files["kit.json"])));
      assert.deepEqual(kit.metrics, { seconds: { unit: "s", from: "time" } });
      assert.deepEqual((time.contract.objective as { primary: unknown }).primary, {
        metric: "seconds",
        direction: "min",
        min_effect: 0.05,
      });
    }
    // A hidden case runs too, at confirmation: without its work, the score is time, never a rate
    // that every run of the hidden case would fail to work out.
    const hiddenLazy = buildCampaign({
      ...hillClimb,
      kit: { ...here, cases: [...here.cases.slice(0, 2), { name: "held", params: { n: 300 } }] },
      score: { kind: "time" },
    });
    assert.ok(hiddenLazy.ok, JSON.stringify(!hiddenLazy.ok && hiddenLazy.errors));
    if (hiddenLazy.ok) {
      const kit = KitSchema.parse(JSON.parse(String(hiddenLazy.kit?.files["kit.json"])));
      assert.deepEqual(kit.metrics, { seconds: { unit: "s", from: "time" } });
      assert.deepEqual(hiddenLazy.contract.held_out_cells, ["held"]);
    }
    const rated = buildCampaign({ ...hillClimb, score: { kind: "time" } });
    assert.ok(rated.ok, JSON.stringify(!rated.ok && rated.errors));
    if (rated.ok) {
      const kit = KitSchema.parse(JSON.parse(String(rated.kit?.files["kit.json"])));
      assert.deepEqual(Object.values(kit.metrics), [{ unit: "per s", work: "work" }]);
    }
    const checked = buildCampaign({
      ...hillClimb,
      kit: {
        ...here,
        cases: [
          { name: "validation", input: "val.csv" },
          { name: "test", input: "test.csv", hidden: true },
        ],
        inputs: [
          { name: "val.csv", content_base64: Buffer.from("a,b\n").toString("base64") },
          { name: "test.csv", content_base64: Buffer.from("c,d\n").toString("base64") },
        ],
        run: "python3 predict.py --data {input} --out {out}/predictions.csv",
        check: "python3 {kit}/score.py {out}/predictions.csv",
        held_out: [],
        runs_per_case: 3,
      },
      score: { kind: "check", field: "accuracy", unit: "%", direction: "max" },
    });
    assert.ok(checked.ok, JSON.stringify(!checked.ok && checked.errors));
    if (checked.ok) {
      const kit = KitSchema.parse(JSON.parse(String(checked.kit?.files["kit.json"])));
      assert.deepEqual(kit.metrics, { accuracy: { unit: "%", from: "check", field: "accuracy" } });
      assert.deepEqual(kit.cells.test, { input: "test.csv" });
      assert.deepEqual(checked.contract.cells, ["validation"]);
      assert.deepEqual(checked.contract.held_out_cells, ["test"]);
      assert.deepEqual(checked.contract.acceptance, { runs_per_cell: 3 });
      assert.ok(
        checked.kit?.files["run/inputs/val.csv"] && checked.kit?.files["check/inputs/test.csv"],
      );
    }
    const missing = buildCampaign({
      ...hillClimb,
      kit: { ...here, cases: [{ name: "a", input: "nope.csv" }], run: "x {input}", held_out: [] },
    });
    assert.match(JSON.stringify(!missing.ok && missing.errors), /not among the input files/);
    const goal = buildCampaign({
      ...hillClimb,
      mode: "goal",
      campaign: "codec-support",
      kit: { ...here, held_out: [] },
      goals: [
        {
          id: "builds",
          description: "it builds and passes",
          verify: { type: "check", cells: ["small"] },
        },
        {
          id: "fast",
          description: "large runs fast",
          verify: { type: "metric", op: ">=", value: 1e9, cells: ["large"] },
        },
        {
          id: "clear",
          description: "readable",
          required: false,
          verify: { type: "review", criteria: ["clear names"] },
        },
      ],
    });
    assert.ok(goal.ok, JSON.stringify(!goal.ok && goal.errors));
    if (!goal.ok) return;
    const kit = KitSchema.parse(JSON.parse(String(goal.kit?.files["kit.json"])));
    assert.deepEqual(kit.verifiers.builds?.cells, ["small"]);
    const goals = goal.contract.goals as { id: string; verify: Record<string, unknown> }[];
    assert.deepEqual(goals[0]?.verify, { type: "code", verifier: "builds" });
    assert.equal(goals[1]?.verify.type, "metric_threshold");
    assert.equal(goals[1]?.verify.metric, "throughput");
    assert.equal(goals[2]?.verify.type, "review");
  });

  test("a kit from a repository names its cases; research needs no project or kit", () => {
    const repo = buildCampaign({
      ...hillClimb,
      kit: {
        source: "repo",
        url: "https://git.example.com/team/fastmat-kit.git",
        commit: C,
        repo: "fastmat-kit",
        cells: ["small", "large"],
      },
    });
    assert.ok(repo.ok, JSON.stringify(!repo.ok && repo.errors));
    if (repo.ok) {
      assert.equal(repo.kit, undefined);
      assert.deepEqual(repo.contract.project, {
        repo: "fastmat",
        kit: { repo: "fastmat-kit", commit: C },
      });
    }
    const research = buildCampaign({
      mode: "research",
      campaign: "two-bit-decoding",
      title: "2-bit decoding on old GPUs",
      target: { type: "cpu", class: "generic-cpu" },
      research: {
        topic: "Decoding speed of 2-bit models on Pascal GPUs",
        questions: ["Which kernels are fastest?"],
        min_duration: "8h",
      },
    });
    assert.ok(research.ok, JSON.stringify(!research.ok && research.errors));
    // No floor of verified claims unless one is given (goal 112); one given is in the contract.
    assert.ok(research.ok && !("min_verified_claims" in research.contract));
    const floor = buildCampaign({
      mode: "research",
      campaign: "two-bit-decoding",
      title: "2-bit decoding on old GPUs",
      target: { type: "cpu", class: "generic-cpu" },
      research: {
        topic: "Decoding speed of 2-bit models on Pascal GPUs",
        questions: ["Which kernels are fastest?"],
        min_duration: "8h",
        min_verified_claims: 20,
      },
    });
    assert.ok(floor.ok, JSON.stringify(!floor.ok && floor.errors));
    if (floor.ok) assert.equal(floor.contract.min_verified_claims, 20);
    const missing = buildCampaign({ ...hillClimb, project: undefined });
    assert.equal(missing.ok, false);
  });

  test("a project in a folder of its repository: the contract names the folder, and the lookup reads it from its top", () => {
    const b = buildCampaign({
      ...hillClimb,
      project: { ...hillClimb.project, folder: "examples/matmul-cpu/project" },
    } as CampaignDraft);
    assert.ok(b.ok, JSON.stringify(!b.ok && b.errors));
    if (b.ok)
      assert.deepEqual(b.contract.project, {
        repo: "fastmat",
        folder: "examples/matmul-cpu/project",
        kit: { repo: "matmul-speed-kit", commit: "0".repeat(40) },
      });
    // Without one, the contract has no folder at all: the whole repository, as before.
    const whole = buildCampaign(hillClimb);
    assert.ok(whole.ok && !("folder" in (whole.contract.project as object)));
    for (const bad of ["/examples", "examples/", "../up", "a/./b"]) {
      const r = buildCampaign({
        ...hillClimb,
        project: { ...hillClimb.project, folder: bad },
      } as CampaignDraft);
      assert.ok(
        !r.ok && r.errors.some((e) => e.startsWith("project.folder: a folder in the repository")),
        bad,
      );
    }
    // The lookup's files and suggestions inside a folder are paths from the folder's top.
    const tree = [
      "README.md",
      "examples/matmul-cpu/README.md",
      "examples/matmul-cpu/project/README.md",
      "examples/matmul-cpu/project/include/matmul.h",
      "examples/matmul-cpu/project/src/kernel/matmul.c",
      "examples/matmul-cpu/project/src/ref/matmul_ref.c",
      "examples/matmul-cpu/project-old/src/kernel/matmul.c",
      "examples/matmul-cpu/kit/kit.json",
    ];
    const inside = inFolder(tree, "examples/matmul-cpu/project");
    assert.deepEqual(inside, [
      "README.md",
      "include/matmul.h",
      "src/kernel/matmul.c",
      "src/ref/matmul_ref.c",
    ]);
    assert.deepEqual(suggestions(inside), ["src/**", "include/**", "src/kernel/**", "src/ref/**"]);
    assert.deepEqual(inFolder(tree, "examples/none"), []);
  });

  test("an uploaded kit is kept as it came, with the cases and score chosen on the page", () => {
    const root = resolve(import.meta.dirname, "..", "..", "..", "kits", "smoke-cpu");
    const files: Record<string, Buffer> = {};
    for (const p of readdirSync(root, { recursive: true }) as string[])
      if (statSync(join(root, p)).isFile()) files[p] = readFileSync(join(root, p));
    const id = "a".repeat(64);
    const uploads = (u: string) => (u === id ? files : undefined);
    const kit = {
      source: "upload",
      upload: id,
      cells: ["small", "held"],
      held_out: ["held"],
    } as const;
    const r = buildCampaign({ ...hillClimb, kit, score: { min_effect: 0.1 } }, { uploads });
    assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
    if (r.ok) {
      assert.equal(r.kit?.files, files);
      assert.deepEqual(r.contract.cells, ["small"]);
      assert.deepEqual(r.contract.held_out_cells, ["held"]);
      // The kit's own metric, and the gain asked for.
      assert.deepEqual((r.contract.objective as { primary: unknown }).primary, {
        metric: "flops_per_s",
        direction: "max",
        min_effect: 0.1,
      });
    }
    // Gone from control, a case the kit doesn't have, or a goal by a check the kit lacks: refused.
    const gone = buildCampaign({ ...hillClimb, kit });
    assert.deepEqual(!gone.ok && gone.errors, ["the uploaded kit is gone: upload it again"]);
    const odd = buildCampaign({ ...hillClimb, kit: { ...kit, cells: ["huge"] } }, { uploads });
    assert.equal(odd.ok, false);
    const goal = buildCampaign(
      {
        ...hillClimb,
        mode: "goal",
        kit,
        goals: [
          { id: "loads", description: "It loads", verify: { type: "verifier", verifier: "loads" } },
        ],
      },
      { uploads },
    );
    assert.equal(goal.ok, false);
    assert.match(JSON.stringify(!goal.ok && goal.errors), /loads/);
    // A kit described here has no checks of its own to name.
    const own = buildCampaign({
      ...hillClimb,
      mode: "goal",
      goals: [
        { id: "loads", description: "It loads", verify: { type: "verifier", verifier: "loads" } },
      ],
    });
    assert.match(JSON.stringify(!own.ok && own.errors), /no checks of its own/);
  });
});
