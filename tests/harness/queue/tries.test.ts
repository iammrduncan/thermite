import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { experimentsTab } from "../../../src/control/ui/campaigns/queue/index.ts";
import type { RigView } from "../../../src/control/views/index.ts";
import { sha256Hex } from "../../../src/core/canonical.ts";
import { CommandPayloads } from "../../../src/core/commands.ts";
import { controlQueue, RUN, setup } from "./setup.ts";

/**
 * An experiment tried more than once (goal 214): a try that ends without a win sends the same
 * experiment back to the top with the try kept, until a try wins or none is left; a win, or a
 * win that waits for the owner, ends its tries; a lane that tried it takes it again only once
 * every lane has.
 */

/** An event's body, as its fields. */
const body = (e: { body: unknown } | undefined) => (e?.body ?? {}) as Record<string, unknown>;

/** An attempt of the run, as the judge would hold it. */
function attempt(s: Awaited<ReturnType<typeof setup>>, id: string): string {
  s.env.service.ledger.attempts.record(
    {
      id,
      run: RUN,
      parentRef: "seed",
      parentCommit: "a".repeat(40),
      baselineChampionSeq: 1,
      commitSha: sha256Hex(id).slice(0, 40),
      ref: `refs/thermite/attempts/${id}`,
      diffSha: id,
      normalizedDiffSha: id,
      lifecycle: "submitted",
    },
    "test",
  );
  return id;
}

/** The attempt's verdict and lifecycle, as the judge settles them. */
function judge(
  s: Awaited<ReturnType<typeof setup>>,
  id: string,
  verdict: string,
  lifecycle: string,
  reasons = "measured",
) {
  s.env.service.ledger.verdicts.record({ attempt: id, verdict, reasons, judgedBy: "judge" });
  s.env.service.ledger.attempts.setLifecycle(id, lifecycle, "judge");
}

