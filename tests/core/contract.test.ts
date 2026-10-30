import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { canonicalSha } from "../../src/core/canonical.ts";
import {
  agentsContextRefusal,
  agentsContextWords,
  contextApplied,
} from "../../src/core/compaction.ts";
import { CHECK_CONSTRAINT_REFUSED, parseContract } from "../../src/core/contract.ts";
import { goalFixture, hillClimbFixture, researchFixture } from "../helpers/fixtures.ts";

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("contracts", () => {
  test("accepts one fixture per mode and applies defaults", () => {
    for (const fixture of [hillClimbFixture, goalFixture, researchFixture]) {
      const r = parseContract(fixture);
      assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
      assert.match(r.sha, /^[0-9a-f]{64}$/);
    }
    const hc = parseContract(hillClimbFixture);
    assert.ok(hc.ok && hc.contract.mode === "hill_climb");
    if (hc.ok && hc.contract.mode === "hill_climb") {
      assert.equal(hc.contract.acceptance.alpha_screen, 0.1);
      assert.deepEqual(hc.contract.acceptance.looks, [3, 6, 9]);
    }
  });

  test("a check hard constraint is refused, with what to use instead (goal 163)", () => {
    const r = parseContract({
      ...hillClimbFixture,
      hard_constraints: [
        { kind: "min", metric: "ops_per_s", value: 1 },
        { kind: "check", check: "correctness" },
      ],
    });
    assert.deepEqual(r.ok ? [] : r.errors, [`hard_constraints.1: ${CHECK_CONSTRAINT_REFUSED}`]);
    assert.match(CHECK_CONSTRAINT_REFUSED, /Remove it, or bound a metric with `min` or `max`/);
  });

  test("an edit changes the content hash", () => {
    const a = parseContract(hillClimbFixture);
    const b = parseContract({ ...hillClimbFixture, cells: ["n256"] });
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.ok && a.sha, b.ok && b.sha);
  });

  test("goal mode keeps insufficient outcomes and checklist, and checks its goal graph", () => {
    const g = parseContract(goalFixture);
    assert.ok(g.ok && g.contract.mode === "goal");
    if (g.ok && g.contract.mode === "goal") {
      assert.equal(g.contract.insufficient.length, 2);
      assert.equal(g.contract.infeasibility.allowed, false);
    }
    const dupe = parseContract({
      ...goalFixture,
      goals: [...goalFixture.goals, goalFixture.goals[0]],
    });
    assert.ok(!dupe.ok && dupe.errors.some((e) => e.includes("duplicate goal id")));
    const badParent = parseContract({
      ...goalFixture,
      goals: [{ ...goalFixture.goals[0], parent: "missing" }],
    });
    assert.ok(!badParent.ok && badParent.errors.some((e) => e.includes("unknown parent")));
    const infeasibleNoEvidence = parseContract({
      ...goalFixture,
      infeasibility: { allowed: true },
    });
    assert.ok(!infeasibleNoEvidence.ok);
  });

  test("research needs a minimum duration, and max is not below min", () => {
    const { min_duration: _m, ...noMin } = researchFixture;
    assert.ok(!parseContract(noMin).ok);
    assert.ok(!parseContract({ ...researchFixture, max_duration: "1h" }).ok);
    const r = parseContract(researchFixture);
    assert.ok(r.ok && r.contract.mode === "research" && r.contract.quality.verbatim_quotes);
  });

  test("a misspelled key anywhere is refused, not dropped", () => {
    const r = parseContract({ ...hillClimbFixture, acceptance: { look: [3] } });
    assert.equal(r.ok, false);
    const g = parseContract({ ...hillClimbFixture, held_out_cell: ["x"] });
    assert.equal(g.ok, false);
    // A contract has no search policy: web search comes from an MCP server the campaign names.
    const s = parseContract({ ...researchFixture, search_policy: { blocked_patterns: [] } });
    assert.deepEqual(s.ok ? [] : s.errors, ['(root): Unrecognized key: "search_policy"']);
  });

  test("a project can be one folder of its repository; a folder that leaves it is refused", () => {
    const withFolder = (folder: unknown) =>
      parseContract({ ...hillClimbFixture, project: { ...hillClimbFixture.project, folder } });
    for (const ok of ["examples/matmul-cpu/project", "kernels", "a_b/c-d/v1.2", "@scope/pkg"]) {
      const r = withFolder(ok);
      assert.ok(r.ok, `${ok}: ${r.ok ? "" : r.errors.join("; ")}`);
      assert.equal(r.ok && r.contract.project.folder, ok);
    }
    for (const bad of [
      "",
      "/abs",
      "trailing/",
      "a//b",
      ".",
      "..",
      "a/../b",
      "./a",
      ".git",
      "a/.git",
      "a b",
      "a\\b",
    ]) {
      const r = withFolder(bad);
      assert.ok(!r.ok, `${JSON.stringify(bad)} was accepted`);
      assert.ok(r.errors.some((e) => e.startsWith("project.folder: a folder in the repository")));
    }
    // Optional and without a default: a contract written before it keeps its hash.
    const before = parseContract(hillClimbFixture);
    assert.ok(before.ok && !("folder" in before.contract.project));
    const a = withFolder("kernels");
    assert.ok(
      a.ok && before.ok && a.sha !== before.sha,
      "the folder is part of the contract's hash",
    );
  });

  test("a campaign's own context settings (agents_context): optional, checked, and in the hash only when set", () => {
    const before = parseContract(hillClimbFixture);
    assert.ok(before.ok && !("agents_context" in before.contract));
    // A contract written before it keeps its hash: no default is filled in.
    assert.equal(before.sha, canonicalSha(before.contract));
    const set = parseContract({
      ...hillClimbFixture,
      agents_context: { context_window: 131_072, compact_at: 70 },
    });
    assert.ok(set.ok && before.ok && set.sha !== before.sha);
    assert.deepEqual(set.ok && set.contract.agents_context, {
      context_window: 131_072,
      compact_at: 70,
    });
    for (const bad of [
      { context_window: 4095 },
      { context_window: 100_000_001 },
      { context_window: 1.5 },
      { compact_at: 49 },
      { compact_at: 96 },
      { compact_at: 80.5 },
      { window: 131_072 },
    ]) {
      const r = parseContract({ ...hillClimbFixture, agents_context: bad });
      assert.ok(!r.ok, JSON.stringify(bad));
      assert.ok(
        r.errors.some((e) => e.startsWith("agents_context")),
        r.errors.join("; "),
      );
    }
  });

  test("a campaign's brief (goal 078): notes, ideas and hypotheses are optional, in the hash only when set; old contracts keep their hashes", () => {
    // The hashes of the example contracts and the fixtures before goal 078: unchanged. The smoke
    // contract's and the hill-climb fixture's changed once since, when goal 163 removed their
    // `check` hard constraint, which is refused now.
    const examples = join(import.meta.dirname, "..", "..", "examples", "contracts");
    const before: [unknown, string][] = [
      [
        readJson(join(examples, "goal-example.json")),
        "1938aea2ef40f963e07fb5b392087992308f019db78a3414ed5670369f02f5c4",
      ],
      [
        readJson(join(examples, "research-example.json")),
        "866ba7a8e82cdf8a010832073e9d4707bc2f32a1edbb02b7633164e721650c17",
      ],
      [
        readJson(join(examples, "smoke-cpu.json")),
        "27b211d2e3514fe2c2eec61c246dde7d7cc9a84b0629e456bd8c43230f091402",
      ],
      [
        readJson(join(examples, "smoke-cpu-goal.json")),
        "e36832a534c66e07282f0af8233c04333194e3c4e79aadefa3ee8aa0fbb0e108",
      ],
      [hillClimbFixture, "c459fd271bff175c50f9f4dd32a613a725d39699a0c04e6d568051555369ab8b"],
      [goalFixture, "eb289201617fdeea3212e273e5925ed2bff2b6951b1e11d1525aaca7f36a72d2"],
      [researchFixture, "198706ecb4cc39015c6ef2515efd800182f6b60fdf8b6bbc1c2de78a14dab945"],
    ];
    for (const [c, sha] of before) {
      const r = parseContract(c);
      assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
      assert.equal(r.ok && r.sha, sha);
      assert.ok(
        r.ok &&
          !("ideas" in r.contract) &&
          !("hypotheses" in r.contract) &&
          !("links" in r.contract),
      );
    }
    // A brief of any length; each part changes the hash.
    const notes = `## Background\n${"A long line about the project. ".repeat(4000)}`;
    const hc = parseContract({
      ...hillClimbFixture,
      notes,
      ideas: ["Fuse the dequantize step.", "Load 128-bit vectors."],
      hypotheses: ["It is memory bound.\nAt batch size 1 only."],
    });
    assert.ok(hc.ok, hc.ok ? "" : hc.errors.join("; "));
    assert.ok(hc.ok && hc.contract.mode === "hill_climb" && hc.contract.ideas?.length === 2);
    assert.equal(hc.ok && hc.contract.notes, notes);
    const base = parseContract(hillClimbFixture);
    assert.ok(hc.ok && base.ok && hc.sha !== base.sha);
    const research = parseContract({
      ...researchFixture,
      questions: ["A question\nwith a second line, as long as it needs."],
      hypotheses: ["Fresh workers lose nothing."],
    });
    assert.ok(research.ok, research.ok ? "" : research.errors.join("; "));
    // Ideas to try are for hill climb and goal; empty entries are refused.
    assert.ok(!parseContract({ ...researchFixture, ideas: ["x"] }).ok);
    // Starting links: a hill climb's or goal's links (web addresses); a research contract's seeds.
    const linked = parseContract({ ...goalFixture, links: ["https://git.example.com/team/x"] });
    assert.ok(linked.ok && linked.contract.mode === "goal" && linked.contract.links?.length === 1);
    assert.ok(!parseContract({ ...goalFixture, links: ["not a link"] }).ok);
    assert.ok(!parseContract({ ...researchFixture, links: ["https://a.example.com"] }).ok);
    const empty = parseContract({ ...goalFixture, hypotheses: [""] });
    assert.ok(!empty.ok && empty.errors.some((e) => e.startsWith("hypotheses.0")));
  });

  test("the window an agent works with: the lower wins, and the campaign's point replaces its own", () => {
    assert.deepEqual(contextApplied({ contextWindow: 204_800, compactAt: 80 }, undefined), {
      contextWindow: 204_800,
      compactAt: 80,
    });
    assert.deepEqual(contextApplied({ contextWindow: 204_800 }, { context_window: 131_072 }), {
      contextWindow: 131_072,
      compactAt: undefined,
    });
    // The rig's cap (or a smaller model) below the campaign's: the rig's.
    assert.deepEqual(
      contextApplied(
        { contextWindow: 65_536, compactAt: 90 },
        { context_window: 131_072, compact_at: 70 },
      ),
      { contextWindow: 65_536, compactAt: 70 },
    );
    // A window nobody lists (0): the campaign's as given.
    assert.deepEqual(contextApplied({ contextWindow: 0 }, { context_window: 32_768 }), {
      contextWindow: 32_768,
      compactAt: undefined,
    });
    assert.deepEqual(contextApplied({ contextWindow: 0 }, { compact_at: 60 }), {
      contextWindow: 0,
      compactAt: 60,
    });
    assert.equal(agentsContextRefusal({ context_window: 131_072, compact_at: 70 }), undefined);
    assert.match(
      String(agentsContextRefusal({ context_window: 100 })),
      /from 4,096 to 100,000,000/,
    );
    assert.match(String(agentsContextRefusal({ compact_at: "70" })), /from 50 to 95/);
    assert.equal(
      agentsContextWords({ context_window: 131_072, compact_at: 70 }),
      "a context window of 131,072 tokens, compaction at 70% of the window",
    );
    assert.equal(agentsContextWords(undefined), "none: each agent keeps the rig's settings");
  });

  test("rejects unknown modes and missing edit policy", () => {
    // A hill climb's held-out cell is never one of its measured cells too.
    const overlap = parseContract({
      ...hillClimbFixture,
      held_out_cells: ["n512", "n1024", "n256"],
    });
    assert.ok(!overlap.ok);
    assert.deepEqual(!overlap.ok && overlap.errors, [
      "held_out_cells: n512, n256 are in both cells and held_out_cells: a held-out cell is measured only at confirmation, so it can't be one of cells",
    ]);
    const apart = parseContract({ ...hillClimbFixture, held_out_cells: ["n1024"] });
    assert.ok(apart.ok, apart.ok ? "" : apart.errors.join("; "));
    assert.ok(!parseContract({ ...hillClimbFixture, mode: "freestyle" }).ok);
    const { editable_paths: _e, ...noEdit } = hillClimbFixture;
    assert.ok(!parseContract(noEdit).ok);
  });
});
