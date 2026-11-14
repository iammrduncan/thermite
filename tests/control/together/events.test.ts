import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readKnowledgeAgain } from "../../../src/control/events/index.ts";
import { rowsBehind, writeBehind } from "../../../src/control/store/behind.ts";
import type { ControlStore } from "../../../src/control/store/index.ts";
import { EVENT_STREAM } from "../../../src/core/link/events.ts";
import { assigned } from "../../helpers/assignments.ts";
import { busOf, controlStore, ingestReport } from "../../helpers/control-store.ts";
import { rowsOf, WRITE_FAILED, watched } from "../../helpers/together.ts";

/**
 * The transactions of the apply of the events stream that are inside another (control/events/):
 * one event's items in the knowledge base are a savepoint of its page's transaction, dropped
 * alone when the event is indexed only in part, with the rest of the page kept; and the events
 * read again after an upgrade of the knowledge base's reading are kept a page at a time, each
 * one a savepoint too. The page's own transaction, with the stream's place, is proved in
 * tests/system/events-apply.test.ts.
 */

type Ev = {
  id: number;
  actor?: string;
  kind: string;
  subject?: string | null;
  body?: unknown;
};

/** A page of rig-a's ledger l-1, taken as a report that passed control's checks is. */
async function page(store: ControlStore, events: Ev[]): Promise<void> {
  const first = events[0]?.id ?? 1;
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "l-1",
    cursor: first - 1,
    next: events.at(-1)?.id ?? first,
    generated_at: new Date().toISOString(),
    summary: {},
    events: events.map((e) => ({
      id: e.id,
      at: new Date(Date.UTC(2026, 9, 29, 5, 0, 0, e.id)).toISOString(),
      actor: e.actor ?? "harness",
      kind: e.kind,
      subject: e.subject ?? "gs-1",
      body: e.body ?? {},
      run: "gs-1",
    })),
  });
}

const note = (id: number, n: number, text: string, more: Record<string, unknown> = {}): Ev => ({
  id,
  actor: "lane-1",
  kind: "journal_note",
  body: { id: n, by: "lane-1", kind: "lesson", text, ...more },
});

/** The knowledge base's items whose text has `word`, as the database has them now. */
const itemsWith = async (store: ControlStore, word: string) =>
  (await rowsOf(store, "kb_item")).filter((r) => String(r.body).includes(word)).length;

type Index = ReturnType<ControlStore["kb"]>["index"];

/**
 * Has the knowledge base index the events `fails` names only in part: the store's own call
 * writes the event's items, and then fails. Gives how many of those events were written before
 * they failed, and the function that puts the store's call back.
 */
function indexInPart(
  store: ControlStore,
  fails: (e: { id?: number }) => boolean | Promise<boolean>,
) {
  const kb = store.kb();
  const own = kb.index;
  const seen = { written: 0 };
  (kb as { index: Index }).index = async (src, e, o) => {
    await own(src, e, o);
    if (!(await fails(e as { id?: number }))) return;
    seen.written++;
    throw new Error(WRITE_FAILED);
  };
  return {
    seen,
    putBack: () => {
      (kb as { index: Index }).index = own;
    },
  };
}

describe("an event's items in the knowledge base, inside its page's transaction", () => {
  test("applyEvent: an event indexed in part is dropped alone; the rest of its page is kept", async () => {
    const store = controlStore();
    await assigned(store, "rig-a", "gs-1", "gemv");
    await page(store, [{ id: 1, kind: "run_created", body: { campaign: "gemv" } }]);
    // The second event's note is written, and then its indexing fails.
    let there = 0;
    const part = indexInPart(store, async (e) => {
      if (e.id !== 2) return false;
      there = await itemsWith(store, "zanzibarite");
      return true;
    });
    await page(store, [
      note(2, 1, "zanzibarite loads help"),
      note(3, 2, "quokkaite stores do not"),
    ]);
    part.putBack();
    assert.equal(part.seen.written, 1);
    assert.equal(there, 1, "the note was in the store when its indexing failed");
    assert.equal(await itemsWith(store, "zanzibarite"), 0, "the event's own writes were dropped");
    assert.deepEqual(await store.kb().search("zanzibarite", ["gemv"]), []);
    // The page itself is kept: the event after it, the stream's place and the ledger's cursor.
    assert.equal(await itemsWith(store, "quokkaite"), 1);
    assert.equal((await store.kb().search("quokkaite", ["gemv"])).length, 1);
    assert.equal(await store.busPositions.of(EVENT_STREAM), 3);
    assert.equal(await store.reportedRigs.heldCursor("rig-a", "l-1"), 3);
    // And the failure is noted in the audit log, in the page's transaction, after the savepoint.
    assert.deepEqual(
      (await store.auditLog.list(10, { action: "kb_failed" })).map((a) => a.body),
      [{ rig: "rig-a", error: WRITE_FAILED }],
    );

    // With the store's own call back, an event's items are kept with its page.
    await page(store, [note(4, 3, "wombatite prefetch helps")]);
    assert.equal(await itemsWith(store, "wombatite"), 1);
    assert.equal(await store.busPositions.of(EVENT_STREAM), 4);
    assert.equal((await store.auditLog.list(10, { action: "kb_failed" })).length, 1);
  });

  test("applyEvent: a writer's item stored in part is dropped alone; the rest of its page is kept", async () => {
    const store = controlStore();
    await assigned(store, "rig-a", "gs-1", "gemv");
    await page(store, [{ id: 1, kind: "run_created", body: { campaign: "gemv" } }]);
    // worker-1's finding is written in its slot, and then the store's write fails.
    const kb = store.kb();
    const own = kb.write;
    let there = 0;
    (kb as { write: typeof own }).write = async (src, b) => {
      const refused = await own(src, b);
      there = await itemsWith(store, "zanzibarite");
      throw new Error(`${WRITE_FAILED}${refused ? `: ${refused}` : ""}`);
    };
    await page(store, [
      {
        id: 2,
        actor: "worker-1",
        kind: "kb_item",
        body: {
          slot: "worker-1",
          item: 1,
          version: 1,
          kind: "finding",
          title: "Vector loads",
          text: "zanzibarite loads double the bandwidth",
          links: [],
        },
      },
      note(3, 1, "quokkaite stores do not"),
    ]);
    (kb as { write: typeof own }).write = own;
    assert.equal(there, 1, "the finding was in the store when its write failed");
    assert.equal(await itemsWith(store, "zanzibarite"), 0, "the event's own writes were dropped");
    assert.equal(await itemsWith(store, "quokkaite"), 1, "the event after it is kept");
    assert.equal(await store.busPositions.of(EVENT_STREAM), 3);
    assert.deepEqual(
      (await store.auditLog.list(10, { action: "kb_failed" })).map((a) => a.body),
      [{ rig: "rig-a", error: WRITE_FAILED }],
    );
  });
});

