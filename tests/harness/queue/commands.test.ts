import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { controlQueue, RUN, setup } from "./setup.ts";

/**
 * The owner's queue commands: add, move, edit, drop and accept, each refused in words; an operator
 * may change the queue and an agent may not; a closed run's queue stays; and assign_campaign's
 * queue seeds the new run's.
 */

describe("the owner's queue commands", () => {
  test("add, move, edit, drop and accept; each refused in words for an unknown id or the wrong state", async () => {
    const s = await setup();
    const added = await s.command("queue_add", {
      run: RUN,
      title: "vector loads",
      family: "memory",
      why: "reads dominate",
      position: "top",
    });
    assert.ok(added.accepted, JSON.stringify(added));
    const id = String(added.result.experiment);
    assert.equal(added.result.position, 0);
    const second = await s.command("queue_add", { run: RUN, title: "second" });
    assert.equal(second.result.position, 1, "the end by default");
    const moved = await s.command("queue_move", { run: RUN, id, position: "end" });
    assert.equal(moved.result.position, 1);
    const edited = await s.command("queue_edit", { run: RUN, id, details: "use 128-bit loads" });
    assert.ok(edited.accepted);
    assert.equal(s.q.get(id)?.details, "use 128-bit loads");
    const accept = await s.command("queue_accept", { run: RUN, id });
    assert.equal(accept.accepted, false);
    assert.match(String(accept.result.error), /is queued, not a proposed idea/);
    const unknown = await s.command("queue_move", {
      run: RUN,
      id: "x-0123456789ab",
      position: "top",
    });
    assert.equal(unknown.accepted, false);
    assert.match(String(unknown.result.error), /no experiment x-0123456789ab in run smoke-1/);
    const dropped = await s.command("queue_drop", { run: RUN, id, why: "measured flat elsewhere" });
    assert.ok(dropped.accepted);
    const again = await s.command("queue_drop", { run: RUN, id, why: "twice" });
    assert.match(String(again.result.error), /is dropped: only proposed or queued/);
    const idea = s.q.add(RUN, { title: "lane idea", by: "lane-1", state: "proposed" }, "lane-1");
    const ok = await s.command("queue_accept", { run: RUN, id: idea.id, position: "top" });
    assert.equal(ok.result.state, "queued");
    assert.equal(ok.result.position, 0);
    // Every change is the owner's, by the issuer control signed.
    const bodies = s
      .events()
      .filter((e) => e.kind.startsWith("experiment_") && e.actor.startsWith("control:"));
    assert.ok(bodies.every((e) => (e.body as { by: string }).by === "owner"));
    assert.ok(bodies.every((e) => e.actor === "control:owner:ui"));
  });

  test("an operator may change the queue for the owner; an agent's token may not", async () => {
    const s = await setup();
    const op = await s.command(
      "queue_add",
      { run: RUN, title: "from the operator" },
      "owner:operator",
    );
    assert.ok(op.accepted, JSON.stringify(op));
    const agent = await s.command("queue_add", { run: RUN, title: "from an agent" }, "agent");
    assert.equal(agent.accepted, false);
    assert.match(String(agent.result.error), /queue_add is the owner's to issue/);
    const drop = await s.command("drop_directive", { run: RUN, id: 1 }, "agent");
    assert.match(String(drop.result.error), /drop_directive is the owner's to issue/);
    assert.deepEqual(
      s.q.queued(RUN).map((x) => x.title),
      ["from the operator"],
    );
  });

  test("a closed run's queue and rules do not change", async () => {
    const s = await setup();
    s.env.service.ledger.runs.setStatus(RUN, "closed", "done", "test");
    const r = await s.command("queue_add", { run: RUN, title: "late" });
    assert.match(String(r.result.error), /run smoke-1 is closed/);
    const d = await s.command("drop_directive", { run: RUN, id: 1 });
    assert.match(String(d.result.error), /run smoke-1 is closed/);
    const redirect = await s.command("redirect", {
      run: RUN,
      directives: [{ kind: "try", family: "unroll", rationale: "late", citations: [] }],
    });
    assert.match(String(redirect.result.error), /run smoke-1 is closed: its queue and rules/);
  });

  test("assign_campaign's queue seeds the new run's queue in order, keeping who added each, why, state and where it came from", async () => {
    const seeds = [
      {
        title: "fuse",
        family: "fusion",
        why: "won on long",
        by: "planner",
        state: "queued",
        from: { run: "old-1", id: "x-aaaaaaaaaaaa" },
      },
      {
        title: "lane idea",
        by: "lane-2",
        state: "proposed",
        from: { run: "old-1", id: "x-bbbbbbbbbbbb" },
      },
      {
        title: "owner's",
        details: "d",
        by: "owner",
        state: "queued",
        from: { run: "old-1", id: "x-cccccccccccc" },
      },
    ];
    const s = await setup({ queue: seeds });
    assert.deepEqual(
      s.q.queued(RUN).map((x) => [x.title, x.added_by, x.place, x.from_run, x.from_id]),
      [
        ["fuse", "planner", 0, "old-1", "x-aaaaaaaaaaaa"],
        ["owner's", "owner", 1, "old-1", "x-cccccccccccc"],
      ],
    );
    assert.deepEqual(
      s.q.proposed(RUN).map((x) => [x.title, x.added_by]),
      [["lane idea", "lane-2"]],
    );
    const added = s.events("experiment_added");
    assert.deepEqual(added[0]?.body, {
      id: s.q.queued(RUN)[0]?.id,
      title: "fuse",
      family: "fusion",
      why: "won on long",
      by: "planner",
      state: "queued",
      from_run: "old-1",
      from_id: "x-aaaaaaaaaaaa",
    });
    assert.equal(added[0]?.actor, "control:owner");
    // The run is created before its queue, in one step.
    const kinds = s.events().map((e) => e.kind);
    assert.ok(kinds.indexOf("run_created") < kinds.indexOf("experiment_added"));
    const view = (await controlQueue(s.events())).queue;
    assert.equal(view.find((x) => x.title === "fuse")?.from_run, "old-1");
  });
});
