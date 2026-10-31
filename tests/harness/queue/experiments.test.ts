import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { controlQueue, RUN, setup } from "./setup.ts";

/**
 * The experiment queue (harness/queue.ts): each change is its row and one event, control's view
 * built from the events is the table, the order holds under random changes, and an experiment goes
 * to one trial.
 */

/** Up next as the harness orders it, and as control does, by id. */
async function bothOrders(s: Awaited<ReturnType<typeof setup>>) {
  const harness = s.q.queued(RUN).map((x) => x.id);
  const control = (await controlQueue(s.events())).queue
    .filter((x) => x.state === "queued")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((x) => x.id);
  return { harness, control };
}

describe("the experiment queue", () => {
  test("every change is its row and one event, and control's view of the events is the table", async () => {
    const s = await setup();
    const { q } = s;
    const a = q.add(
      RUN,
      { title: "fuse the loads", family: "Memory layout", by: "owner", why: "it won on big" },
      "control:owner:ui",
    );
    const b = q.add(
      RUN,
      { title: "unroll by 4", family: "unroll", by: "planner", position: "top" },
      "planner",
    );
    const c = q.add(
      RUN,
      { title: "warp shuffle", by: "teacher", position: 1 },
      "supervisor:teacher",
    );
    const idea = q.add(
      RUN,
      { title: "test at 3 sizes", by: "lane-2", state: "proposed", trial: "t-1" },
      "lane-2",
    );
    assert.deepEqual(
      q.queued(RUN).map((x) => [x.title, x.place]),
      [
        ["unroll by 4", 0],
        ["warp shuffle", 1],
        ["fuse the loads", 2],
      ],
    );
    assert.equal(idea.place, null, "a proposed idea has no place yet");
    q.accept(RUN, idea.id, { by: "owner", position: "top" }, "control:owner:ui");
    q.move(RUN, a.id, { by: "planner", position: 0, why: "it builds on the champion" }, "planner");
    q.edit(
      RUN,
      c.id,
      { title: "warp shuffle reduce", why: "fewer syncs" },
      { by: "owner" },
      "control:owner:ui",
    );
    q.drop(RUN, b.id, { by: "planner", why: "an AVOID rule names unroll" }, "planner");
    q.assign(RUN, idea.id, { lane: "lane-1", trial: "t-9", by: "planner", why: "next" }, "planner");
    q.finish("t-9", { result: "no_attempt" }, "scheduler");
    assert.deepEqual(
      q.queued(RUN).map((x) => [x.title, x.place]),
      [
        ["fuse the loads", 0],
        ["warp shuffle reduce", 1],
      ],
    );
    // The events, as the interface control reads them.
    const ev = s.events().filter((e) => e.kind.startsWith("experiment_"));
    assert.deepEqual(
      ev.map((e) => [e.kind, e.actor, e.subject]),
      [
        ["experiment_added", "control:owner:ui", RUN],
        ["experiment_added", "planner", RUN],
        ["experiment_added", "supervisor:teacher", RUN],
        ["experiment_added", "lane-2", RUN],
        ["experiment_accepted", "control:owner:ui", RUN],
        ["experiment_moved", "planner", RUN],
        ["experiment_edited", "control:owner:ui", RUN],
        ["experiment_dropped", "planner", RUN],
        ["experiment_assigned", "planner", RUN],
        ["experiment_finished", "scheduler", RUN],
      ],
    );
    assert.deepEqual(ev[0]?.body, {
      id: a.id,
      title: "fuse the loads",
      family: "Memory layout",
      why: "it won on big",
      by: "owner",
      state: "queued",
    });
    assert.deepEqual(ev[3]?.body, {
      id: idea.id,
      title: "test at 3 sizes",
      by: "lane-2",
      state: "proposed",
      trial: "t-1",
    });
    assert.deepEqual(ev[4]?.body, { id: idea.id, by: "owner", position: "top" });
    assert.deepEqual(ev[5]?.body, {
      id: a.id,
      by: "planner",
      position: 0,
      why: "it builds on the champion",
    });
    assert.deepEqual(ev[6]?.body, {
      id: c.id,
      by: "owner",
      title: "warp shuffle reduce",
      why: "fewer syncs",
    });
    assert.deepEqual(ev[7]?.body, { id: b.id, by: "planner", why: "an AVOID rule names unroll" });
    assert.deepEqual(ev[8]?.body, {
      id: idea.id,
      lane: "lane-1",
      trial: "t-9",
      by: "planner",
      why: "next",
    });
    assert.deepEqual(ev[9]?.body, {
      id: idea.id,
      lane: "lane-1",
      trial: "t-9",
      result: "no_attempt",
    });
    assert.match(String(a.id), /^x-[0-9a-f]{12}$/);
    // Control builds the same queue from these events alone.
    const view = (await controlQueue(s.events())).queue;
    for (const x of q.all(RUN)) {
      const v = view.find((y) => y.id === x.id);
      assert.ok(v, `control knows ${x.id}`);
      assert.equal(v.state, x.state);
      assert.equal(v.position, x.place, `${x.title}: the same place`);
      assert.equal(v.title, x.title);
      assert.equal(v.by, x.added_by);
    }
    assert.equal(view.find((y) => y.id === b.id)?.dropped_why, "an AVOID rule names unroll");
    assert.equal(view.find((y) => y.id === idea.id)?.result, "no_attempt");
  });

  test("random adds, moves, accepts, drops and assignments keep the harness's order and control's the same", async () => {
    const s = await setup();
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const pos = (): "top" | "end" | number => {
      const k = rnd(3);
      return k === 0 ? "top" : k === 1 ? "end" : rnd(6);
    };
    for (let i = 0; i < 160; i++) {
      const queued = s.q.queued(RUN);
      const proposed = s.q.proposed(RUN);
      const any = <T>(xs: T[]) => xs[rnd(xs.length)];
      const op = rnd(6);
      if (op === 0 || queued.length < 2)
        s.q.add(RUN, { title: `t${i}`, by: "owner", position: pos() }, "control:owner:ui");
      else if (op === 1)
        s.q.add(RUN, { title: `idea ${i}`, by: "lane-1", state: "proposed" }, "lane-1");
      else if (op === 2 && proposed.length)
        s.q.accept(RUN, String(any(proposed)?.id), { by: "planner", position: pos() }, "planner");
      else if (op === 3)
        s.q.move(RUN, String(any(queued)?.id), { by: "owner", position: pos() }, "x");
      else if (op === 4) s.q.drop(RUN, String(any(queued)?.id), { by: "owner", why: "no" }, "x");
      else
        s.q.assign(
          RUN,
          String(any(queued)?.id),
          { lane: "lane-1", trial: `t-${i}`, by: "planner" },
          "planner",
        );
      const o = await bothOrders(s);
      assert.deepEqual(o.control, o.harness, `after step ${i}`);
      assert.deepEqual(
        s.q.queued(RUN).map((x) => x.place),
        s.q.queued(RUN).map((_, k) => k),
        "places are 0, 1, 2, …",
      );
    }
  });

  test("an experiment goes to one trial: assigned, done or dropped ones are refused", async () => {
    const { q } = await setup();
    const x = q.add(RUN, { title: "one", by: "owner" }, "o");
    q.assign(RUN, x.id, { lane: "lane-1", trial: "t-1", by: "planner" }, "planner");
    assert.throws(
      () => q.assign(RUN, x.id, { lane: "lane-2", trial: "t-2", by: "planner" }, "planner"),
      /is assigned: it can't be given out/,
    );
    q.finish("t-1", { result: "submitted", attempt: "a-1" }, "s");
    assert.throws(
      () => q.assign(RUN, x.id, { lane: "lane-2", trial: "t-2", by: "planner" }, "planner"),
      /is done/,
    );
    assert.throws(() => q.drop(RUN, x.id, { by: "owner", why: "late" }, "o"), /is done/);
    assert.throws(() => q.move(RUN, x.id, { by: "owner", position: "top" }, "o"), /is done/);
    assert.throws(() => q.require(RUN, "x-000000000000"), /no experiment/);
  });
});
