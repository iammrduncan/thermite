import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ControlStore } from "../../../../src/control/store/index.ts";
import { searchTerms } from "../../../../src/control/store/kb/index.ts";
import { itemsMatching } from "../../../../src/control/store/kb/vocab.ts";

/**
 * Search by words in control's knowledge base (goal 175): the words index read with BM25, each hit
 * with an excerpt of its text around the words that matched and why it matched, within the
 * collections or runs it is told; no words, the newest.
 */

const RIG = { rig: "rig-a", ledger: "ledger-a" };

/** One event of the run's, as the apply hands it to the knowledge base. */
function event(
  store: ControlStore,
  kind: string,
  run: string,
  body: Record<string, unknown>,
  at: string,
) {
  store.kb().index(RIG, { at, actor: "harness", kind, subject: run, body });
}

/** A collection of two runs: experiments tried, with what they gave, and a field note. */
function store(): ControlStore {
  const s = new ControlStore(":memory:");
  let t = 0;
  const at = () => `2026-10-29T10:${String(t++).padStart(2, "0")}:00.000Z`;
  for (const run of ["gs-1", "gs-2"])
    event(s, "run_created", run, { campaign: "gemv", mode: "hill_climb" }, at());
  event(s, "run_created", "other-1", { campaign: "sorting", mode: "hill_climb" }, at());
  const tried = (run: string, id: string, title: string, details: string, result: string) => {
    event(s, "experiment_added", run, { id, title, details, by: "planner" }, at());
    event(s, "experiment_finished", run, { id, attempt: `a-${id}`, result }, at());
  };
  tried(
    "gs-1",
    "x-1",
    "Unroll the inner loop by 4",
    "Unrolled the dot product loop.",
    "failed: no speed gain, 3% slower",
  );
  tried(
    "gs-1",
    "x-2",
    "Tile by 32",
    "Tiles of 32 rows in shared memory.",
    "win confirmed (+6.10%)",
  );
  tried(
    "gs-2",
    "x-3",
    "Vector loads",
    "128-bit loads of the packed weights.",
    "failed to improve speed: loss confirmed (-2.00%)",
  );
  tried("other-1", "x-9", "Radix sort", "A radix sort failed to improve speed.", "failed");
  event(
    s,
    "journal_note",
    "gs-2",
    { id: 7, kind: "observation", text: "The build cache speeds up rebuilds a lot.", by: "lane-1" },
    at(),
  );
  return s;
}

describe("search by words in the knowledge base", () => {
  test("which approaches failed to improve speed: the failed experiments, ranked by BM25, with excerpts and why", () => {
    const s = store();
    const r = s.kb().find("which approaches failed to improve speed", [{ campaign: "gemv" }]);
    const refs = r.hits.map((x) => `${x.run}/${x.kind}:${x.ref}`);
    // The two failed experiments first ("failed" also finds "slower", Thermite's own word); the win
    // and the other campaign's item are not found; the note on rebuilds has one word only, and
    // comes after them.
    assert.deepEqual(refs.slice(0, 2).sort(), ["gs-1/experiment:x-1", "gs-2/experiment:x-3"]);
    assert.ok(!refs.includes("gs-1/experiment:x-2"), "the win has none of the words");
    assert.ok(
      refs.every((x) => !x.startsWith("other-1/")),
      "another collection is not searched",
    );
    assert.equal(r.matched, r.hits.length);
    const x3 = r.hits.find((x) => x.ref === "x-3");
    const x1 = r.hits.find((x) => x.ref === "x-1");
    assert.match(x3?.excerpt ?? "", /\*\*failed\*\* to \*\*improve\*\* \*\*speed\*\*/);
    assert.match(x3?.why ?? "", /the text has failed, improve, speed/);
    assert.match(x1?.excerpt ?? "", /\*\*failed\*\*: no \*\*speed\*\* gain, 3% \*\*slower\*\*/);
    assert.equal(x3?.slot, "records");
    assert.equal(x3?.passage, null, "a short text is one passage");
    // How many items of the scope hold each word, and where they land.
    assert.deepEqual(
      r.words.map((w) => w.word),
      ["approaches", "failed", "improve", "speed"],
    );
    assert.equal(r.words.find((w) => w.word === "approaches")?.items, 0);
    assert.equal(r.counts.kind.experiment, 2);
  });

  test("a search reads only where it is told: a run of a collection, or several collections", () => {
    const s = store();
    const kb = s.kb();
    assert.deepEqual(
      kb.find("failed speed", [{ campaign: "gemv", run: "gs-1" }]).hits.map((x) => x.ref),
      ["x-1"],
    );
    assert.deepEqual(
      kb
        .find("failed speed", [{ campaign: "gemv", run: "gs-1" }, { campaign: "sorting" }])
        .hits.map((x) => x.ref)
        .sort(),
      ["x-1", "x-9"],
    );
    assert.deepEqual(kb.find("failed", []).hits, []);
    // Kinds keep those kinds.
    assert.deepEqual(
      kb.find("speed", [{ campaign: "gemv" }], { kinds: ["note"] }).hits.map((x) => x.kind),
      ["note"],
    );
  });

  test("no words: the newest items, with the start of their text; common words alone are none", () => {
    const s = store();
    const r = s.kb().find("", [{ campaign: "gemv" }], { limit: 2 });
    assert.equal(r.hits.length, 2);
    assert.ok(r.matched > 2);
    assert.equal(r.hits[0]?.why, "");
    assert.deepEqual(searchTerms("Which of the approaches FAILED, to improve speed?"), [
      "approaches",
      "failed",
      "improve",
      "speed",
    ]);
    assert.deepEqual(searchTerms("the and of"), []);
    // A word FTS5 would read as an operator is only a word here.
    assert.doesNotThrow(() => s.kb().find('NEAR OR "x" AND (', [{ campaign: "gemv" }]));
  });
});

