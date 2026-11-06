/**
 * An experiment tried more than once (goal 214), as the scheduler gives it out: each try on a lane
 * that has not tried it while one has not, the earlier tries in the next one's brief, and done
 * after its last; the planner's answer is held to the same rule.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validatePlan } from "../../../../../src/harness/agents/planner/index.ts";
import { base } from "../../planner/setup.ts";
import { body, events, setup } from "./setup.ts";

describe("an experiment's tries, given out", () => {
  test("three tries go to each lane in turn, the next brief says how the last ended, and the third ends it", async (t) => {
    const s = await setup(t, { lanes: 2 });
    const x = await s.add("port the patch", { tries: 3 });
    for (const title of ["one", "two", "three", "four"]) await s.add(title);
    await s.round();
    await s.round();
    await s.round();
    assert.deepEqual(s.given(), [
      "lane-1:port the patch",
      "lane-2:one",
      // Lane-1 tried it, and lane-2 has not: lane-2 takes it.
      "lane-1:two",
      "lane-2:port the patch",
      // Both lanes tried it: the next free one takes its third try.
      "lane-1:port the patch",
      "lane-2:three",
    ]);
    assert.equal(s.q.get(x)?.state, "done", "done after its third try");
    assert.deepEqual(
      s.q.earlier(x).map((e) => [e.n, e.lane, e.result]),
      [
        [1, "lane-1", "no_attempt"],
        [2, "lane-2", "no_attempt"],
      ],
    );
    const retried = events(s.env, "experiment_retried").map((e) => body(e));
    assert.deepEqual(
      retried.map((b) => [b.try, b.tries, b.lane]),
      [
        [1, 3, "lane-1"],
        [2, 3, "lane-2"],
      ],
    );
    // Lane-2's second trial took the second try; lane-1's last trial took the third.
    const second = s.briefs["lane-2"]?.[1] ?? "";
    assert.match(second, /This is try 2 of 3 of this experiment\./);
    assert.match(second, /- try 1 on lane-1: it submitted no change/);
    const third = s.briefs["lane-1"]?.at(-1) ?? "";
    assert.match(third, /This is try 3 of 3/);
    assert.match(third, /- try 2 on lane-2: it submitted no change/);
  });

  test("the planner's answer may not give a lane an experiment it tried while another lane has not", () => {
    const queue = {
      up_next: [
        {
          id: "x-1",
          title: "port the patch",
          by: "owner",
          tries: {
            of: 3,
            try: 2,
            lanes: ["lane-1"],
            earlier: [{ n: 1, lane: "lane-1", result: "no_attempt" }],
          },
        },
        { id: "x-2", title: "other", by: "owner" },
      ],
      proposed: [],
      in_progress: [],
      tried: [],
    };
    const bad = validatePlan(
      {
        assignments: [
          { lane: "lane-1", experiment: "x-1", parent: "champion" },
          { lane: "lane-2", experiment: "x-2", parent: "champion" },
        ],
      },
      { ...base, queue },
    );
    assert.ok(
      bad.errors.includes(
        "lane-1: experiment x-1 was tried on lane-1 already (try 2 of 3 is next): give it to lane-2, which has not tried it",
      ),
      bad.errors.join("; "),
    );
    const good = validatePlan(
      {
        assignments: [
          { lane: "lane-1", experiment: "x-2", parent: "champion" },
          { lane: "lane-2", experiment: "x-1", parent: "champion" },
        ],
      },
      { ...base, queue },
    );
    assert.deepEqual(good.errors, []);
  });
});
