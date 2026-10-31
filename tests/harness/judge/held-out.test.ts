import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  HELD_OUT_INFRA,
  HELD_OUT_KINDS,
  heldOutCellsOf,
  heldOutKindOf,
  heldOutKinds,
  heldOutMeasure,
  heldOutWords,
  meetsThreshold,
} from "../../../src/harness/judge/held-out.ts";
import type { ArmRun } from "../../../src/harness/judge/measure.ts";
import {
  AGENT_TOKEN,
  CELLS,
  CRASHES_HIDDEN,
  HIDDEN,
  HIDDEN_PARAM,
  noContent,
  READ_TOKEN,
  SLOW_ON_HIDDEN,
  setup,
} from "../../helpers/held-out-env.ts";
import { FAST_KERNEL } from "../../helpers/judge-env.ts";

/**
 * Goal 082: a confirmation that fails on its held-out cells is named safely. The owner sees each
 * held-out case's name, kind and value against its threshold (the held_out record, its event,
 * control's pages, REST and MCP); the agents see only that a held-out check failed and its kind.
 * No one gets a held-out case's inputs, outputs or texts.
 */

describe("held-out failures, named safely (goal 082)", () => {
  test("a hill climb's held-out crash and regression: the owner sees the case and kind, the agents the kind", async () => {
    const env = await setup({
      kitCells: CELLS,
      contract: { held_out_cells: [HIDDEN] },
    });
    const crash = await env.submit(CRASHES_HIDDEN, "drop the waste, crash on one size");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(crash)?.verdict, "not_confirmed", env.explain(crash));
    // The agents' words: that a held-out check crashed, and the measured cells' own figures.
    assert.match(
      env.reasons(crash),
      /^confirmation failed: a held-out check crashed; on the measured cells: .*; vs champion seq 1$/,
    );
    const slow = await env.submit(SLOW_ON_HIDDEN, "drop the waste, idle on one size");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(slow)?.verdict, "not_confirmed", env.explain(slow));
    assert.match(env.reasons(slow), /^confirmation failed: a held-out check missed its threshold;/);
    assert.equal(env.ledger.champions.current("js-1").seq, 1);

    // The record and the owner's event: the case, its kind, and the ratio against its threshold.
    const record = env.ledger.db
      .prepare("select attempt, pass, detail from held_out order by id")
      .all()
      .map((r) => ({
        attempt: r.attempt,
        pass: r.pass,
        cells: heldOutCellsOf(JSON.parse(String(r.detail))),
      }));
    assert.deepEqual(record[0], {
      attempt: crash,
      pass: 0,
      cells: [{ cell: HIDDEN, ok: false, kind: "crashed" }],
    });
    const slowCell = record[1]?.cells[0];
    assert.equal(slowCell?.kind, "threshold_missed");
    assert.equal(slowCell?.op, ">");
    assert.ok(Math.abs(Number(slowCell?.threshold) - 1 / 1.01) < 1e-9, String(slowCell?.threshold));
    assert.ok(Number(slowCell?.value) < Number(slowCell?.threshold), String(slowCell?.value));
    const ev = env.ledger
      .eventsAfter(0, 100_000)
      .events.filter((e) => e.kind === "held_out_checked");
    assert.equal(ev[0]?.subject, crash);
    assert.deepEqual(
      { ...(ev[0]?.body as object), job: 0 },
      {
        run: "js-1",
        job: 0,
        pass: false,
        cells: [{ cell: HIDDEN, ok: false, kind: "crashed" }],
        cells_total: 1,
      },
    );

    // The agents: the kind in words, never the case, its input or its output.
    for (const id of [crash, slow]) {
      const views = env.agentViews(id);
      for (const [where, text] of Object.entries(views)) {
        noContent(text, where);
        assert.ok(!text.includes(HIDDEN), `${where} names the hidden case`);
      }
      noContent(env.reasons(id), "the verdict's reasons");
      assert.ok(!env.reasons(id).includes(HIDDEN), "the verdict's reasons name the hidden case");
    }
    const views = env.agentViews(crash);
    assert.match(views.status, /"held_out":"a held-out check crashed"/);
    assert.match(views.evidence, /"held_out":"a held-out check crashed"/);
    assert.match(views.teachers, /"held_out":"a held-out check missed its threshold"/);
    // No event carries the hidden case's input or output; only the owner's event names it.
    noContent(env.events(), "the events");
    for (const e of env.ledger.eventsAfter(0, 100_000).events)
      if (e.kind !== "held_out_checked")
        assert.ok(!JSON.stringify(e.body).includes(HIDDEN), `${e.kind} names the hidden case`);

    // Control: the owner's page, REST and MCP show the case and its kind; still no content.
    await env.relay();
    const view = await env.rest("/v1/rigs/rig-a/view");
    noContent(view, "REST's rig view");
    const run = JSON.parse(view).runs[0] as {
      attempts: {
        id: string;
        held_out: { pass: boolean; cells: { cell: string; kind: string }[] };
      }[];
    };
    const owner = run.attempts.find((a) => a.id === crash)?.held_out;
    assert.equal(owner?.pass, false);
    assert.deepEqual(
      owner?.cells.map((c) => [c.cell, c.kind]),
      [[HIDDEN, "crashed"]],
    );
    const viaMcp = await env.mcp("get_run", { run: "js-1" });
    noContent(viaMcp, "MCP's get_run");
    const slowHeld = (
      JSON.parse(viaMcp) as {
        attempts: { id: string; held_out: { cells: Record<string, unknown>[] } }[];
      }
    ).attempts.find((a) => a.id === slow)?.held_out.cells[0];
    assert.equal(slowHeld?.cell, HIDDEN);
    assert.equal(slowHeld?.kind, "threshold_missed");
    assert.ok(Number(slowHeld?.value) < Number(slowHeld?.threshold), JSON.stringify(slowHeld));
    // The agent token over MCP: each held-out check as its kinds, never a case, value or
    // threshold; its events too. The reader keeps the owner's view (goal 082).
    for (const [tool, args] of [
      ["get_run", { run: "js-1" }],
      ["recent_events", { rig: "rig-a", limit: 500 }],
    ] as const) {
      const text = await env.mcp(tool, args, AGENT_TOKEN);
      noContent(text, `the agent's ${tool}`);
      assert.ok(!text.includes(HIDDEN), `the agent's ${tool} names the hidden case`);
      assert.doesNotMatch(text, /"threshold"|"value":0\.|"measure"/, `the agent's ${tool}`);
      assert.match(
        text,
        /"kinds":\s*\[\s*"threshold_missed"\s*\],\s*"words":\s*"a held-out check missed its threshold"/,
        tool,
      );
    }
    const agentRun = JSON.parse(await env.mcp("get_run", { run: "js-1" }, AGENT_TOKEN)) as {
      attempts: { id: string; held_out: unknown }[];
    };
    // The whole timeline, one list (goal 128: get_run gives each list's newest entries).
    const timeline = (
      JSON.parse(
        await env.mcp("get_run", { run: "js-1", list: "timeline", limit: 500 }, AGENT_TOKEN),
      ) as { entries: { kind: string; body: unknown }[] }
    ).entries;
    assert.deepEqual(
      { ...(agentRun.attempts.find((a) => a.id === slow)?.held_out as object), at: "" },
      {
        at: "",
        pass: false,
        kinds: ["threshold_missed"],
        words: "a held-out check missed its threshold",
      },
    );
    assert.deepEqual(
      timeline.filter((e) => e.kind === "held_out_checked").map((e) => e.body),
      [
        { run: "js-1", pass: false, kinds: ["crashed"], words: "a held-out check crashed" },
        {
          run: "js-1",
          pass: false,
          kinds: ["threshold_missed"],
          words: "a held-out check missed its threshold",
        },
      ],
    );
    const viaReader = await env.mcp("get_run", { run: "js-1" }, READ_TOKEN);
    assert.ok(viaReader.includes(HIDDEN), "the reader keeps the owner's view");
    noContent(viaReader, "the reader's get_run");
    const attemptPage = await env.page(`/ui/campaigns/js-sum/runs/js-1/attempts/${slow}`);
    noContent(attemptPage, "the attempt's page");
    assert.match(attemptPage, /<h2>Held-out checks<\/h2><span class="n">1 failed<\/span>/);
    assert.match(
      attemptPage,
      new RegExp(
        `<td><code>${HIDDEN}</code></td><td>no worse than the champion</td><td><span class="chip bad">missed its threshold</span></td><td>0\\.\\d+<div class="muted small">ops_per_s, the change's median over the champion's</div></td><td>&gt; 0\\.9901</td>`,
      ),
    );
    const history = await env.page("/ui/campaigns/js-sum/runs/js-1/history");
    assert.match(history, new RegExp(`failed its held-out check: ${HIDDEN} crashed\\.`));
  });

  test("a goal's held-out threshold: the case, its value and threshold for the owner; the kind for the agents", async () => {
    const env = await setup({
      goal: { opsPerSecond: 70e6 },
      kitCells: CELLS,
      contract: {
        held_out_cells: [HIDDEN],
        threshold_reps: 3,
        goals: [
          {
            id: "fast",
            description: "fast enough",
            verify: {
              type: "metric_threshold",
              metric: "ops_per_s",
              op: ">=",
              value: 70e6,
              cells: ["big", HIDDEN],
            },
          },
          {
            id: "correct",
            description: "still correct",
            verify: { type: "code", verifier: "correctness" },
          },
        ],
      },
    });
    await env.drain(); // validates the seed
    const id = await env.submit(SLOW_ON_HIDDEN, "drop the waste, idle on one size");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(id)?.verdict, "not_confirmed", env.explain(id));
    assert.equal(
      env.reasons(id),
      "confirmation failed: a held-out check missed its threshold; vs champion seq 1",
    );
    const ev = env.ledger
      .eventsAfter(0, 100_000)
      .events.find((e) => e.kind === "held_out_checked" && e.subject === id);
    assert.ok(ev, env.explain(id));
    const cell = (ev.body as { cells: Record<string, unknown>[] }).cells[0] ?? {};
    assert.equal(cell.cell, HIDDEN);
    assert.equal(cell.goal, "fast");
    assert.equal(cell.kind, "threshold_missed");
    assert.equal(cell.op, ">=");
    assert.equal(cell.threshold, 70e6);
    assert.equal(cell.measure, "ops_per_s");
    assert.equal(cell.unit, "op/s");
    assert.ok(Number(cell.value) > 0 && Number(cell.value) < 70e6, String(cell.value));
    assert.ok(Number(cell.low) <= Number(cell.value) && Number(cell.value) <= Number(cell.high));
    // The hidden case never ran as a measurement, a goal check or a report.
    assert.equal(
      env.ledger.db.prepare("select count(*) as n from measurement where cell = ?").get(HIDDEN)?.n,
      0,
    );
    const views = env.agentViews(id);
    for (const [where, text] of Object.entries(views)) {
      noContent(text, where);
      assert.ok(!text.includes(HIDDEN), `${where} names the hidden case`);
    }
    assert.match(views.status, /"held_out":"a held-out check missed its threshold"/);
    noContent(env.events(), "the events");
    await env.relay();
    const page = await env.page(`/ui/campaigns/js-goal/runs/js-1/attempts/${id}`);
    assert.match(
      page,
      new RegExp(
        `<td><code>${HIDDEN}</code></td><td>goal <b>fast</b></td><td><span class="chip bad">missed its threshold</span></td>`,
      ),
    );
    assert.match(page, /&gt;= 7\.000e\+7 op\/s/);
    // The agent token: the goal's checks without the held-out case, which the owner sees.
    const owner = JSON.parse(await env.mcp("get_run", { run: "js-1" })) as {
      goal_checks: { goals: { goal: string; cells: { name: string }[] }[] };
    };
    assert.deepEqual(
      owner.goal_checks.goals.find((g) => g.goal === "fast")?.cells.map((c) => c.name),
      ["big", HIDDEN],
    );
    for (const [tool, args] of [
      ["get_run", { run: "js-1" }],
      ["recent_events", { rig: "rig-a", limit: 500 }],
    ] as const) {
      const text = await env.mcp(tool, args, AGENT_TOKEN);
      noContent(text, `the agent's ${tool}`);
      assert.ok(!text.includes(HIDDEN), `the agent's ${tool} names the hidden case`);
    }
    const agent = JSON.parse(await env.mcp("get_run", { run: "js-1" }, AGENT_TOKEN)) as {
      goal_checks: { goals: { goal: string; cells: { name: string }[] }[] };
    };
    assert.deepEqual(
      agent.goal_checks.goals.find((g) => g.goal === "fast")?.cells.map((c) => c.name),
      ["big"],
    );
  });
});