/**
 * A collection to probe: experiments that won, regressed and were dropped, near-twin notes, a long
 * page with one fact in its middle, and another campaign's collection that no search here reads.
 */
function probed(): ControlStore {
  const s = new ControlStore(":memory:");
  let t = 0;
  const at = () => `2026-10-29T11:${String(t++).padStart(2, "0")}:00.000Z`;
  for (const [run, campaign] of [
    ["gs-1", "gemv"],
    ["gs-2", "gemv"],
    ["hid-1", "hidden"],
  ] as const)
    event(s, "run_created", run, { campaign, mode: "hill_climb" }, at());
  const tried = (run: string, id: string, title: string, verdict: string) => {
    event(s, "experiment_added", run, { id, title, by: "planner" }, at());
    event(s, "attempt_recorded", `a-${id}`, { run, hypothesis: title, lane: "lane-1" }, at());
    event(s, "experiment_finished", run, { id, attempt: `a-${id}`, result: "submitted" }, at());
    event(s, "verdict", `a-${id}`, { run, verdict }, at());
  };
  tried("gs-1", "x-1", "Vector loads of the packed weights", "win_confirmed");
  tried("gs-1", "x-2", "Unroll the dot product loop", "regress");
  tried("gs-2", "x-3", "Shared memory tiles of 32 rows", "neutral");
  event(
    s,
    "experiment_added",
    "gs-2",
    { id: "x-4", title: "Split the reduction", by: "planner" },
    at(),
  );
  event(s, "experiment_dropped", "gs-2", { id: "x-4", why: "the lanes tried it in gs-1" }, at());
  for (const [id, text] of [
    [1, "Bank conflicts on the tile cost 12% of the loop."],
    [2, "Bank conflicts on the tile cost 3% of the loop."],
    [3, "Bank conflicts on the tile cost 7% of the loop."],
  ] as const)
    event(s, "journal_note", "gs-1", { id, kind: "observation", text, by: "lane-2" }, at());
  const filler = "The warp scheduler issues one instruction per cycle on each partition. ";
  event(
    s,
    "source_fetched",
    "gs-2",
    {
      source: "s-1",
      title: "Notes on the memory system",
      url: "https://example.org/memory",
      text: `${filler.repeat(60)}The L2 cache holds 50 MB on this card, said the vendor. ${filler.repeat(60)}`,
    },
    at(),
  );
  event(
    s,
    "journal_note",
    "hid-1",
    { id: 1, kind: "lesson", text: "Quantization hurt.", by: "lane-1" },
    at(),
  );
  return s;
}

const gemv = [{ campaign: "gemv" }];

