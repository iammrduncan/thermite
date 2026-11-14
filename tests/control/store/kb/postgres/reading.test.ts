import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openSqliteStore } from "../../../../../src/control/store/index.ts";
import {
  type KbIndexTargetLater,
  readLater,
} from "../../../../../src/control/store/kb/postgres/replay.ts";
import type { KbIndexTarget } from "../../../../../src/core/kb/index.ts";
import { postgresStore } from "../../../../helpers/postgres.ts";

/**
 * The reading of an event on a store whose answers come later (goal 268, replay.ts): the reading
 * answers at once, so it runs again from its start with each answer it waited for, and each of
 * its writes is made once.
 */

/** A target that keeps its items in memory, answers a turn later, and notes each call. */
function laterTarget() {
  const items = new Map<string, { body: string; meta: Record<string, string> }>();
  const calls: string[] = [];
  const turn = () => new Promise<void>((done) => setImmediate(done));
  const target: KbIndexTargetLater = {
    runCreated: async (run, named) => {
      await turn();
      calls.push(`runCreated ${run} ${named}`);
    },
    item: async (run, kind, ref) => {
      await turn();
      calls.push(`item ${kind}:${ref}`);
      return items.get(`${run}/${kind}:${ref}`);
    },
    attempt: async (ref) => {
      await turn();
      calls.push(`attempt ${ref}`);
      const held = items.get(`r/attempt:${ref}`);
      return held && { run: "r", ...held };
    },
    put: async (run, kind, ref, f) => {
      await turn();
      calls.push(`put ${kind}:${ref} ${f.body ?? ""}`);
      items.set(`${run}/${kind}:${ref}`, { body: f.body ?? "", meta: f.meta ?? {} });
    },
  };
  return { target, items, calls };
}

describe("a reading that answers at once, on a target that answers later", () => {
  test("each write is made once, in the reading's order, and a read sees the writes before it", async () => {
    const { target, calls } = laterTarget();
    let runs = 0;
    const reading = (t: KbIndexTarget) => {
      runs++;
      t.runCreated("r", "gemv");
      const before = t.item("r", "note", "1")?.body ?? "none";
      t.put("r", "note", "1", { body: `first, after ${before}` }, "now");
      // Its own write, read back: the store has it by then.
      const own = t.item("r", "note", "1")?.body;
      t.put("r", "note", "2", { body: `second, after ${own}` }, "now");
      assert.equal(t.attempt("a-1"), undefined);
    };
    await readLater(reading, target);
    assert.deepEqual(calls, [
      "runCreated r gemv",
      "item note:1",
      "put note:1 first, after none",
      "item note:1",
      "put note:2 second, after first, after none",
      "attempt a-1",
    ]);
    assert.equal(runs, 4, "it ran once more for each answer it waited for");
  });

  test("a reading that asks nothing runs once; one that fails fails, with its writes not made", async () => {
    const { target, calls } = laterTarget();
    await readLater((t) => t.put("r", "note", "1", { body: "only" }, "now"), target);
    assert.deepEqual(calls, ["put note:1 only"]);
    await assert.rejects(
      readLater((t) => {
        t.put("r", "note", "9", { body: "never" }, "now");
        throw new Error("the event can't be read");
      }, target),
      /the event can't be read/,
    );
    assert.deepEqual(calls, ["put note:1 only"]);
  });

  test("a reading that asks other things when it runs again is refused: it is not one reading", async () => {
    const { target } = laterTarget();
    let runs = 0;
    await assert.rejects(
      readLater((t) => {
        runs++;
        t.item("r", "note", String(runs));
        t.item("r", "note", "x");
      }, target),
      /asked different things when it ran again/,
    );
  });
});

describe("the events' reading into the knowledge base, on both stores", () => {
  test("the same events leave the same items, versions and outcomes", async () => {
    const RIG = { rig: "rig-a", ledger: "ledger-a" };
    const events: [string, string, Record<string, unknown>][] = [
      ["run_created", "gs-1", { campaign: "gemv", mode: "hill_climb" }],
      [
        "experiment_added",
        "gs-1",
        { id: "x-1", title: "Tile by 32", details: "Tiles of 32 rows.", by: "planner" },
      ],
      [
        "experiment_added",
        "gs-1",
        { id: "x-2", title: "Unroll by 4", details: "Unrolled.", by: "planner" },
      ],
      [
        "experiment_finished",
        "gs-1",
        { id: "x-1", attempt: "a-1", result: "win confirmed (+6.10%)" },
      ],
      ["experiment_finished", "gs-1", { id: "x-2", result: "Dropped: superseded" }],
      ["journal_note", "gs-1", { id: 1, by: "lane-1", kind: "lesson", text: "Tiles help." }],
      ["journal_note", "gs-1", { id: 1, by: "lane-1", kind: "lesson", text: "Tiles help." }],
    ];
    const read = async (store: ReturnType<typeof openSqliteStore>) => {
      let n = 0;
      for (const [kind, run, body] of events)
        await store.kb().index(RIG, {
          at: `2026-11-14T10:${String(n++).padStart(2, "0")}:00.000Z`,
          actor: "harness",
          kind,
          subject: run,
          body,
        });
      const listed = await store.kb().list({ campaign: "gemv" }, { limit: 50, sort: "name" });
      return listed.items.map((x) => [x.kind, x.ref, x.version, x.title, x.body, x.outcome, x.seq]);
    };
    const sqlite = openSqliteStore(":memory:");
    const postgres = postgresStore();
    const onSqlite = await read(sqlite);
    assert.ok(onSqlite.length >= 4, JSON.stringify(onSqlite));
    assert.deepEqual(await read(postgres), onSqlite);
    await sqlite.close();
    await postgres.close();
  });
});