/** Fast and correct on every case but the hidden one, where it prints a marker and answers wrong. */
describe("a held-out pass the judge cannot finish (goal 082)", () => {
  test("its error reaches the agents in fixed words, never the case, its parameters or its time", async () => {
    const env = await setup({ kitCells: CELLS, contract: { held_out_cells: [HIDDEN] } });
    const id = await env.submit(FAST_KERNEL, "drop the waste");
    // Screen it: a win queues its confirmation.
    const confirming = () =>
      (
        env.ledger.db.prepare("select count(*) as n from job where kind = 'confirm'").get() as {
          n: number;
        }
      ).n;
    for (let i = 0; i < 20 && !confirming(); i++) await env.judge.tick();
    assert.equal(confirming(), 1, env.explain(id));
    // The rig's copy of the kit loses the rate's parameter on the held-out case only, as a kit
    // checked before the kit check refused that could: each held-out run then throws, with the
    // parameters and the run's time in its words.
    const file = join(env.paths.stateDir, "kits", env.kitCommit, "kit.json");
    chmodSync(file, 0o644);
    const kit = JSON.parse(readFileSync(file, "utf8")) as { cells: Record<string, unknown> };
    kit.cells[HIDDEN] = { n: 15000000, salt: HIDDEN_PARAM };
    writeFileSync(file, JSON.stringify(kit));
    await env.drain();
    // An infrastructure failure, retried once, never a research loss; its reasons fixed words.
    const verdicts = env.ledger.db
      .prepare("select verdict, reasons from verdict where attempt = ? and verdict = 'crash_infra'")
      .all(id) as { verdict: string; reasons: string }[];
    assert.equal(verdicts.length, 2, env.explain(id));
    for (const v of verdicts) assert.equal(v.reasons, HELD_OUT_INFRA);
    // Nowhere an agent or Live reads: the case, its parameters, or the throw's words and time.
    const live = JSON.stringify(env.service.live.since(0, 100_000));
    const jobs = JSON.stringify(env.ledger.db.prepare("select result from job").all());
    for (const [where, text] of Object.entries({
      ...env.agentViews(id),
      reasons: env.reasons(id),
      events: env.events(),
      live,
      jobs,
    })) {
      noContent(text, where);
      assert.ok(!text.includes(HIDDEN), `${where} names the hidden case`);
      assert.ok(!/bad work|or time \d/.test(text), `${where} holds the error's own words`);
    }
    assert.match(live, /could not finish \(an infrastructure failure\)/);
  });
});

