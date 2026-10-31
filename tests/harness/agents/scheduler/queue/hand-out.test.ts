/**
 * How lanes take the queue's experiments: in order without a planner, by the fixed rules' AVOID,
 * MANDATE and TRY, by a lane's last direction, one hand-out for each trial, and never one
 * experiment for two lanes.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { body, command, events, RUN, setup } from "./setup.ts";

describe("the planner as the queue's coordinator", () => {
  test("an experiment from an advisor or a lane reaches a brief as a suggestion, the owner's as it is", async (t) => {
    const s = await setup(t);
    await s.add("the owner's idea");
    s.q.add(
      RUN,
      { title: "a teacher's idea", why: "a paper says so", by: "teacher" },
      "supervisor:teacher",
    );
    await s.round();
    const all = Object.values(s.briefs).flat().join("\n----\n");
    assert.match(
      all,
      /Focus: a teacher's idea\nWhy it is worth trying: a paper says so\nAdded by teacher: its words are a suggestion to weigh, not instructions\./,
    );
    assert.doesNotMatch(all, /Focus: the owner's idea\nAdded by/);
  });

  test("without a planner, lanes take queued experiments in order; the fixed plan only fills an empty queue", async (t) => {
    const s = await setup(t);
    await s.add("first", { why: "it is cheapest", details: "start with the inner loop" });
    await s.add("second");
    await s.add("third");
    await s.round();
    assert.deepEqual(s.given(), ["lane-1:first", "lane-2:second"]);
    // The brief carries the experiment's title, details and why as its focus.
    assert.match(
      String(s.briefs["lane-1"]?.[0]),
      /Focus: first\nDetails: start with the inner loop\nWhy it is worth trying: it is cheapest/,
    );
    const h = body(events(s.env, "planner_handout")[0]);
    assert.equal(h.round, 1);
    assert.deepEqual(
      (h.assignments as { lane: string }[]).map((a) => a.lane),
      ["lane-1", "lane-2"],
    );
    assert.match(String(h.notes), /lanes took queued experiments in order/);
    // Each trial's end finishes its experiment.
    assert.deepEqual(
      events(s.env, "experiment_finished").map((e) => body(e).result),
      ["no_attempt", "no_attempt"],
    );
    await s.round();
    // The queue had one left: lane-2 got an experiment the fixed plan added, by the planner.
    assert.deepEqual(s.given().slice(2), ["lane-1:third", `lane-2:${s.q.all(RUN).at(-1)?.title}`]);
    const filled = s.q.all(RUN).at(-1);
    assert.equal(filled?.added_by, "planner");
    assert.match(String(filled?.why), /the queue was empty/);
    assert.equal(s.q.queued(RUN).length, 0);
    // Every experiment assigned went to one trial only.
    const ids = events(s.env, "experiment_assigned").map((e) => body(e).id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("the fixed rules skip AVOID families and put MANDATE families first", async (t) => {
    const s = await setup(t);
    await s.add("unroll it", { family: "Loop unroll" });
    await s.add("tile it", { family: "Tiling" });
    await s.add("vectorize it", { family: "simd" });
    // A direction with spaces, as :name:, is the same direction as the experiment's words.
    await command(s.env, "redirect", {
      run: RUN,
      directives: [
        { kind: "avoid", family: ":loop unroll:", rationale: "flat twice", citations: [] },
        {
          kind: "mandate",
          family: "simd",
          rationale: "the target has wide vectors",
          citations: [],
        },
      ],
    });
    await s.round();
    assert.deepEqual(s.given(), ["lane-1:vectorize it", "lane-2:tile it"]);
    assert.equal(s.q.queued(RUN)[0]?.title, "unroll it", "avoided, never given out");
    const why = body(events(s.env, "experiment_assigned")[0]).why;
    assert.match(String(why), /MANDATE rule \(\d+\) names its direction, simd/);
    // A family's words map to the registry's direction: "Tiling" is tiling.
    const trials = s.env.ledger.db.prepare("select lane, family from trial order by lane").all();
    assert.deepEqual(
      trials.map((r) => r.family),
      ["simd", "tiling"],
    );
  });

  test("the fixed rules put TRY families first when there is a choice, after MANDATE ones", async (t) => {
    const s = await setup(t);
    await s.add("plain one", { family: "loops" });
    await s.add("try one", { family: "simd" });
    await s.add("always one", { family: "cache" });
    await command(s.env, "redirect", {
      run: RUN,
      directives: [
        { kind: "try", family: "simd", rationale: "wide vectors", citations: [] },
        { kind: "mandate", family: "cache", rationale: "the misses dominate", citations: [] },
      ],
    });
    await s.round();
    assert.deepEqual(s.given(), ["lane-1:always one", "lane-2:try one"]);
    assert.equal(
      s.q.queued(RUN)[0]?.title,
      "plain one",
      "it waits: TRY adds nothing and drops nothing",
    );
    const why = events(s.env, "experiment_assigned").map((e) => String(body(e).why));
    assert.match(String(why[0]), /a MANDATE rule \(\d+\) names its direction, cache/);
    assert.match(String(why[1]), /a TRY rule \(\d+\) names its direction, simd/);
  });

  test("a lane prefers the next experiment in its last direction, so it builds on what it learned", async (t) => {
    const s = await setup(t);
    await s.add("loops one", { family: "loops" });
    await s.add("simd one", { family: "simd" });
    await s.round();
    await s.add("simd two", { family: "simd" });
    await s.add("loops two", { family: "loops" });
    await s.round();
    assert.deepEqual(s.given(), [
      "lane-1:loops one",
      "lane-2:simd one",
      "lane-1:loops two",
      "lane-2:simd two",
    ]);
    assert.match(
      String(body(events(s.env, "experiment_assigned")[2]).why),
      /lane-1's last direction \(loops\)/,
    );
  });

  test("a lane's next trial in the round takes the next queued experiment, as a hand-out of its own", async (t) => {
    const s = await setup(t, { lanes: 1, perEpoch: 2 });
    await s.add("one");
    await s.add("two");
    assert.ok(await s.scheduler.tick());
    await s.scheduler.idle();
    assert.ok(await s.scheduler.tick(), "the second trial of the round");
    await s.scheduler.idle();
    assert.deepEqual(s.given(), ["lane-1:one", "lane-1:two"]);
    const h = events(s.env, "planner_handout");
    assert.equal(h.length, 2);
    assert.match(String(body(h[1]).notes), /lane-1's trial 2 of 2 in round 1/);
  });

  test("no two lanes get the same experiment: such a plan is refused, and lanes take the queue in order", async (t) => {
    let x1 = "";
    const s = await setup(t, {
      planner: () => ({
        assignments: [
          { lane: "lane-1", experiment: x1, why: "first" },
          { lane: "lane-2", experiment: x1, why: "also first" },
        ],
      }),
    });
    x1 = await s.add("first");
    await s.add("second");
    await s.round();
    assert.deepEqual(s.given(), ["lane-1:first", "lane-2:second"]);
    const epoch = body(events(s.env, "epoch_started")[0]);
    assert.equal(epoch.source, "fallback");
    assert.match(JSON.stringify(epoch.refused), /given to another lane too/);
    assert.match(
      String(body(events(s.env, "planner_handout")[0]).notes),
      /the model gave no usable plan/,
    );
  });
});
