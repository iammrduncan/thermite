import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type GoalCellValues, parseGoalValues } from "../../../src/core/goal/index.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { goalReport } from "../../../src/harness/agents/scheduler/goal.ts";
import {
  CHECK_NUMBERS_MAX,
  runValues,
  valuesText,
} from "../../../src/harness/judge/goal-values.ts";
import type { ArmRun } from "../../../src/harness/judge/measure.ts";
import { controlStack, signIn } from "../../helpers/control-stack.ts";
import { FAST_KERNEL, makeJudgeEnv, WRONG_KERNEL } from "../../helpers/judge-env.ts";

/**
 * Goal 086: a goal report keeps what a code verifier's goal measured. Each public cell's values
 * are in the report, its event, the goal's reasons and the dashboard, met or unmet; a held-out
 * cell's values are nowhere. And a confirmation queued for an earlier champion is a first
 * validation of the new one, never the second of two.
 */

/** A held-out case whose values must never reach a report, an event, an agent or a page. */
const HIDDEN = "zz-hidden-5";
/** The test kit's check reports the sum it read as `value`: on HIDDEN (n = 7) that is 21. */
const HIDDEN_SUM = /"sum":21[,}]|sum 21\.0000/;

const KIT = {
  kitCells: {
    small: { n: 20000000, work: 20000000 },
    // The seed idles 4 s on this case and is stopped at 3; a change without the idle passes.
    quick: { params: { n: 200000000, work: 200000000 }, timeout_s: 3 },
    [HIDDEN]: { n: 7, work: 7 },
  },
  kitMetrics: {
    ops_per_s: { unit: "op/s", work: "work" },
    sum: { unit: "", from: "check", field: "value" },
  },
  kitVerifiers: {
    correctness: { cells: ["small"] },
    speedy: { cells: ["small", "quick", HIDDEN] },
  },
};

const GOALS = [
  {
    id: "correct",
    description: "still correct",
    verify: { type: "code", verifier: "correctness" },
  },
  { id: "speedy", description: "every case in time", verify: { type: "code", verifier: "speedy" } },
];

async function setup(contract: Record<string, unknown> = {}) {
  const env = makeJudgeEnv({
    realRuns: true,
    goal: { opsPerSecond: 1 },
    ...KIT,
    contract: { goals: GOALS, held_out_cells: [HIDDEN], ...contract },
  });
  const out = await env.service.applyCommand(env.assign);
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const submit = async (kernel: string, hypothesis: string) =>
    (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(kernel), hypothesis, known_flaws: [] },
        "proposer",
      )
    ).attempt;
  // Control, reached through the supervisor's relay as on a rig.
  const { control, relay, api } = controlStack({ env });
  const rest = async (path: string) => (await api("GET", path)).text();
  const { page } = await signIn(control);
  const events = (kind?: string) =>
    env.ledger.eventsAfter(0, 100_000).events.filter((e) => !kind || e.kind === kind);
  /** The goal reports of the run, oldest first. */
  const reports = () =>
    events("goal_report").map(
      (e) =>
        e.body as {
          champion_seq: number;
          complete: boolean;
          confirming?: boolean;
          goals: { goal: string; status: string; reasons: string; values?: GoalCellValues[] }[];
        },
    );
  const checks = (attempt: string | null) =>
    env.ledger.db
      .prepare(
        `select goal, result, detail from goal_check where ${attempt ? "attempt = ?" : "attempt is null"} order by id`,
      )
      .all(...(attempt ? [attempt] : [])) as { goal: string; result: string; detail: string }[];
  return { ...env, submit, relay, rest, page, events, reports, checks };
}

