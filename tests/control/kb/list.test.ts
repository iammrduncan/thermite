import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type KbListAnswer, KbListQuery, ownerKbList } from "../../../src/control/kb/index.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import type { RigView } from "../../../src/control/views/index.ts";
import { fillKnowledge } from "../../helpers/kb-places.ts";

/**
 * The owner's list of one place of the knowledge base (goal 176): its folders, with what control
 * knows of each; every item under it, kept by the filters, sorted and paged; and the counts.
 */

/** The rigs' views as the list reads them: gs-1 is running. */
const RUNNING = [{ runs: [{ id: "gs-1", status: "running" }] }] as unknown as RigView[];

function listed(q: Partial<KbListQuery> = {}): KbListAnswer {
  const store = new ControlStore(":memory:");
  fillKnowledge(store);
  const r = ownerKbList(store, RUNNING, KbListQuery.parse(q));
  if ("error" in r) throw new Error(r.error);
  return r;
}
const titles = (r: KbListAnswer) => r.items.map((x) => x.title);

describe("the owner's list of a place in the knowledge base", () => {
  test("folders: the collections, runs or slots of a place, each with its items, newest change and state", () => {
    const root = listed({ limit: 0 });
    assert.deepEqual(
      [root.at.level, root.at.path, root.at.items, root.total],
      ["knowledge_base", "", 10, 10],
    );
    // Newest change first; an empty collection, with none, last.
    assert.deepEqual(
      root.folders.map((f) => [f.name, f.level, f.items, f.archived]),
      [
        ["attic", "collection", 1, true],
        ["gemv", "collection", 9, false],
        ["empty", "collection", 0, false],
      ],
    );
    assert.equal(root.folders.at(-1)?.updated_at, null);
    assert.deepEqual(
      listed({ sort: "name", limit: 0 }).folders.map((f) => f.name),
      ["attic", "empty", "gemv"],
    );
    assert.deepEqual(
      listed({ sort: "name", order: "desc", limit: 0 }).folders.map((f) => f.name),
      ["gemv", "empty", "attic"],
    );
    const gemv = listed({ at: "gemv", sort: "name", limit: 0 });
    assert.deepEqual([gemv.at.level, gemv.at.items, gemv.at.archived], ["collection", 9, false]);
    assert.deepEqual(
      gemv.folders.map((f) => [f.path, f.level, f.items, f.running, f.fresh]),
      [
        ["gemv/gs-1", "run", 8, true, false],
        ["gemv/gs-2", "run", 1, false, true],
      ],
    );
    const run = listed({ at: "gemv/gs-1", sort: "name", limit: 0 });
    assert.deepEqual([run.at.running, run.at.fresh], [true, false]);
    assert.deepEqual(
      run.folders.map((f) => [f.path, f.level, f.items]),
      [
        ["gemv/gs-1/planner", "slot", 1],
        ["gemv/gs-1/records", "slot", 5],
        ["gemv/gs-1/worker-1", "slot", 2],
      ],
    );
    const slot = listed({ at: "gemv/gs-1/worker-1" });
    assert.deepEqual([slot.at.level, slot.folders, slot.total], ["slot", [], 2]);
  });

  test("items: every item under a place, at any depth, with its type; a filter keeps any of its values, and the filters keep what all of them keep", () => {
    const all = listed({ at: "gemv" });
    assert.equal(all.items.length, 9);
    const file = all.items.find((x) => x.kind === "reference");
    assert.deepEqual(file && [file.address, file.type, file.file?.bytes, file.slot], [
      "gemv/gs-1/worker-1/reference:2",
      "file",
      52_000,
      "worker-1",
    ]);
    assert.deepEqual([...new Set(all.items.map((x) => `${x.slot}:${x.type}`))].sort(), [
      "planner:blurb",
      "records:record",
      "worker-1:blurb",
      "worker-1:file",
    ]);
    assert.equal(listed({ at: "gemv", kinds: ["experiment", "attempt"] }).matched, 3);
    const won = listed({ at: "gemv", outcomes: ["won"] });
    assert.deepEqual([won.matched, won.total], [2, 9]);
    assert.deepEqual(won.items.map((x) => x.address).sort(), [
      "gemv/gs-1/records/attempt:a-1",
      "gemv/gs-1/records/experiment:x-1",
    ]);
    assert.equal(listed({ at: "gemv", types: ["file", "blurb"] }).matched, 3);
    // Two filters: an item must pass both.
    const both = listed({ at: "gemv", types: ["blurb"], slots: ["worker-1"] });
    assert.deepEqual(
      both.items.map((x) => x.kind),
      ["finding"],
    );
    assert.equal(listed({ at: "gemv/gs-2", kinds: ["finding"] }).matched, 0);
  });

  test("counts: each filter's values under the place, counted with the other filters but never its own", () => {
    const r = listed({ at: "gemv", outcomes: ["won"] });
    assert.deepEqual(r.counts.outcome, { won: 2, dropped: 1 });
    assert.deepEqual(r.counts.kind, { attempt: 1, experiment: 1 });
    assert.deepEqual(r.counts.type, { record: 2 });
    const all = listed({ at: "gemv" });
    assert.deepEqual(all.counts.type, { record: 6, blurb: 2, file: 1 });
    assert.deepEqual(all.counts.slot, { records: 6, "worker-1": 2, planner: 1 });
  });

  test("sorts by each column, both ways; a page goes as deep as the items do, with no end", () => {
    const at = "gemv/gs-1";
    assert.equal(titles(listed({ at }))[0], "Tile next", "newest change first");
    assert.equal(titles(listed({ at, sort: "modified", order: "asc" }))[0], "Run gs-1: goal, gemv");
    assert.equal(
      titles(listed({ at, sort: "name" }))[0],
      "<script>alert(1)</script> Vector loads double the bandwidth",
    );
    assert.equal(listed({ at, sort: "size" }).items[0]?.type, "file");
    assert.deepEqual(
      listed({ at, sort: "outcome" })
        .items.slice(0, 3)
        .map((x) => x.outcome),
      ["won", "won", "dropped"],
    );
    assert.equal(listed({ at, sort: "writer" }).items[0]?.slot, "planner");
    assert.equal(listed({ at, sort: "writer", order: "desc" }).items[0]?.slot, "worker-1");
    assert.equal(listed({ at, sort: "kind" }).items[0]?.kind, "attempt");
    // Pages of 3 hold every item once, in the same order.
    const whole = listed({ at }).items.map((x) => x.id);
    const pages: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = listed({ at, limit: 3, offset });
      pages.push(...page.items.map((x) => x.id));
      offset = page.next_offset;
    }
    assert.deepEqual(pages, whole);
    // Past the end, deeper than a search may page: an empty page, not a refusal.
    const deep = listed({ at, offset: 6000 });
    assert.deepEqual([deep.items.length, deep.next_offset, deep.matched], [0, null, 8]);
    const none = listed({ at, limit: 0 });
    assert.deepEqual([none.items.length, none.next_offset, none.matched], [0, null, 8]);
  });

  test("a place the knowledge base has not, or an item's address, is refused in words", () => {
    const store = new ControlStore(":memory:");
    fillKnowledge(store);
    const refused = (at: string) => {
      const r = ownerKbList(store, [], KbListQuery.parse({ at }));
      return "error" in r ? r.error : "";
    };
    assert.equal(refused("nope"), "the knowledge base has no collection nope");
    assert.equal(refused("gemv/gs-9"), "gemv has no run gs-9");
    assert.equal(refused("gemv/gs-2/worker-1"), "gemv/gs-2 has no slot worker-1");
    const item = KbListQuery.safeParse({ at: "gemv/gs-1/worker-1/finding:1" });
    assert.equal(item.success, false);
    assert.match(
      item.error?.issues[0]?.message ?? "",
      /a place is <campaign>, <campaign>\/<run> or <campaign>\/<run>\/<slot>/,
    );
    assert.equal(KbListQuery.safeParse({ limit: 201 }).success, false);
    assert.equal(KbListQuery.safeParse({ types: ["page"] }).success, false);
  });
});
