import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Section, sectionsText } from "../../../../src/agents/prompt.ts";
import { brief as workerBrief } from "../../../../src/harness/agents/scheduler/briefs.ts";
import type { SchedulerContext } from "../../../../src/harness/agents/scheduler/context.ts";
import {
  goalReport as agentsGoalReport,
  waitingForConfirmation,
} from "../../../../src/harness/agents/scheduler/goal.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { heldOutCellsOf } from "../../../../src/harness/judge/held-out.ts";
import {
  AGENT_TOKEN,
  HIDDEN,
  HIDDEN_PARAM,
  HIDDEN_STDERR,
  noContent,
  setup,
} from "../../../helpers/held-out-env.ts";
import { FAST_KERNEL } from "../../../helpers/judge-env.ts";

/**
 * Goal 086: the champion's held-out check. The second validation runs the held-out cases of every
 * goal the champion meets; the agents read only the kind of a failure. Moved out of
 * tests/harness/judge/held-out.test.ts, whose setup is in tests/helpers/held-out-env.ts.
 */

const WRONG_ON_HIDDEN = `import { writeSync } from "node:fs";
export function work(n) {
  if (n === 15000000) {
    writeSync(2, "${HIDDEN_STDERR}: the input was ${HIDDEN_PARAM}\\n");
    return -1;
  }
  let s = 0;
  for (let i = 0; i < n; i++) s += i % 7;
  return s;
}
`;

/**
 * A goal run whose goals the seed half meets: `correct` (met by the seed) has the hidden case,
 * `speedy` (not met: the seed idles 4 s on `quick`, stopped at 3) has none. A change that gains
 * `speedy` is confirmed on `speedy`'s held-out cases only, which are none.
 */
const CHAMPION_RUN = {
  goal: { opsPerSecond: 1 },
  kitCells: {
    small: { n: 20000000, work: 20000000 },
    quick: { params: { n: 200000000, work: 200000000 }, timeout_s: 3 },
    [HIDDEN]: { n: 15000000, work: 15000000, salt: HIDDEN_PARAM },
  },
  kitVerifiers: {
    correctness: { cells: ["small", HIDDEN] },
    speedy: { cells: ["small", "quick"] },
  },
  contract: {
    held_out_cells: [HIDDEN],
    goals: [
      {
        id: "correct",
        description: "still correct",
        verify: { type: "code", verifier: "correctness" },
      },
      {
        id: "speedy",
        description: "every case in time",
        verify: { type: "code", verifier: "speedy" },
      },
    ],
  },
};

