import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { type HillClimbContract, parseContract } from "../../src/core/contract.ts";
import { contractMetrics, KitSchema, kitProblems } from "../../src/core/kit.ts";
import { metricPlan } from "../../src/core/metric-plan.ts";
import { guardWords } from "../../src/core/metric-roles.ts";

/**
 * Goal 209: a hill climb's priority, guard and informational metrics, named in its kit and
 * added to by its contract, read into one metric plan, a contract written before as it was judged.
 */

const kitBase = {
  schema_version: 1,
  name: "decode",
  target: "cuda-gpu",
  build: { command: ["make"], outputs: ["out"] },
  cells: { small: { tokens: 128 } },
  run: { command: ["{build:out/bench}", "{out}"] },
  check: { command: ["python3", "{kit:check.py}", "{out}"] },
};
const kitOf = (metrics: Record<string, unknown>) => KitSchema.safeParse({ ...kitBase, metrics });
const roles = {
  decode_tps: {
    unit: "tok/s",
    work: "tokens",
    kind: "priority",
    priority: 1,
    direction: "max",
    min_effect: 0.02,
  },
  prefill_tps: {
    unit: "tok/s",
    work: "tokens",
    kind: "priority",
    priority: 2,
    direction: "max",
    min_effect: 0.01,
  },
  perplexity: {
    from: "check",
    field: "ppl",
    kind: "guard",
    guards: [{ stay: "within", against: "baseline", by: 3 }],
  },
  peak_gib: {
    unit: "GiB",
    from: "check",
    field: "mem",
    kind: "guard",
    guards: [{ stay: "below", against: "baseline", by: 0.05 }],
  },
  itl_ms: { unit: "ms", from: "check", field: "itl", kind: "info" },
  power_w: { unit: "W", from: "check", field: "watts" },
};

const smoke = JSON.parse(readFileSync("examples/contracts/smoke-cpu.json", "utf8"));
const hill = (extra: Record<string, unknown> = {}) => {
  const r = parseContract({ ...smoke, ...extra });
  assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
  return r.contract as HillClimbContract;
};

