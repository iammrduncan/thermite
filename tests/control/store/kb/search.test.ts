import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ControlStore } from "../../../../src/control/store/index.ts";
import { searchTerms } from "../../../../src/control/store/kb/index.ts";

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
    // The experiment with more of the words first, then the other failed one; the win and the other
    // campaign's item are not found; the note on rebuilds has one word only, and comes after them.
    assert.deepEqual(refs.slice(0, 2), ["gs-2/experiment:x-3", "gs-1/experiment:x-1"]);
    assert.ok(!refs.includes("gs-1/experiment:x-2"), "the win has none of the words");
    assert.ok(
      refs.every((x) => !x.startsWith("other-1/")),
      "another collection is not searched",
    );
    assert.equal(r.matched, r.hits.length);
    const [top, next] = r.hits;
    assert.match(top?.excerpt ?? "", /\*\*failed\*\* to \*\*improve\*\* \*\*speed\*\*/);
    assert.match(top?.why ?? "", /the text has failed, improve, speed/);
    assert.match(next?.excerpt ?? "", /\*\*failed\*\*: no \*\*speed\*\* gain/);
    assert.equal(top?.slot, "records");
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