describe("a goal report keeps what it measured (goal 086)", () => {
  test("a code goal's values: kept for met and unmet goals, in the report, its event, the reasons and the dashboard; never a held-out case's", async () => {
    const env = await setup();
    await env.drain(); // validates the seed: correct is met, speedy is not (quick times out)
    const [seed] = env.reports();
    assert.ok(seed, env.explain(""));
    assert.equal(seed.complete, false);
    const correct = seed.goals.find((g) => g.goal === "correct");
    const speedy = seed.goals.find((g) => g.goal === "speedy");
    // A met code goal keeps each public case's values, read as a threshold goal's are.
    assert.equal(correct?.status, "met");
    assert.match(
      String(correct?.reasons),
      /^verifier correctness passed on small: small: ops_per_s \d\.\d{5}e\+\d+, sum 6\.00000e\+7$/,
    );
    assert.deepEqual(
      correct?.values?.map((v) => [v.cell, v.ok, Object.keys(v.metrics), v.metrics.sum]),
      [["small", true, ["ops_per_s", "sum"], 59999997]],
    );
    assert.ok(Number(correct?.values?.[0]?.metrics.ops_per_s) > 0);
    // An unmet one keeps the values of the cases that gave some; a run stopped for time gives none.
    assert.equal(speedy?.status, "unmet");
    assert.match(
      String(speedy?.reasons),
      /^quick: crash: killed: timeout; measured: small: ops_per_s \S+, sum 6\.00000e\+7$/,
    );
    assert.deepEqual(
      speedy?.values?.map((v) => v.cell),
      ["small"],
    );
    // The goal tree's record has the same words.
    assert.match(
      String(env.checks(null).find((c) => c.goal === "correct")?.detail),
      /passed on small: small: ops_per_s /,
    );

    // A change the kit's check refuses: the numbers the check reported for its metrics.
    const wrong = await env.submit(WRONG_KERNEL, "return early");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(wrong)?.verdict, "regress", env.explain(wrong));
    assert.match(
      String(env.checks(wrong).find((c) => c.goal === "correct")?.detail),
      /^small: invalid: wrong result 60000000, expected 59999997; measured: small: sum 6\.00000e\+7$/,
    );

    // A change that meets speedy: confirmed, with its held-out case, then promoted and validated.
    const fast = await env.submit(FAST_KERNEL, "drop the idle");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(fast)?.verdict, "goal_progress", env.explain(fast));
    assert.equal(env.ledger.runs.get("js-1")?.status, "closed");
    const held = env.events("held_out_checked").find((e) => e.subject === fast);
    assert.ok(held, env.explain(fast));
    assert.deepEqual((held.body as { cells: unknown[] }).cells, [
      { cell: HIDDEN, verifier: "speedy", ok: true },
    ]);
    // The champion's second validation ran the held-out case too, and it passed (goal 086).
    const championHeld = env.events("held_out_checked").filter((e) => e.subject === "js-1");
    assert.deepEqual(
      championHeld.map((e) => [
        (e.body as { champion_seq: number }).champion_seq,
        (e.body as { pass: boolean }).pass,
        (e.body as { cells: unknown[] }).cells,
      ]),
      [[2, true, [{ cell: HIDDEN, verifier: "speedy", ok: true }]]],
    );
    const last = env.reports().at(-1);
    assert.equal(last?.complete, true);
    const met = last?.goals.find((g) => g.goal === "speedy");
    assert.equal(met?.status, "met");
    assert.deepEqual(
      met?.values?.map((v) => [v.cell, v.ok]),
      [
        ["small", true],
        ["quick", true],
      ],
    );
    assert.match(
      String(met?.reasons),
      /^verifier speedy passed on small, quick: small: ops_per_s \S+, sum 6\.00000e\+7; quick: ops_per_s \S+, sum 6\.00000e\+8$/,
    );

    // The held-out case's values are nowhere: no report, event, goal check or agent's view. Only
    // the owner's events name it (its held-out check, and how each goal is checked).
    for (const e of env.events()) {
      const text = JSON.stringify(e.body);
      assert.doesNotMatch(text, HIDDEN_SUM, `${e.kind} holds the held-out case's values`);
      if (e.kind !== "held_out_checked" && e.kind !== "goal_checks")
        assert.ok(!text.includes(HIDDEN), `${e.kind} names the held-out case`);
    }
    // The rig's own held-out record keeps names and kinds only.
    for (const r of env.ledger.db.prepare("select detail from held_out").all())
      assert.doesNotMatch(String(r.detail), HIDDEN_SUM);
    for (const c of [...env.checks(null), ...env.checks(wrong), ...env.checks(fast)]) {
      assert.doesNotMatch(c.detail, HIDDEN_SUM);
      assert.ok(!c.detail.includes(HIDDEN), `a goal check names the held-out case: ${c.detail}`);
    }
    // What the planner and the workers get of the goal report: public values, never held-out.
    const forAgents = goalReport(env.ledger, "js-1", env.ledger.champions.current("js-1").seq);
    const agentViews = {
      goal_report: JSON.stringify(forAgents),
      evidence: JSON.stringify(new Registry(env.ledger).evidence("js-1")),
      teachers: JSON.stringify(env.service.brief("js-1")),
      status: JSON.stringify(env.service.attemptStatus(fast)),
    };
    assert.match(
      agentViews.goal_report,
      /verifier speedy passed on small, quick: small: ops_per_s/,
    );
    for (const [where, text] of Object.entries(agentViews)) {
      assert.doesNotMatch(text, HIDDEN_SUM, `${where} holds the held-out case's values`);
      assert.ok(!text.includes(HIDDEN), `${where} names the held-out case`);
    }

    // Control: the run's Goals block shows each goal's reasons with its values, met or not; REST
    // gives the values. The held-out case's values are not there either.
    await env.relay();
    const view = await env.rest("/v1/rigs/rig-a/view");
    assert.doesNotMatch(view, HIDDEN_SUM);
    const run = (
      JSON.parse(view) as {
        runs: { id: string; goals: { goal: string; values: GoalCellValues[] | null }[] }[];
      }
    ).runs.find((r) => r.id === "js-1");
    assert.deepEqual(
      run?.goals.map((g) => [g.goal, g.values?.map((v) => v.cell) ?? null]),
      [
        ["correct", ["small"]],
        ["speedy", ["small", "quick"]],
      ],
    );
    const runPage = await env.page("/ui/campaigns/js-goal/runs/js-1");
    assert.doesNotMatch(runPage, HIDDEN_SUM);
    assert.match(
      runPage,
      /<b>correct<\/b><\/span><div class="muted">still correct<\/div><div class="gl-why ok">verifier correctness passed on small: small: ops_per_s \S+, sum 6\.00000e\+7<\/div>/,
    );
    assert.match(
      runPage,
      /<div class="gl-why ok">verifier speedy passed on small, quick: small: ops_per_s \S+, sum 6\.00000e\+7; quick: ops_per_s \S+, sum 6\.00000e\+8<\/div>/,
    );
  });

  test("a confirmation queued for an earlier champion is a first validation of the champion now", async () => {
    const env = await setup({ goals: [GOALS[0]] });
    // As when a promotion came between a validation that met every goal and its confirmation.
    env.ledger.jobs.enqueue({
      kind: "validate",
      priority: 40,
      spec: { run: "js-1", champion_seq: 7, confirm: true },
      actor: "t",
    });
    assert.ok(await env.judge.tick());
    assert.equal(env.ledger.runs.get("js-1")?.status, "running", "one validation never closes it");
    assert.equal(env.reports()[0]?.confirming, true);
    const confirm = env.ledger.db
      .prepare(
        "select json_extract(spec, '$.champion_seq') as seq from job where kind = 'validate' and state = 'queued'",
      )
      .all();
    assert.deepEqual(
      confirm.map((r) => Number(r.seq)),
      [1],
    );
    await env.drain();
    assert.equal(env.ledger.runs.get("js-1")?.status, "closed");
    assert.equal(env.events("goal_complete").length, 1);
    // The contract has a held-out case, but no goal met has it: nothing to check (goal 086).
    assert.equal(env.events("held_out_checked").length, 0);
  });
});