describe("the champion's held-out check (goal 086)", () => {
  test("the second validation runs the held-out cases of every goal met: one fails, the run goes on and the agents read its kind; a change that passes it closes the run", async () => {
    const env = await setup(CHAMPION_RUN);
    await env.drain(); // the seed: correct is met, speedy is not
    const first = await env.submit(WRONG_ON_HIDDEN, "drop the idle, wrong on one size");
    const confirming = () =>
      Number(
        (
          env.ledger.db
            .prepare(
              "select count(*) as n from job where kind = 'validate' and state in ('queued', 'leased') and json_extract(spec, '$.confirm') = 1",
            )
            .get() as { n: number }
        ).n,
      );
    for (let i = 0; i < 30 && !confirming(); i++) await env.judge.tick();
    // Its own confirmation checked the goal it gained, speedy, which has no held-out case.
    assert.equal(env.ledger.verdicts.current(first)?.verdict, "goal_progress", env.explain(first));
    assert.equal(env.ledger.champions.current("js-1").seq, 2);
    assert.equal(confirming(), 1, env.explain(first));
    // The lanes wait for the second validation.
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      owner: "s0",
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    const { sched } = scheduler as unknown as { sched: SchedulerContext };
    const inside = {
      waitingForConfirmation: (run: string) => waitingForConfirmation(sched, run),
      goalReport: (run: string, seq: number) => agentsGoalReport(env.ledger, run, seq),
      brief: (...args: unknown[]) =>
        (workerBrief as (...a: unknown[]) => Section[])(sched, ...args),
    };
    assert.equal(inside.waitingForConfirmation("js-1"), true);
    await env.drain();

    // A held-out case of correct failed: the run does not close, and the lanes go on.
    assert.equal(env.ledger.runs.get("js-1")?.status, "running", env.explain(first));
    const all = () => env.ledger.eventsAfter(0, 100_000).events;
    assert.equal(all().filter((e) => e.kind === "goal_complete").length, 0);
    assert.equal(inside.waitingForConfirmation("js-1"), false);
    const live = JSON.stringify(env.service.live.since(0, 100_000));
    assert.match(live, /trials start again: the judge's confirmation of champion #2 did not close/);

    // The owner's record: the case and its kind, by run and champion, never an attempt's.
    const records = () =>
      env.ledger.db
        .prepare("select attempt, run, champion_seq, pass, detail from held_out order by id")
        .all()
        .map((r) => ({
          attempt: r.attempt,
          run: r.run,
          champion_seq: r.champion_seq,
          pass: r.pass,
          cells: heldOutCellsOf(JSON.parse(String(r.detail))),
        }));
    const failedCell = { cell: HIDDEN, verifier: "correctness", ok: false, kind: "check_failed" };
    assert.deepEqual(records(), [
      { attempt: first, run: null, champion_seq: null, pass: 1, cells: [] },
      { attempt: null, run: "js-1", champion_seq: 2, pass: 0, cells: [failedCell] },
    ]);
    const checked = all().filter((e) => e.kind === "held_out_checked" && e.subject === "js-1");
    assert.deepEqual(
      checked.map((e) => ({ ...(e.body as object), job: 0 })),
      [{ run: "js-1", job: 0, champion_seq: 2, pass: false, cells: [failedCell], cells_total: 1 }],
    );

    // The goal report: correct is not confirmed, by its kind alone; the run is not complete.
    const report = all()
      .filter((e) => e.kind === "goal_report")
      .at(-1)?.body as {
      champion_seq: number;
      complete: boolean;
      confirming?: boolean;
      not_confirmed?: string;
      goals: { goal: string; status: string; reasons: string }[];
    };
    assert.equal(report.champion_seq, 2);
    assert.equal(report.complete, false);
    assert.equal(report.confirming, undefined);
    assert.equal(report.not_confirmed, "a held-out check failed the kit's check");
    const correct = report.goals.find((g) => g.goal === "correct");
    assert.equal(correct?.status, "unmet");
    assert.match(
      String(correct?.reasons),
      /^not confirmed: a held-out check failed the kit's check; on the measured cells: verifier correctness passed on small: small: ops_per_s \S+, value \S+$/,
    );
    assert.equal(report.goals.find((g) => g.goal === "speedy")?.status, "met");
    // The goal tree: correct is not met, so a change that meets it again is progress.
    assert.deepEqual(
      Object.fromEntries(
        env.ledger.db
          .prepare("select id, status from goal where run = 'js-1'")
          .all()
          .map((g) => [g.id, g.status]),
      ),
      { correct: "unmet", speedy: "verified" },
    );

    // The agents: the kind in the judge's words, never the case, its input, its output or the
    // check's words. The attempt's own held-out record passed, and still says so.
    const goalReport = JSON.stringify(inside.goalReport("js-1", 2));
    assert.match(goalReport, /"not_confirmed":"a held-out check failed the kit's check"/);
    const brief = sectionsText(
      inside.brief(
        "js-1",
        env.service.contractFor("js-1"),
        2,
        { lane: "lane-1", family: "f" },
        { title: "fix it", added_by: "planner" },
        1,
        1,
        "the champion",
      ),
    );
    assert.match(
      brief,
      /# What the champion meets \(the judge's check of champion #2\)\nThe judge did not confirm it on the held-out cases: a held-out check failed the kit's check\. The run goes on: a goal not confirmed is not met yet\.\n- correct: unmet\. not confirmed: a held-out check failed the kit's check; /,
    );
    const views: Record<string, string> = {
      ...env.agentViews(first),
      goal_report: goalReport,
      brief,
      reasons: JSON.stringify(env.ledger.db.prepare("select reasons from verdict").all()),
      jobs: JSON.stringify(env.ledger.db.prepare("select result from job").all()),
      live,
    };
    assert.match(views.status ?? "", /"held_out":null/);
    for (const [where, text] of Object.entries(views)) {
      noContent(text, where);
      assert.ok(!text.includes(HIDDEN), `${where} names the hidden case`);
      assert.ok(!text.includes("wrong result"), `${where} holds the check's words`);
    }
    noContent(env.events(), "the events");
    for (const e of all())
      if (e.kind !== "held_out_checked" && e.kind !== "goal_checks")
        assert.ok(!JSON.stringify(e.body).includes(HIDDEN), `${e.kind} names the hidden case`);

    // Control: the owner sees the case and its kind; the agent token, the kind alone.
    await env.relay();
    const view = await env.rest("/v1/rigs/rig-a/view");
    noContent(view, "REST's rig view");
    const run = (
      JSON.parse(view) as {
        runs: {
          id: string;
          champion_held_out: {
            champion_seq: number;
            pass: boolean;
            cells: { cell: string; verifier: string; kind: string }[];
          } | null;
        }[];
      }
    ).runs.find((r) => r.id === "js-1");
    assert.equal(run?.champion_held_out?.champion_seq, 2);
    assert.equal(run?.champion_held_out?.pass, false);
    assert.deepEqual(
      run?.champion_held_out?.cells.map((c) => [c.cell, c.verifier, c.kind]),
      [[HIDDEN, "correctness", "check_failed"]],
    );
    for (const [tool, args] of [
      ["get_run", { run: "js-1" }],
      ["recent_events", { rig: "rig-a", limit: 500 }],
    ] as const) {
      const text = await env.mcp(tool, args, AGENT_TOKEN);
      noContent(text, `the agent's ${tool}`);
      assert.ok(!text.includes(HIDDEN), `the agent's ${tool} names the hidden case`);
    }
    const agentRun = JSON.parse(await env.mcp("get_run", { run: "js-1" }, AGENT_TOKEN)) as {
      champion_held_out: Record<string, unknown>;
    };
    assert.deepEqual(
      { ...agentRun.champion_held_out, at: "" },
      {
        at: "",
        pass: false,
        kinds: ["check_failed"],
        words: "a held-out check failed the kit's check",
        champion_seq: 2,
      },
    );
    const runPage = await env.page("/ui/campaigns/js-goal/runs/js-1");
    noContent(runPage, "the run's page");
    assert.match(
      runPage,
      /<h2>Held-out checks of champion #2<\/h2><span class="n">1 failed<\/span>/,
    );
    assert.match(
      runPage,
      new RegExp(
        `<td><code>${HIDDEN}</code></td><td>verifier <b>correctness</b></td><td><span class="chip bad">failed the kit's check</span></td>`,
      ),
    );
    const history = await env.page("/ui/campaigns/js-goal/runs/js-1/history");
    assert.match(
      history,
      new RegExp(
        `Champion #2 failed its held-out check: ${HIDDEN} failed the kit's check\\. The run does not close\\.`,
      ),
    );
    assert.match(
      history,
      /It was not confirmed on the held-out cases \(a held-out check failed the kit's check\): the lanes go on\./,
    );

    // A change right on every case meets correct again, passes its held-out case, and closes the
    // run. Its patch is written from the seed, so it names the seed as its parent.
    const fixed = (
      await env.service.submitAttempt(
        {
          run: "js-1",
          parent: env.seed,
          patch_base64: env.patch(FAST_KERNEL),
          hypothesis: "drop the idle, right on every size",
          known_flaws: [],
        },
        "proposer",
      )
    ).attempt;
    await env.drain();
    assert.equal(env.ledger.verdicts.current(fixed)?.verdict, "goal_progress", env.explain(fixed));
    assert.equal(env.reasons(fixed), "confirmed: newly met correct; vs champion seq 2");
    assert.equal(env.ledger.runs.get("js-1")?.status, "closed");
    assert.equal(all().filter((e) => e.kind === "goal_complete").length, 1);
    assert.deepEqual(
      records()
        .filter((r) => r.champion_seq !== null)
        .map((r) => [r.champion_seq, r.pass]),
      [
        [2, 0],
        [3, 1],
      ],
    );
    const last = all()
      .filter((e) => e.kind === "goal_report")
      .at(-1)?.body as { complete: boolean; not_confirmed?: string };
    assert.equal(last.complete, true);
    assert.equal(last.not_confirmed, undefined);
  });

  test("a contract with no held-out cases: the second validation runs none, and the run closes as before", async () => {
    const env = await setup({
      ...CHAMPION_RUN,
      contract: { ...CHAMPION_RUN.contract, held_out_cells: [] },
    });
    await env.drain();
    const id = await env.submit(FAST_KERNEL, "drop the idle");
    await env.drain();
    assert.equal(env.ledger.verdicts.current(id)?.verdict, "goal_progress", env.explain(id));
    assert.equal(env.ledger.runs.get("js-1")?.status, "closed");
    const events = env.ledger.eventsAfter(0, 100_000).events;
    assert.equal(events.filter((e) => e.kind === "held_out_checked").length, 0);
    assert.equal(
      Number(
        (env.ledger.db.prepare("select count(*) as n from held_out").get() as { n: number }).n,
      ),
      0,
    );
    const reports = events
      .filter((e) => e.kind === "goal_report")
      .map((e) => e.body as { complete: boolean; confirming?: boolean; not_confirmed?: string });
    assert.deepEqual(
      reports.slice(-2).map((r) => [r.complete, r.confirming ?? false, r.not_confirmed ?? null]),
      [
        [true, true, null],
        [true, false, null],
      ],
    );
  });
});