describe("an experiment's tries", () => {
  test("a judged attempt without a win sends it back with the try kept; a win ends its tries", async () => {
    const s = await setup();
    const { q } = s;
    const x = q.add(RUN, { title: "port the patch", by: "owner", tries: 3 }, "control:owner:ui");
    q.add(RUN, { title: "something else", by: "owner" }, "control:owner:ui");
    assert.equal(x.tries, 3);
    q.assign(RUN, x.id, { lane: "lane-1", trial: "t-1", by: "planner" }, "planner");
    const a1 = attempt(s, "a-1");
    q.finish("t-1", { result: "submitted", attempt: a1 }, "harness");
    assert.equal(q.get(x.id)?.state, "done", "done while the judge works");
    assert.deepEqual(q.retrySettled(RUN, "harness"), [], "nothing settled yet");
    judge(s, a1, "regress", "judged", "slower by 3.1% on big");
    const back = q.retrySettled(RUN, "harness");
    assert.deepEqual(
      back.map((y) => y.id),
      [x.id],
    );
    const again = q.get(x.id);
    assert.equal(again?.state, "queued");
    assert.equal(q.queued(RUN)[0]?.id, x.id, "back at the top");
    assert.equal(again?.attempt, null);
    assert.deepEqual(
      q.earlier(x.id).map((t) => [t.n, t.lane, t.attempt, t.result, t.verdict, t.cause]),
      [[1, "lane-1", a1, "submitted", "regress", "slower by 3.1% on big"]],
    );
    // The attempt still names the experiment it came from (the planner's evidence reads it).
    assert.equal(s.env.service.ledger.experiments.ofAttempt(a1)?.id, x.id);
    const retried = s.events("experiment_retried");
    assert.equal(retried.length, 1);
    assert.deepEqual(retried[0]?.body, {
      id: x.id,
      try: 1,
      tries: 3,
      lane: "lane-1",
      trial: "t-1",
      attempt: a1,
      result: "submitted",
      verdict: "regress",
      cause: "slower by 3.1% on big",
      position: "top",
    });
    // The planner's brief: try 2 of 3 is next, and lane-1 tried it.
    const up = q.brief(RUN).up_next[0];
    assert.equal(up?.id, x.id);
    assert.equal(up?.tries?.of, 3);
    assert.equal(up?.tries?.try, 2);
    assert.deepEqual(up?.tries?.lanes, ["lane-1"]);
    // Lane-1 takes it again only once every lane has tried it.
    assert.equal(
      q.takes(again as NonNullable<typeof again>, "lane-1", ["lane-1", "lane-2"]),
      false,
    );
    assert.equal(q.takes(again as NonNullable<typeof again>, "lane-2", ["lane-1", "lane-2"]), true);
    assert.equal(q.takes(again as NonNullable<typeof again>, "lane-1", ["lane-1"]), true);
    // Try 2 wins: its tries end there, though one is left.
    q.assign(RUN, x.id, { lane: "lane-2", trial: "t-2", by: "planner" }, "planner");
    const a2 = attempt(s, "a-2");
    q.finish("t-2", { result: "submitted", attempt: a2 }, "harness");
    judge(s, a2, "win_confirmed", "promoted");
    assert.deepEqual(q.retrySettled(RUN, "harness"), []);
    assert.equal(q.get(x.id)?.state, "done");
    assert.equal(q.get(x.id)?.attempt, a2);

    // Control's view, from the events alone: the try kept and the experiment done.
    const r = await controlQueue(s.events());
    const v = r.queue.find((y) => y.id === x.id);
    assert.equal(v?.tries, 3);
    assert.equal(v?.state, "done");
    assert.deepEqual(
      v?.earlier.map((t) => [t.n, t.lane, t.attempt, t.verdict]),
      [[1, "lane-1", a1, "regress"]],
    );
    const html = experimentsTab({
      u: { id: "rig-a" } as RigView,
      r,
      now: Date.now(),
      csrf: "c",
      back: "/ui",
      cmd: () => "",
      directions: [],
    });
    assert.match(html, /try 2 of 3/);
    assert.match(html, /Try 1 on lane-1: a-1 judged regress \(slower by 3\.1% on big\)\./);
    assert.match(html, /name="tries" type="number" min="1" max="10"/, "the add form's Tries");
  });

  test("a win that waits for the owner ends its tries too; a trial with no attempt uses one at once", async () => {
    const s = await setup();
    const { q } = s;
    const x = q.add(RUN, { title: "waits for you", by: "owner", tries: 2 }, "control:owner:ui");
    q.assign(RUN, x.id, { lane: "lane-1", trial: "t-1", by: "planner" }, "planner");
    const a1 = attempt(s, "a-1");
    q.finish("t-1", { result: "submitted", attempt: a1 }, "harness");
    judge(s, a1, "win_confirmed", "awaiting_approval");
    assert.deepEqual(q.retrySettled(RUN, "harness"), []);
    assert.equal(q.get(x.id)?.state, "done");

    // No attempt: back at once, and the last try ends it.
    const y = q.add(RUN, { title: "no change", by: "owner", tries: 2 }, "control:owner:ui");
    q.assign(RUN, y.id, { lane: "lane-1", trial: "t-2", by: "planner" }, "planner");
    q.finish("t-2", { result: "no_attempt", cause: "it found nothing to change" }, "harness");
    assert.equal(q.get(y.id)?.state, "queued");
    assert.deepEqual(
      q.earlier(y.id).map((t) => [t.lane, t.result, t.cause]),
      [["lane-1", "no_attempt", "it found nothing to change"]],
    );
    q.assign(RUN, y.id, { lane: "lane-2", trial: "t-3", by: "planner" }, "planner");
    q.finish("t-3", { result: "no_attempt" }, "harness");
    assert.equal(q.get(y.id)?.state, "done", "its last try ended it");
    assert.equal(q.earlier(y.id).length, 1);
    // An experiment with one try is done as before.
    const z = q.add(RUN, { title: "once", by: "owner" }, "control:owner:ui");
    q.assign(RUN, z.id, { lane: "lane-1", trial: "t-4", by: "planner" }, "planner");
    q.finish("t-4", { result: "no_attempt" }, "harness");
    assert.equal(q.get(z.id)?.state, "done");
    assert.equal(s.events("experiment_retried").length, 1);
  });

  test("the owner sets tries on queue_add and queue_edit, within 1 to 10 and above the tries used", async () => {
    const s = await setup();
    const { q } = s;
    const added = await s.command("queue_add", { run: RUN, title: "three goes", tries: 3 });
    assert.equal(added.accepted, true);
    assert.equal(added.result.tries, 3);
    const id = String(added.result.experiment);
    assert.equal(body(s.events("experiment_added").at(-1)).tries, 3);
    assert.equal(
      CommandPayloads.queue_add.safeParse({ run: RUN, title: "x", tries: 11 }).success,
      false,
    );
    assert.equal(CommandPayloads.queue_edit.safeParse({ run: RUN, id, tries: 0 }).success, false);
    assert.equal(CommandPayloads.queue_edit.safeParse({ run: RUN, id, tries: 5 }).success, true);
    q.assign(RUN, id, { lane: "lane-1", trial: "t-1", by: "planner" }, "planner");
    q.finish("t-1", { result: "no_attempt" }, "harness");
    // Tried once: it takes more than one try now.
    assert.throws(
      () => q.edit(RUN, id, { tries: 1 }, { by: "owner" }, "control:owner:ui"),
      /was tried 1 time already: give it more than 1 tries/,
    );
    const edited = await s.command("queue_edit", { run: RUN, id, tries: 5 });
    assert.equal(edited.result.tries, 5);
    assert.equal(q.get(id)?.tries, 5);
    assert.equal(body(s.events("experiment_edited").at(-1)).tries, 5);
    const r = await controlQueue(s.events());
    assert.equal(r.queue.find((x) => x.id === id)?.tries, 5);
  });
});