describe("a code goal's values", () => {
  const kit = {
    metrics: {
      ops_per_s: { unit: "op/s", work: "work" },
      seconds: { unit: "s", from: "time" as const },
      ratio: { unit: "", from: "check" as const, field: "ratio" },
    },
  };
  const ok = (metrics: Record<string, number>, details: Record<string, unknown> = {}) =>
    ({ kind: "ok", metrics, check: { pass: true, reasons: [], details } }) as unknown as ArmRun;
  const invalid = (failure: string, details: Record<string, unknown>) =>
    ({
      kind: "invalid",
      failure,
      reason: "x",
      check: { pass: false, reasons: [], details },
    }) as unknown as ArmRun;

  test("a run that passed gives every metric; a refused one, the numbers its check reported; a crash, none", () => {
    assert.deepEqual(runValues(kit, ok({ ops_per_s: 2e7, seconds: 0.5, ratio: 1.0021 })), {
      ops_per_s: 2e7,
      seconds: 0.5,
      ratio: 1.0021,
    });
    // The kit's metrics taken from the check, then the check's other numbers by their names.
    assert.deepEqual(runValues(kit, invalid("check", { ratio: 1.07, note: 3, other: "x" })), {
      ratio: 1.07,
      note: 3,
    });
    assert.deepEqual(runValues(kit, invalid("check", { ratio: "1.07" })), {});
    assert.deepEqual(runValues(kit, invalid("outputs", {})), {});
    assert.deepEqual(
      runValues(kit, { kind: "crash", failure: "timeout", reason: "", outcome: {} } as never),
      {},
    );
  });

  test("a kit with no metrics: the numbers each cell's check reported, by their names", () => {
    const none = { metrics: {} };
    // A cell whose check failed: by how much (a ratio, and both sides of it).
    assert.deepEqual(
      runValues(
        none,
        invalid("check", {
          pass: false,
          reasons: ["over 1.005"],
          ppl_a1: 5.65357,
          ppl_pn3: 6.07793,
          ratio: 1.0751,
          prompt: "prose-32k",
          extra: { nested: 1 },
          bad: Number.NaN,
        }),
      ),
      { ppl_a1: 5.65357, ppl_pn3: 6.07793, ratio: 1.0751 },
    );
    // A cell that passed: its counts too; flags and lists are not numbers.
    assert.deepEqual(
      runValues(none, ok({}, { recalled: 8, depths: 8, exact: true, lost: ["c3"] })),
      { recalled: 8, depths: 8 },
    );
    // At most CHECK_NUMBERS_MAX of them a cell.
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`n${i}`, i + 1]));
    assert.equal(Object.keys(runValues(none, ok({}, wide))).length, CHECK_NUMBERS_MAX);
    // A kit metric that reads a field keeps it under the metric's name, not twice.
    assert.deepEqual(runValues(kit, invalid("check", { ratio: 1.07 })), { ratio: 1.07 });
  });

  test("in words as a threshold goal gives its own; at most 100 cases, and how many more", () => {
    assert.equal(
      valuesText([
        { cell: "a", ok: true, metrics: { ratio: 1.00213, ops_per_s: 45123456 } },
        { cell: "b", ok: false, metrics: { ratio: 1.07 } },
      ]),
      "a: ratio 1.00213, ops_per_s 4.51235e+7; b: ratio 1.07000",
    );
    const many = Array.from({ length: 103 }, (_, i) => ({
      cell: `c${i}`,
      ok: true,
      metrics: { x: i + 1 },
    }));
    assert.match(valuesText(many), /; c99: x 100; and 3 more cells$/);
  });

  test("read back from a report, each field checked", () => {
    assert.equal(parseGoalValues(undefined), null);
    assert.equal(parseGoalValues([]), null);
    assert.deepEqual(
      parseGoalValues([
        { cell: "a", ok: true, metrics: { x: 1, y: "2", z: null } },
        { cell: 3, metrics: { x: 1 } },
        "junk",
        { cell: "b", metrics: { x: 2 } },
      ]),
      [
        { cell: "a", ok: true, metrics: { x: 1 } },
        { cell: "b", ok: false, metrics: { x: 2 } },
      ],
    );
  });
});