/** The fields the knowledge base keeps apart for an item of rig-a's run. */
const meta = async (store: ControlStore, kind: string, ref: string) =>
  JSON.parse(
    String(
      (await rowsBehind(store, "select meta from kb_item where kind = ? and ref = ?", kind, ref))[0]
        ?.meta,
    ),
  ) as Record<string, string>;

/** The store as an earlier reading left it: no lane or trial in any item's fields. */
async function asReadingBefore(store: ControlStore): Promise<void> {
  for (const r of await rowsBehind(store, "select id, meta from kb_item")) {
    const { lane: _lane, trial: _trial, ...kept } = JSON.parse(String(r.meta));
    await writeBehind(
      store,
      "update kb_item set meta = ? where id = ?",
      JSON.stringify(kept),
      r.id,
    );
  }
  await writeBehind(store, "update kb_meta set value = '3' where key = 'reading'");
}

describe("the events read again for a new reading of the knowledge base", () => {
  test("readKnowledgeAgain: a page's events are kept together, and one indexed in part is dropped alone", async () => {
    const store = controlStore();
    await assigned(store, "rig-a", "gs-1", "gemv");
    await page(store, [
      { id: 1, kind: "run_created", body: { campaign: "gemv", mode: "goal" } },
      {
        id: 2,
        actor: "scheduler",
        kind: "trial_started",
        body: { trial: "t-1", lane: "lane-1", direction: "loads" },
      },
      note(3, 1, "zanzibarite loads help", { lane: "lane-1", trial: "t-1" }),
      note(4, 2, "quokkaite stores do not", { lane: "lane-1", trial: "t-1" }),
    ]);
    assert.equal((await meta(store, "note", "1")).lane, "lane-1");
    await asReadingBefore(store);
    assert.equal((await meta(store, "note", "1")).lane, undefined);
    assert.equal((await meta(store, "trial", "t-1")).lane, undefined);

    // The first note is read again, its fields written, and then its indexing fails.
    let there: string | undefined;
    const part = indexInPart(store, async (e) => {
      if (e.id !== 3) return false;
      there = (await meta(store, "note", "1")).lane;
      return true;
    });
    const read = await watched(store, () => readKnowledgeAgain(store, busOf(store).bus));
    part.putBack();
    assert.equal(read.threw, undefined, "an event that fails is passed over");
    assert.equal(part.seen.written, 1);
    assert.equal(there, "lane-1", "the note had its fields when its indexing failed");
    assert.equal((await meta(store, "note", "1")).lane, undefined, "its own writes were dropped");
    // One transaction held the page: the other events' fields are kept with it.
    assert.equal(read.txs.length, 1);
    assert.equal(read.txs[0]?.failed, false);
    assert.ok(read.txs[0]?.changed.includes("kb_item"), String(read.txs[0]?.changed));
    assert.equal((await meta(store, "trial", "t-1")).lane, "lane-1");
    assert.equal((await meta(store, "note", "2")).lane, "lane-1");
    assert.equal(read.out, 2, "the trial and the second note");

    // With the store's own call back, the same event read again is kept.
    await asReadingBefore(store);
    const again = await watched(store, () => readKnowledgeAgain(store, busOf(store).bus));
    assert.equal(again.out, 3);
    assert.equal(again.txs.length, 1);
    assert.equal((await meta(store, "note", "1")).lane, "lane-1");
    assert.equal((await meta(store, "note", "1")).trial, "t-1");
  });
});
