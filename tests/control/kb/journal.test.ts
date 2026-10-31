import assert from "node:assert/strict";
import { test } from "node:test";
import { readKnowledgeAgain } from "../../../src/control/events/index.ts";
import type { ControlStore } from "../../../src/control/store/index.ts";
import { fieldNote, journalTab } from "../../../src/control/ui/knowledge/index.ts";
import { rigView } from "../../../src/control/views/index.ts";
import { assigned } from "../../helpers/assignments.ts";
import { busOf, controlStore, ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 176: each records item keeps the lane and the trial its events name, as fields; a store
 * from an earlier reading gives the items it kept theirs, in place, once; and the run's Journal
 * tab reads its field notes from the knowledge base.
 */

type Ev = [string, string, string, Record<string, unknown>];

async function ingest(store: ControlStore, rig: string, events: Ev[]) {
  await ingestReport(store, {
    rig,
    ledger_id: `ledger-${rig}`,
    cursor: 0,
    next: events.length,
    generated_at: "2026-10-20T01:00:00.000Z",
    events: events.map(([actor, kind, subject, body], i) => ({
      id: i + 1,
      at: new Date(Date.parse("2026-10-20T01:00:00Z") + i * 60_000).toISOString(),
      actor,
      kind,
      subject,
      body,
    })),
    summary: {},
  });
}

/** A goal run with a trial, two field notes (one in a trial), a research note and a hypothesis. */
async function aRun() {
  const store = controlStore();
  assigned(store, "rig-a", "gs-3", "gemv-speed");
  await ingest(store, "rig-a", [
    ["harness", "run_created", "gs-3", { campaign: "gemv-speed", mode: "goal" }],
    ["scheduler", "trial_started", "gs-3", { trial: "t-1", lane: "lane-1", family: "loads" }],
    [
      "lane-1",
      "journal_note",
      "gs-3",
      {
        id: 1,
        by: "lane-1",
        kind: "decision",
        text: "Kept the old path below n = 4096",
        about: { type: "experiment", id: "x-1" },
        lane: "lane-1",
        trial: "t-1",
      },
    ],
    ["planner", "journal_note", "gs-3", { id: 2, by: "planner", kind: "lesson", text: "Plain." }],
    [
      "lane-1",
      "research_note",
      "gs-3",
      { note: 3, by: "lane-1", text: "The GPU has 4 MB of L2.", sources: ["s-1"], trial: "t-1" },
    ],
    ["lane-2", "hypothesis_added", "gs-3", { hypothesis: "h-1", lane: "lane-2", text: "Loads." }],
    ["lane-2", "hypothesis_status", "gs-3", { hypothesis: "h-1", status: "supported" }],
  ]);
  return store;
}

const meta = (store: ControlStore, kind: string, ref: string) =>
  JSON.parse(
    String(
      (
        store.db.prepare("select meta from kb_item where kind = ? and ref = ?").get(kind, ref) as {
          meta: string;
        }
      ).meta,
    ),
  ) as Record<string, string>;

test("each records item keeps the lane and the trial its events name, as fields", async () => {
  const store = await aRun();
  assert.deepEqual(meta(store, "note", "1"), {
    about_type: "experiment",
    about_id: "x-1",
    lane: "lane-1",
    trial: "t-1",
  });
  // A note written outside a trial has none; a note about nothing named is about its run.
  assert.deepEqual(meta(store, "note", "2"), { about_type: "run", about_id: "gs-3" });
  assert.equal(meta(store, "note", "rn-3").trial, "t-1");
  assert.deepEqual(meta(store, "trial", "t-1"), { lane: "lane-1", trial: "t-1" });
  // A later event that names neither keeps them.
  assert.equal(meta(store, "hypothesis", "h-1").lane, "lane-2");
});

test("a store from an earlier reading gives the items it kept their lane and trial, in place, once", async () => {
  const store = await aRun();
  const kb = store.kb();
  const row = (kind: string, ref: string) =>
    store.db
      .prepare("select seq, version, body, updated_at from kb_item where kind = ? and ref = ?")
      .get(kind, ref) as Record<string, unknown>;
  // As reading 3 left the store: no lane, trial or what a note is about in any item's fields.
  store.db.exec(
    "update kb_item set meta = json_remove(meta, '$.lane', '$.trial', '$.about_type', '$.about_id')",
  );
  store.db.exec("update kb_meta set value = '3' where key = 'reading'");
  const before = { note: row("note", "1"), hypothesis: row("hypothesis", "h-1") };
  const versions = () =>
    Number((store.db.prepare("select count(*) as n from kb_version").get() as { n: number }).n);
  const kept = versions();
  const kinds = kb.kindsToReadAgain();
  for (const k of ["journal_note", "research_note", "trial_started", "hypothesis_added"])
    assert.ok(kinds.includes(k), k);
  assert.ok(!kinds.includes("run_created") && !kinds.includes("hypothesis_status"));
  await readKnowledgeAgain(store, busOf(store).bus);
  assert.deepEqual(meta(store, "note", "1"), {
    about_type: "experiment",
    about_id: "x-1",
    lane: "lane-1",
    trial: "t-1",
  });
  assert.equal(meta(store, "trial", "t-1").lane, "lane-1");
  assert.equal(meta(store, "note", "rn-3").trial, "t-1");
  // In place: no version is added, and no item's text, time or seq changes. The hypothesis read
  // again keeps the status a later event gave it.
  assert.equal(versions(), kept);
  assert.deepEqual(row("note", "1"), before.note);
  assert.deepEqual(row("hypothesis", "h-1"), before.hypothesis);
  assert.equal(meta(store, "hypothesis", "h-1").lane, "lane-2");
  assert.deepEqual(kb.kindsToReadAgain(), []);
  assert.equal(await readKnowledgeAgain(store, busOf(store).bus), 0, "once only");
});

test("the Journal tab reads its field notes from the knowledge base, with each note's trial", async () => {
  const store = await aRun();
  const field = store.kb().fieldNotes("rig-a", "ledger-rig-a", "gs-3", 500);
  // Field notes only, newest first: the research note is not one.
  assert.equal(field.total, 2);
  assert.deepEqual(
    field.items.map((x) => x.ref),
    ["2", "1"],
  );
  const note = fieldNote(field.items[1] as (typeof field.items)[number]);
  assert.deepEqual(note, {
    id: 1,
    by: "lane-1",
    kind: "decision",
    text: "Kept the old path below n = 4096",
    about: { type: "experiment", id: "x-1" },
    lane: "lane-1",
    trial: "t-1",
    at: "2026-10-20T01:02:00.000Z",
  });
  const r = rigView(store, "rig-a")?.runs.find((x) => x.id === "gs-3");
  assert.ok(r);
  const html = journalTab({
    r,
    now: Date.parse("2026-10-21T00:00:00Z"),
    field,
    counts: {},
    reads: [],
  });
  assert.match(
    html,
    /Kept the old path below n = 4096<\/div><div class="jctx">[^<]*<a [^>]*>experiment x-1<\/a> · trial t-1<\/div>/,
  );
  assert.match(html, /<span>Field notes<\/span><b>2<\/b>/);
  // Only what the knowledge base gives: a page of one says how many there are, and where.
  const one = journalTab({
    r,
    now: Date.parse("2026-10-21T00:00:00Z"),
    field: store.kb().fieldNotes("rig-a", "ledger-rig-a", "gs-3", 1),
    counts: {},
    reads: [],
  });
  assert.doesNotMatch(one, /Kept the old path/);
  assert.match(
    one,
    /The newest 1 of 2\. All of them are in the run&#39;s records|The newest 1 of 2\. All of them are in the run's records/,
  );
  assert.match(one, /<span>Field notes<\/span><b>2<\/b>/);
});