describe("held-out kinds", () => {
  const run = (failure: string, kind: "crash" | "invalid") =>
    ({ kind, failure, reason: "secret text", outcome: {} }) as unknown as Exclude<
      ArmRun,
      { kind: "ok" }
    >;

  test("each way a run fails maps to one kind, never from its text", () => {
    assert.equal(heldOutKindOf(run("timeout", "crash")), "timed_out");
    for (const f of ["memory", "disk", "exit"])
      assert.equal(heldOutKindOf(run(f, "crash")), "crashed");
    assert.equal(heldOutKindOf(run("outputs", "invalid")), "check_failed");
    assert.equal(heldOutKindOf(run("check", "invalid")), "check_failed");
    assert.equal(heldOutKindOf(run("metric", "invalid")), "non_finite");
  });

  test("the agents' words: each kind once, in a fixed order; an old record says only that it failed", () => {
    const cells = [
      { cell: "a", ok: false, kind: "timed_out" as const },
      { cell: "b", ok: true },
      { cell: "c", ok: false, kind: "threshold_missed" as const },
      { cell: "d", ok: false, kind: "timed_out" as const },
    ];
    assert.deepEqual(heldOutKinds(cells), ["threshold_missed", "timed_out"]);
    assert.equal(
      heldOutWords(heldOutKinds(cells)),
      "a held-out check missed its threshold; a held-out check timed out",
    );
    assert.equal(heldOutWords([]), "a held-out check failed");
    // A record from before goal 082 kept {cell: {ratio, ok}}: it has no cells to read.
    assert.deepEqual(heldOutCellsOf({ held: { ratio: 0.5, ok: false } }), []);
    for (const k of HELD_OUT_KINDS) assert.match(heldOutWords([k]), /^a held-out check /);
  });

  test("a held-out ratio says which way it was taken: above 1 is better in both directions", () => {
    assert.equal(
      heldOutMeasure("ops_per_s", "max"),
      "ops_per_s, the change's median over the champion's",
    );
    assert.equal(
      heldOutMeasure("latency_ms", "min"),
      "latency_ms, the champion's median over the change's (lower is better)",
    );
  });

  test("a threshold's sides", () => {
    assert.ok(meetsThreshold(2, ">=", 2) && !meetsThreshold(2, ">", 2));
    assert.ok(meetsThreshold(2, "<=", 2) && !meetsThreshold(2, "<", 2));
  });
});