describe("metric plan (goal 209)", () => {
  test("a contract written before reads into the plan as it was judged, and keeps its hash", () => {
    const c = hill({
      objective: {
        primary: { metric: "flops_per_s", direction: "max", min_effect: 0.1 },
        secondary: [{ metric: "accuracy", direction: "max" }],
      },
      guards: [
        {
          metric: "accuracy",
          direction: "max",
          max_step_regression: 0.01,
          max_total_regression: 0.05,
        },
        {
          metric: "latency",
          direction: "min",
          max_step_regression: 0.02,
          max_total_regression: 0.1,
        },
      ],
      hard_constraints: [{ kind: "max", metric: "rss", value: 512 }],
      monitor_only: ["watts"],
    });
    assert.equal("metrics" in c, false, "no new field: its hash is the one it had");
    const p = metricPlan(c);
    assert.deepEqual(p.priorities, [
      { metric: "flops_per_s", direction: "max", min_effect: 0.1, priority: 1 },
      // No min_effect of its own: it breaks no tie, as before, when nothing promoted on it.
      { metric: "accuracy", direction: "max", min_effect: undefined, priority: 2 },
    ]);
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;
    const g = (m: string, against: string) =>
      p.guards.find((x) => x.metric === m && x.rule.against === against)?.rule;
    // A fall of 1% was to champion ÷ 1.01: at least the champion less 1/1.01 of 1%.
    assert.equal(g("accuracy", "champion")?.stay, "above");
    assert.ok(near(g("accuracy", "champion")?.by ?? 0, 0.01 / 1.01));
    assert.ok(near(g("accuracy", "baseline")?.by ?? 0, 0.05 / 1.05));
    // A metric lower is better may rise by its regression: at most the reference plus it.
    assert.deepEqual(g("latency", "champion"), { stay: "below", against: "champion", by: 0.02 });
    assert.deepEqual(g("rss", "value"), { stay: "below", against: "value", value: 512 });
    assert.deepEqual(p.info, [{ metric: "watts", kind: "info" }]);
    assert.deepEqual([...contractMetrics(c)].sort(), ["accuracy", "flops_per_s", "latency", "rss"]);
  });

  test("a kit names its metrics' kinds: the contract's primary, then the kit's priorities, guards and the rest informational", () => {
    const kit = kitOf(roles);
    assert.ok(kit.success, kit.success ? "" : JSON.stringify(kit.error.issues));
    const c = hill({
      objective: { primary: { metric: "decode_tps", direction: "max", min_effect: 0.02 } },
    });
    const p = metricPlan(c, kit.data.metrics);
    assert.deepEqual(
      p.priorities.map((x) => [x.metric, x.priority, x.min_effect]),
      [
        ["decode_tps", 1, 0.02],
        ["prefill_tps", 2, 0.01],
      ],
    );
    assert.deepEqual(
      p.guards.map((x) => [x.metric, guardWords(x.rule), x.from]),
      [
        ["perplexity", "within 3 standard deviations of the baseline", "kit"],
        ["peak_gib", "at most 5% above the baseline", "kit"],
      ],
    );
    assert.deepEqual(p.info, [
      { metric: "itl_ms", kind: "info" },
      { metric: "power_w", kind: "info" },
    ]);
    // The judge needs every deciding metric in every run, the kit's guards too.
    assert.deepEqual([...contractMetrics(c, kit.data)].sort(), [
      "decode_tps",
      "peak_gib",
      "perplexity",
      "prefill_tps",
    ]);
  });

  test("a campaign tightens a kit's guard and adds its own, but never loosens one", () => {
    const kit = kitOf(roles);
    assert.ok(kit.success);
    const k = kit.data;
    const tighter = hill({
      target: { type: "cuda-gpu", class: "gb10" },
      cells: ["small"],
      held_out_cells: [],
      objective: { primary: { metric: "decode_tps", direction: "max", min_effect: 0.02 } },
      metrics: {
        perplexity: { guards: [{ stay: "within", against: "baseline", by: 2 }] },
        prefill_tps: { guards: [{ stay: "above", against: "champion", by: 0.03 }] },
      },
    });
    assert.deepEqual(kitProblems(tighter, k), []);
    const p = metricPlan(tighter, k.metrics);
    assert.deepEqual(
      p.guards.filter((g) => g.from === "contract").map((g) => [g.metric, guardWords(g.rule)]),
      [
        ["perplexity", "within 2 standard deviations of the baseline"],
        ["prefill_tps", "at most 3% below the champion"],
      ],
    );
    const looser = hill({
      ...tighter,
      metrics: { perplexity: { guards: [{ stay: "within", against: "baseline", by: 4 }] } },
    });
    assert.deepEqual(kitProblems(looser, k), [
      "the guard on perplexity, within 4 standard deviations of the baseline, is looser than the kit's, within 3 standard deviations of the baseline: a campaign may tighten a kit's guard, never loosen it",
    ]);
    const unknown = hill({ ...tighter, metrics: { joules: { kind: "info" } } });
    assert.deepEqual(kitProblems(unknown, k), [
      "metrics names metric joules, which the kit does not have",
    ]);
  });

  test("a kit's or a contract's role that can't be judged is refused in words", () => {
    const bad = kitOf({
      a: { unit: "x/s", work: "tokens", kind: "priority", priority: 1, direction: "max" },
      b: {
        unit: "x/s",
        work: "tokens",
        kind: "priority",
        priority: 1,
        direction: "max",
        min_effect: 0.1,
      },
      c: { unit: "ms", from: "check", field: "c", kind: "guard" },
      d: {
        unit: "ms",
        from: "check",
        field: "d",
        guards: [{ stay: "within", against: "value", value: 3 }],
      },
      e: {
        unit: "ms",
        from: "check",
        field: "e",
        guards: [{ stay: "below", against: "champion" }],
      },
      f: { unit: "ms", from: "check", field: "f", kind: "info", direction: "min" },
    });
    assert.equal(bad.success, false);
    const said = bad.success ? [] : bad.error.issues.map((i) => i.message);
    for (const m of [
      "metric a is the primary metric: give its min_effect, the smallest gain that counts",
      "b and a are both priority 1: give each its own place",
      "metric c is a guard metric: give its guards, each where it must stay",
      "metric d, guard 1: within is against the baseline or the champion, which have a spread",
      "metric e, guard 1: give by, how far it may move, as a fraction",
      "metric f: direction is for a priority metric, and its kind is info",
    ])
      assert.ok(said.includes(m), `${m}\nnot in:\n${said.join("\n")}`);
    const first = parseContract({
      ...smoke,
      metrics: { accuracy: { kind: "priority", priority: 1, direction: "max", min_effect: 0.1 } },
    });
    assert.equal(first.ok, false);
    assert.match(
      first.ok ? "" : first.errors.join("\n"),
      /priority 1 is the objective's primary, flops_per_s/,
    );
    const both = parseContract({
      ...smoke,
      objective: { ...smoke.objective, secondary: [{ metric: "a", direction: "max" }] },
      metrics: { b: { kind: "priority", priority: 2, direction: "max", min_effect: 0.1 } },
    });
    assert.equal(both.ok, false);
    assert.match(
      both.ok ? "" : both.errors.join("\n"),
      /objective.secondary, or metrics with kind priority, not both/,
    );
  });

  test("a guard in words", () => {
    assert.equal(
      guardWords({ stay: "above", against: "champion", by: 0.03 }),
      "at most 3% below the champion",
    );
    assert.equal(guardWords({ stay: "below", against: "value", value: 100 }), "at most 100");
    assert.equal(
      guardWords({ stay: "above", against: "baseline", by: 0 }),
      "at least the baseline",
    );
  });
});
