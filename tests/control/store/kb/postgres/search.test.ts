import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ControlStore } from "../../../../../src/control/store/index.ts";
import { postgresStore } from "../../../../helpers/postgres.ts";

/**
 * Search by words in control's knowledge base on PostgreSQL, until its words index is built
 * (goals 268 and 269): a plain match of the words, newest change first, within what the search
 * reads, with the same answer's shape as the search on SQLite.
 */

const RIG = { rig: "rig-a", ledger: "ledger-a" };

async function store(): Promise<ControlStore> {
  const s = postgresStore();
  let t = 0;
  const event = async (kind: string, run: string, body: Record<string, unknown>) =>
    s.kb().index(RIG, {
      at: `2026-11-14T10:${String(t++).padStart(2, "0")}:00.000Z`,
      actor: "harness",
      kind,
      subject: run,
      body,
    });
  for (const run of ["gs-1", "gs-2"]) await event("run_created", run, { campaign: "gemv" });
  await event("run_created", "other-1", { campaign: "sorting" });
  const tried = async (run: string, id: string, title: string, details: string, result: string) => {
    await event("experiment_added", run, { id, title, details, by: "planner" });
    await event("experiment_finished", run, { id, attempt: `a-${id}`, result });
  };
  await tried(
    "gs-1",
    "x-1",
    "Unroll the inner loop by 4",
    "Unrolled the dot product loop.",
    "failed",
  );
  await tried("gs-1", "x-2", "Tile by 32", "Tiles of 32 rows in shared memory.", "win confirmed");
  await tried("gs-2", "x-3", "Vector loads", "128-bit loads of the Packed weights.", "failed");
  await tried("other-1", "x-9", "Radix sort", "Packed keys sort faster.", "win confirmed");
  await event("journal_note", "gs-2", {
    id: 1,
    by: "lane-1",
    kind: "lesson",
    text: `${"The loop is hot. ".repeat(400)}Only the packed loads matter in the end.`,
  });
  return s;
}

describe("a search of the knowledge base on PostgreSQL", () => {
  test("finds the items that hold a word, whatever its case, within what it reads, the newest first", async () => {
    const s = await store();
    const kb = s.kb();
    const r = await kb.find("PACKED", [{ campaign: "gemv" }]);
    assert.deepEqual(
      r.hits.map((h) => [h.run, h.kind, h.ref]),
      [
        ["gs-2", "note", "1"],
        ["gs-2", "experiment", "x-3"],
      ],
      "the other collection's item is not read",
    );
    assert.equal(r.matched, 2);
    assert.equal(r.next_offset, null);
    assert.deepEqual(r.words, [{ word: "packed", items: 2 }]);
    assert.deepEqual(r.did_you_mean, [], "a suggestion needs the words index");
    assert.deepEqual(r.counts.kind, { experiment: 1, note: 1 });
    assert.deepEqual(r.counts.run, { "gs-2": 2 });
    // One run's items alone, and a filter.
    const one = await kb.find("loop", [{ campaign: "gemv", run: "gs-1" }], {
      kinds: ["experiment"],
    });
    assert.deepEqual(
      one.hits.map((h) => h.ref),
      ["x-1"],
    );
    await s.close();
  });

  test("a hit has its words in bold, why it matched, and its passage in a long text", async () => {
    const s = await store();
    const r = await s.kb().find("packed loads", [{ campaign: "gemv" }]);
    const note = r.hits.find((h) => h.kind === "note");
    const experiment = r.hits.find((h) => h.ref === "x-3");
    assert.match(experiment?.excerpt ?? "", /128-bit \*\*loads\*\* of the \*\*Packed\*\* weights/);
    assert.match(experiment?.why ?? "", /^the title has loads; the text has packed, loads/);
    assert.equal(experiment?.passage, null, "a short text is one passage");
    assert.match(note?.excerpt ?? "", /^….*Only the \*\*packed\*\* \*\*loads\*\* matter/s);
    assert.ok(note?.passage && note.passage.of > 1 && note.passage.n === note.passage.of);
    assert.ok((note?.passage?.from ?? 0) > 1000);
    await s.close();
  });

  test("no words: the newest items; a word none holds: nothing; pages by offset", async () => {
    const s = await store();
    const kb = s.kb();
    const newest = await kb.find("", [{ campaign: "gemv" }], { limit: 2 });
    assert.equal(newest.hits.length, 2);
    assert.equal(newest.hits[0]?.kind, "note");
    assert.ok((newest.matched ?? 0) > 2);
    assert.equal(newest.next_offset, 2);
    const none = await kb.find("zanzibarite", [{ campaign: "gemv" }]);
    assert.deepEqual(
      [none.matched, none.hits, none.words],
      [0, [], [{ word: "zanzibarite", items: 0 }]],
    );
    const second = await kb.find("the", [{ campaign: "gemv" }], { limit: 1, offset: 1 });
    assert.equal(second.hits.length <= 1, true);
    await s.close();
  });

  test("an exact search is refused in words until the index is built", async () => {
    const s = await store();
    const r = await s.kb().find('"packed weights"', [{ campaign: "gemv" }], { mode: "exact" });
    assert.deepEqual(r.hits, []);
    assert.match(
      r.refused ?? "",
      /an exact search needs the knowledge base's words index, which a store on PostgreSQL does not have yet: search by words/,
    );
    await s.close();
  });
});
