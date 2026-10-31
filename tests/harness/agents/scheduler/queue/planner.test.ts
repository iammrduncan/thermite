/**
 * The planner's answer changes the queue: its changes and hand-out, a rule the owner's message
 * asked for, a direction it designs for a rule, and what it may not do.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { body, command, events, RUN, setup } from "./setup.ts";

describe("the planner as the queue's coordinator", () => {
  test("the planner's queue changes, hand-out and a rule the owner's message asked for", async (t) => {
    const ids: Record<string, string> = {};
    const s = await setup(t, {
      planner: () => ({
        accept: [{ id: ids.idea, why: "cheap to check", position: "top" }],
        drop: [
          { id: ids.stale, why: "the champion already does it" },
          { id: ids.idea2, why: "lane-1's idea covers it" },
        ],
        add: [{ ref: "n1", title: "wider loads", family: "memory", why: "reads dominate" }],
        move: [{ id: ids.later, position: "end", why: "after the loads" }],
        // The owner's plain words make a rule for a new direction the planner designs.
        new_families: [{ id: "Timer code", description: "any change to the timing code" }],
        rules: [
          {
            kind: "avoid",
            family: ":timer code:",
            rationale: "the owner asked",
            from_message: 1,
          },
        ],
        assignments: [
          { lane: "lane-1", experiment: ids.idea, why: "lane-1 proposed it" },
          { lane: "lane-2", experiment: "n1", parent: "champion", why: "fresh direction" },
        ],
        notes: "loads first",
      }),
    });
    ids.later = await s.add("later");
    ids.stale = await s.add("stale");
    ids.idea = s.q.add(RUN, { title: "lane idea", by: "lane-1", state: "proposed" }, "lane-1").id;
    ids.idea2 = s.q.add(
      RUN,
      { title: "lane idea two", by: "lane-2", state: "proposed" },
      "lane-2",
    ).id;
    await command(s.env, "message_agent", {
      run: RUN,
      to: "planner",
      text: "never touch the timer code",
    });
    await s.round();
    // What the planner read: the queue, and the owner's message with its id.
    assert.match(String(s.prompts[0]), /\\"up_next\\":\[\{\\"by\\":\\"owner\\",\\"id\\":\\"x-/);
    assert.match(String(s.prompts[0]), /\\"proposed\\":\[\{\\"by\\":\\"lane-1\\"/);
    assert.match(
      String(s.prompts[0]),
      /\{\\"directions\\":\[\],\\"id\\":1,\\"text\\":\\"never touch the timer code\\"\}/,
    );
    // Its changes, each by the planner, with why.
    const by = (kind: string) => events(s.env, kind).filter((e) => e.actor === "planner");
    assert.deepEqual(body(by("experiment_accepted")[0]), {
      id: ids.idea,
      by: "planner",
      position: "top",
      why: "cheap to check",
    });
    assert.deepEqual(body(by("experiment_dropped")[0]), {
      id: ids.stale,
      by: "planner",
      why: "the champion already does it",
    });
    // A lane's idea the planner drops is dropped by it, with why: it never reaches the queue.
    assert.deepEqual(body(by("experiment_dropped")[1]), {
      id: ids.idea2,
      by: "planner",
      why: "lane-1's idea covers it",
    });
    assert.equal(s.q.get(ids.idea2 ?? "")?.state, "dropped");
    const added = by("experiment_added").find((e) => body(e).title === "wider loads");
    assert.equal(body(added).by, "planner");
    assert.deepEqual(body(by("experiment_moved")[0]), {
      id: ids.later,
      by: "planner",
      position: "end",
      why: "after the loads",
    });
    assert.deepEqual(s.given(), ["lane-1:lane idea", "lane-2:wider loads"]);
    const h = body(events(s.env, "planner_handout")[0]);
    assert.deepEqual(h.assignments, [
      { lane: "lane-1", experiment: ids.idea, why: "lane-1 proposed it" },
      { lane: "lane-2", experiment: body(added).id, why: "fresh direction" },
    ]);
    assert.equal(h.notes, "loads first");
    // The rule: a directive by the planner that records the owner's message it came from.
    // It names the direction the planner designed, which the run now has, in the planner's words.
    const rule = events(s.env, "directive").find((e) => e.actor === "planner");
    assert.deepEqual(body(rule).body, {
      kind: "avoid",
      family: "timer-code",
      rationale: "the owner asked",
      citations: [],
      from_message: 1,
    });
    const made = events(s.env, "family_added").find((e) => body(e).family === "timer-code");
    assert.equal(made?.actor, "planner:planner");
    assert.equal(body(made).description, "any change to the timing code");
    assert.ok(s.q.directions(RUN).includes("timer-code"));
    assert.equal(body(events(s.env, "epoch_started")[0]).source, "planner");
    // The message was read by the planner that answered it, in the round of its hand-out.
    assert.deepEqual(
      events(s.env, "agent_message_read").map((e) => body(e)),
      [{ message: 1, by: "planner", round: h.round }],
    );
    assert.equal(h.round, 1);
  });

  test("a rule from a message the planner was not given, or a dropped experiment given out, is refused", async (t) => {
    let x = "";
    const s = await setup(t, {
      planner: (_p, call) =>
        call === 1
          ? {
              rules: [{ kind: "avoid", family: "unroll", rationale: "r", from_message: 9 }],
              assignments: [
                { lane: "lane-1", experiment: x, why: "w" },
                { lane: "lane-2", title: "inline one", family: "misc", why: "w" },
              ],
            }
          : {
              drop: [{ id: x, why: "no" }],
              assignments: [
                { lane: "lane-1", experiment: x, why: "w" },
                { lane: "lane-2", title: "inline one", family: "misc", why: "w" },
              ],
            },
    });
    x = await s.add("only");
    await s.round();
    const refused = JSON.stringify(body(events(s.env, "epoch_started")[0]).refused);
    assert.match(refused, /message 9 is not one of the owner's messages given to you/);
    assert.match(refused, /is dropped in this same answer/);
    assert.equal(events(s.env, "directive").length, 0);
  });

  test("a rule for a direction the run doesn't have: the planner designs it, says so, and the rule names it", async (t) => {
    let x = "";
    const s = await setup(t, {
      lanes: 1,
      // The first answer designs nothing; the second does.
      planner: (_p, call) => ({
        ...(call > 1
          ? {
              new_families: [
                { id: "shared-memory-tiling", description: "tiles staged in shared memory" },
              ],
              add: [
                {
                  ref: "n1",
                  title: "stage the tiles in shared memory",
                  family: "shared memory tiling",
                  why: "the rule asks for it",
                },
              ],
            }
          : {}),
        assignments: [{ lane: "lane-1", experiment: call > 1 ? "n1" : x, why: "w" }],
      }),
    });
    x = await s.add("only");
    // The owner names it in plain words with spaces; a :name: names the same direction.
    const r = await command(s.env, "redirect", {
      run: RUN,
      directives: [
        { kind: "try", family: "Shared memory tiling", rationale: "won elsewhere", citations: [] },
      ],
      replace: false,
    });
    assert.deepEqual(r.new_directions, ["shared-memory-tiling"]);
    assert.ok(!s.q.directions(RUN).includes("shared-memory-tiling"), "not the run's yet");
    await s.round();
    // The first answer designed nothing: refused, with what to do. The retry designed it.
    const prompt = String(s.prompts[0]);
    assert.match(prompt, /\\"to_design\\":\[\{\\"name\\":\\"shared-memory-tiling\\"/);
    const epoch = body(events(s.env, "epoch_started")[0]);
    assert.equal(epoch.source, "planner");
    assert.match(
      JSON.stringify(epoch.refused),
      /names :shared-memory-tiling:, a direction this run doesn't have yet: design it in new_families/,
    );
    const made = events(s.env, "family_added").find(
      (e) => body(e).family === "shared-memory-tiling",
    );
    assert.equal(made?.actor, "planner:planner");
    assert.deepEqual(body(made), {
      family: "shared-memory-tiling",
      description: "tiles staged in shared memory",
      for_rules: [Number((r.directives as number[])[0])],
    });
    assert.ok(s.q.directions(RUN).includes("shared-memory-tiling"));
    assert.deepEqual(s.given(), ["lane-1:stage the tiles in shared memory"]);
  });
});