describe("an agent's probes of the knowledge base", () => {
  test("the outcome is a field: kept by a filter, counted with every search", () => {
    const kb = probed().kb();
    const r = kb.find("", gemv, { kinds: ["experiment"], outcomes: ["regress", "dropped"] });
    assert.deepEqual(r.hits.map((h) => [h.ref, h.outcome]).sort(), [
      ["x-2", "regress"],
      ["x-4", "dropped"],
    ]);
    // The counts are of what the scope holds, before the filters.
    assert.deepEqual(r.counts.outcome, { dropped: 1, neutral: 2, regress: 2, won: 2 });
    assert.equal(r.counts.collection.hidden, undefined, "another collection is never counted");
    assert.equal(r.matched, 2);
  });

  test("failed, slower and faster also find the words Thermite's records use; the exact mode does not", () => {
    const kb = probed().kb();
    const failed = kb.find("failed", gemv, { kinds: ["experiment"] }).hits.map((h) => h.ref);
    assert.deepEqual(failed.sort(), ["x-2", "x-3", "x-4"]);
    const faster = kb.find("faster", gemv, { kinds: ["attempt"] }).hits.map((h) => h.ref);
    assert.deepEqual(faster, ["a-x-1"]);
    assert.deepEqual(kb.find("faster", gemv, { mode: "exact" }).hits, []);
  });

  test("the exact mode takes FTS5's syntax; a query it can't read is answered in words", () => {
    const kb = probed().kb();
    const refs = (q: string) =>
      kb
        .find(q, gemv, { mode: "exact" })
        .hits.map((h) => h.ref)
        .sort();
    assert.deepEqual(refs('"bank conflicts" NOT "12%"'), ["2", "3"]);
    assert.deepEqual(refs("unrol*"), ["a-x-2", "x-2"]);
    assert.deepEqual(refs("context: dropped"), ["x-4"]);
    assert.deepEqual(refs("NEAR(vector weights, 4)"), ["a-x-1", "x-1"]);
    const bad = kb.find('"vector AND (', gemv, { mode: "exact" });
    assert.match(bad.refused ?? "", /^the exact search is not FTS5's query syntax.*SQLite said: /);
    assert.deepEqual(bad.hits, []);
    assert.match(kb.find("nowhere: x", gemv, { mode: "exact" }).refused ?? "", /no such column/);
    // The forgiving mode reads the same as words.
    assert.equal(kb.find('"vector AND (', gemv).refused, undefined);
  });

  test("a long page is searched by passages: the hit names the one that matched, and its excerpt is there", () => {
    const kb = probed().kb();
    const [hit] = kb.find("L2 cache", gemv).hits;
    assert.equal(hit?.ref, "s-1");
    assert.ok(
      hit?.passage && hit.passage.of >= 3 && hit.passage.n > 1,
      JSON.stringify(hit?.passage),
    );
    assert.match(hit?.excerpt ?? "", /\*\*L2\*\* \*\*cache\*\* holds 50 MB/);
    const text = kb.at("gemv/gs-2/records/source:s-1")?.body ?? "";
    assert.match(text.slice(hit?.passage?.from, hit?.passage?.to), /L2 cache holds 50 MB/);
  });

  test("pages: how many matched, and where the next page starts", () => {
    const kb = probed().kb();
    const first = kb.find("bank conflicts", gemv, { limit: 2 });
    assert.equal(first.matched, 3);
    assert.equal(first.hits.length, 2);
    assert.equal(first.next_offset, 2);
    const next = kb.find("bank conflicts", gemv, { limit: 2, offset: 2 });
    assert.equal(next.hits.length, 1);
    assert.equal(next.next_offset, null);
    assert.ok(!first.hits.some((h) => h.id === next.hits[0]?.id));
  });

  test("several queries fused, items seen left out, and more like one item", () => {
    const kb = probed().kb();
    const both = kb.find(["vector loads", "unroll loop"], gemv, { kinds: ["experiment"] });
    assert.deepEqual(both.hits.map((h) => h.ref).sort(), ["x-1", "x-2"]);
    const seen = kb.find("bank conflicts", gemv, { seen: ["gemv/gs-1/records/note:1"] });
    assert.deepEqual(seen.hits.map((h) => h.ref).sort(), ["2", "3"]);
    assert.equal(seen.matched, 2);
    const like = kb.find("", gemv, { like: "gemv/gs-1/records/note:2" });
    // Its near twins first; the item itself never.
    assert.deepEqual(
      like.hits
        .slice(0, 2)
        .map((h) => h.ref)
        .sort(),
      ["1", "3"],
    );
    assert.ok(!like.hits.some((h) => h.ref === "2" && h.kind === "note"));
    assert.ok(like.like?.includes("bank"), like.like?.join(" "));
    // An item out of the scope is not a seed.
    assert.match(
      kb.find("", gemv, { like: "hidden/hid-1/records/note:1" }).refused ?? "",
      /^no item hidden\/hid-1\/records\/note:1 in what this search reads/,
    );
  });

  test("how many items hold each word, and words close to one none holds, from the scope alone", () => {
    const kb = probed().kb();
    const r = kb.find("vectr conflicts", gemv);
    assert.deepEqual(r.words, [
      { word: "vectr", items: 0 },
      { word: "conflicts", items: 3 },
    ]);
    assert.deepEqual(r.did_you_mean, [{ word: "vectr", try: [{ word: "vector", items: 2 }] }]);
    // A word's items are counted up to a limit, so a common word costs no more than a rare one.
    const s = probed();
    const gemvOnly = { sql: "i.campaign = ?", args: ["gemv"] };
    assert.equal(itemsMatching(s.db, '"conflicts"', gemvOnly), 3);
    assert.equal(itemsMatching(s.db, '"conflicts"', gemvOnly, 2), 2);
    // A word only another collection holds is never offered.
    assert.deepEqual(kb.find("quantisation", gemv).did_you_mean, []);
    assert.deepEqual(kb.find("quantisation", [{ campaign: "hidden" }]).did_you_mean, [
      { word: "quantisation", try: [{ word: "quantization", items: 1 }] },
    ]);
  });
});
