/**
 * The queue's target drives ideas: the planner is asked to top the queue up, the fixed rules queue
 * the lanes' distinct ideas, a round below the target says so, and the worker's brief asks for
 * follow-ups.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Scheduler } from "../../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../../src/harness/broker/runner.ts";
import { makeJudgeEnv } from "../../../../helpers/judge-env.ts";
import { body, events, RUN, setup } from "./setup.ts";

describe("the queue's target drives ideas (goal 081)", () => {
  test("the planner reads the target and how many to add, and is asked to top the queue up", async (t) => {
    const s = await setup(t, {
      planner: () => ({
        add: [
          { ref: "a", title: "wider loads", why: "reads dominate" },
          { ref: "b", title: "prefetch", why: "the loads stall" },
        ],
        assignments: [
          { lane: "lane-1", experiment: "a", why: "first" },
          { lane: "lane-2", experiment: "b", why: "second" },
        ],
      }),
    });
    await s.add("only one");
    await s.round();
    const prompt = String(s.prompts[0]);
    // Two lanes: a target of 4; up next holds 1, and 2 go to the lanes: at least 4 to add.
    assert.match(
      prompt,
      /\\"queue_target\\":\{\\"add_at_least\\":4,\\"target\\":4,\\"up_next\\":1\}/,
    );
    assert.match(
      prompt,
      /Keep the queue\\nfull of ideas: queue_target\.target is how many experiments up_next should hold/,
    );
    assert.match(prompt, /The target drives ideas; it is not a cap/);
    assert.match(prompt, /No rule\\nstops you from keeping the queue at its target/);
  });

  test("below the target, the fixed rules queue the lanes' distinct ideas, oldest first; repeats and avoided ones wait", async (t) => {
    const s = await setup(t);
    await s.add("wider loads");
    const idea = (title: string, more: Record<string, unknown> = {}) =>
      s.q.add(RUN, { title, by: "lane-1", state: "proposed", ...more }, "lane-1").id;
    const fuse = idea("fuse the two loops");
    const repeat = idea("Wider loads!");
    const avoided = idea("tile the loops", { family: "tiling" });
    const table = idea("use a lookup table");
    s.env.ledger.directives.addSet(
      RUN,
      "control:owner",
      [{ kind: "avoid", family: "tiling", rationale: "null", citations: [] }],
      false,
    );
    await s.round();
    const state = (id: string) => s.q.get(id)?.state;
    assert.notEqual(state(fuse), "proposed");
    assert.notEqual(state(table), "proposed");
    assert.equal(state(repeat), "proposed", "a repeat waits for the planner or the owner");
    assert.equal(state(avoided), "proposed", "an idea an AVOID rule names waits");
    const accepted = events(s.env, "experiment_accepted");
    assert.deepEqual(
      accepted.map((e) => body(e).id),
      [fuse, table],
    );
    assert.match(String(body(accepted[0]).why), /fewer than its target of 4 experiments ready/);
    assert.equal(accepted[0]?.actor, "planner");
    // The lanes took the first two in order, and the queue is still below its target: low.
    assert.deepEqual(s.given(), ["lane-1:wider loads", "lane-2:fuse the two loops"]);
    const low = events(s.env, "queue_low");
    assert.equal(low.length, 1);
    assert.deepEqual(body(low[0]), {
      round: 1,
      ready: 1,
      target: 4,
      lanes: 2,
      source: "fallback",
    });
    assert.ok(s.env.service.queueLow(RUN), "the supervisor sees it, to ask the teachers");
  });

  test("a round that leaves the queue at its target asks for nothing", async (t) => {
    const s = await setup(t);
    for (const title of ["a", "b", "c", "d", "e", "f"]) await s.add(title);
    await s.round();
    assert.equal(events(s.env, "queue_low").length, 0);
    assert.equal(s.env.service.queueLow(RUN), null);
  });

  test("a campaign's own target replaces two for each lane; 0 asks for none", async () => {
    for (const [target, low] of [
      [1, 0],
      [0, 0],
      [9, 1],
    ] as const) {
      const e = makeJudgeEnv({
        contract: { lanes: { count: 2, trials_per_epoch: 1, queue_target: target } },
      });
      await e.start();
      for (const title of ["a", "b", "c"]) e.service.queue.add(RUN, { title, by: "owner" }, "o");
      const scheduler = new Scheduler({
        service: e.service,
        runner: new LocalRunner(e.paths.scratchDir),
        model: {
          baseUrl: "http://127.0.0.1:9",
          model: "m",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        owner: "scheduler-test",
        plannerOn: () => false,
        maxConcurrent: 2,
        backoffBaseMs: 0,
        backoffMaxMs: 0,
        runTrial: async () => ({
          stopped: "no_submission",
          turns: 1,
          toolCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
        }),
      });
      assert.ok(await scheduler.tick());
      await scheduler.idle();
      // Three queued, two given out: one ready.
      assert.equal(events(e, "queue_low").length, low, `target ${target}`);
    }
  });

  test("lanes propose follow-ups as they end; the next round queues the distinct ones", async (t) => {
    let n = 0;
    const s = await setup(t, {
      trial: async (spec) => {
        n++;
        // Each worker proposes a follow-up before it ends, through the existing path.
        if (n === 1)
          s.env.service.proposeIdea(String(spec.token), {
            title: "vector loads after the fusion",
            why: "the fused loop is load-bound",
          });
        if (n === 2) s.env.service.proposeIdea(String(spec.token), { title: "First" });
        return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    await s.add("first");
    await s.add("second");
    await s.round();
    assert.deepEqual(
      s.q
        .proposed(RUN)
        .map((x) => x.title)
        .sort(),
      ["First", "vector loads after the fusion"],
    );
    // The next round, below its target: the distinct one goes up next, and to a lane; the
    // repeat of "first" waits for the planner's model or the owner.
    await s.round();
    const follow = s.q.all(RUN).find((x) => x.title === "vector loads after the fusion");
    assert.ok(follow);
    assert.notEqual(follow.state, "proposed");
    assert.match(follow.added_by, /^lane-\d$/);
    assert.ok(s.given().some((g) => g.endsWith(":vector loads after the fusion")));
    assert.equal(s.q.all(RUN).find((x) => x.title === "First")?.state, "proposed");
  });

  test("the worker's brief asks for follow-up ideas before it submits or stops", async (t) => {
    const s = await setup(t);
    await s.add("first");
    await s.add("second");
    await s.round();
    assert.match(
      String(s.briefs["lane-1"]?.[0]),
      /Before you submit \(submitting ends your trial\), or before you stop without submitting, propose each distinct follow-up experiment your work suggests as an idea for the run's queue \(the idea tool, or thermite-trial idea\), each with why/,
    );
  });

  test("an advisor's old rule that freezes the queue no longer reaches the planner", async (t) => {
    const s = await setup(t, {
      planner: () => ({
        assignments: [
          { lane: "lane-1", title: "a", family: "memory", why: "a" },
          { lane: "lane-2", title: "b", family: "memory", why: "b" },
        ],
      }),
    });
    // Set before code refused them (goal 081): one freezes the queue, one is a plain rule.
    s.env.ledger.directives.addSet(
      RUN,
      "supervisor",
      [
        {
          kind: "note",
          value: "Do not add queue entries",
          rationale: "steady",
          citations: ["a-1"],
        },
        { kind: "try", family: "memory", rationale: "reads dominate", citations: ["a-2"] },
      ],
      true,
    );
    await s.round();
    const prompt = String(s.prompts[0]);
    assert.doesNotMatch(prompt, /Do not add queue entries/);
    assert.match(prompt, /reads dominate/);
    // The teachers' brief marks it, with why.
    const brief = s.env.service.brief(RUN) as {
      directives: { body: { kind: string }; refused?: string }[];
    };
    assert.deepEqual(
      brief.directives.map((d) => [d.body.kind, Boolean(d.refused)]),
      [
        ["note", true],
        ["try", false],
      ],
    );
    assert.match(String(brief.directives[0]?.refused), /may not freeze the queue's size/);
  });
});
