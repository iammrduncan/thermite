import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ControlStore } from "../../../../src/control/store/index.ts";
import { withKnowledgeBaseBefore175 } from "../../../helpers/old-store.ts";

/**
 * The knowledge base's hierarchy, store migration 14 (goal 175): a store's items from before move
 * into the records slot of their runs, as version 1, keeping their ids and seqs, so a rig's cursor
 * reads on where it was; each campaign control knows gets its collection; the words index holds
 * every item.
 */

const fresh = () => join(mkdtempSync(join(tmpdir(), "thermite-store-")), "control.db");

const item = (
  id: number,
  seq: number,
  o: Partial<{
    campaign: string;
    run: string;
    kind: string;
    ref: string;
    title: string;
    body: string;
  }> = {},
) => ({
  id,
  seq,
  campaign: o.campaign ?? "gemv",
  rig: "rig-a",
  ledger: "ledger-a",
  run: o.run ?? "gs-1",
  kind: o.kind ?? "note",
  ref: o.ref ?? String(id),
  title: o.title ?? `note ${id}`,
  body: o.body ?? `body of ${id}`,
});

describe("the knowledge base's hierarchy (store migration 14)", () => {
  test("a store's items go into their runs' records slots, with their ids and seqs; the rigs' cursors read on as before", () => {
    const path = fresh();
    const old = new ControlStore(path);
    // A campaign saved on control with no run yet, and one known only by a rig's runs.
    old.campaigns.put({ campaign: "saved", version: 1, contract: {}, sha: "a", by: "owner:ui" });
    withKnowledgeBaseBefore175(
      old.db,
      [
        item(1, 4, {
          kind: "experiment",
          ref: "x-1",
          title: "Vector loads",
          body: "128-bit loads of the weights",
        }),
        item(2, 9, { kind: "note", ref: "1", body: "The L2 is 4 MB" }),
        // Deleted before: its id is never given again.
        item(7, 12, {
          campaign: "survey",
          run: "sv-1",
          kind: "finding",
          ref: "f-1",
          body: "a verifier helps",
        }),
      ],
      {
        itemSeq: 15,
        runs: [
          { rig: "rig-a", ledger: "ledger-a", run: "gs-1", campaign: "gemv" },
          { rig: "rig-a", ledger: "ledger-a", run: "sv-1", campaign: "survey" },
          { rig: "rig-b", ledger: "ledger-b", run: "empty-1", campaign: "only-runs" },
        ],
      },
    );
    old.db.close();

    const store = new ControlStore(path);
    const v = store.db.prepare("select max(version) as v from schema_migrations").get() as {
      v: number;
    };
    assert.equal(v.v, 18);
    const rows = store.db
      .prepare("select id, seq, slot, version, kind, ref from kb_item order by id")
      .all() as Record<string, unknown>[];
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        { id: 1, seq: 4, slot: "records", version: 1, kind: "experiment", ref: "x-1" },
        { id: 2, seq: 9, slot: "records", version: 1, kind: "note", ref: "1" },
        { id: 7, seq: 12, slot: "records", version: 1, kind: "finding", ref: "f-1" },
      ],
    );
    // Each item's version 1 is kept, and the cursors count on from where they were.
    const versions = store.db.prepare("select item, version from kb_version order by item").all();
    assert.deepEqual(
      versions.map((r) => ({ ...r })),
      [
        { item: 1, version: 1 },
        { item: 2, version: 1 },
        { item: 7, version: 1 },
      ],
    );
    const cursor = store.db.prepare("select seq, item_seq from kb_cursor").get() as {
      item_seq: number;
    };
    assert.equal(cursor.item_seq, 15);
    // A rig's cursor past seq 4 reads the rest, as it would have before.
    store.db
      .prepare(
        "insert into rig (id, first_seen, last_seen, ledger_id, summary) values ('rig-a', 'x', 'x', 'ledger-a', '{}')",
      )
      .run();
    const page = store.kb().sync("rig-a", "other-run", 4);
    assert.equal(page, undefined, "a run control has no record of has no sync");
    store.db
      .prepare(
        "insert into kb_run (rig, ledger, run, campaign) values ('rig-a', 'ledger-a', 'gs-2', 'gemv')",
      )
      .run();
    const after4 = store.kb().sync("rig-a", "gs-2", 4);
    assert.deepEqual(
      after4?.items.map((i) => [i.seq, i.ref]),
      [[9, "1"]],
    );
    assert.deepEqual(after4?.collections, ["gemv"]);
    // Every campaign control knows has its collection: one saved, ones with runs or items.
    assert.deepEqual(
      store
        .kb()
        .collections()
        .map((c) => c.campaign)
        .sort(),
      ["gemv", "only-runs", "saved", "survey"],
    );
    // The words index holds the items from before, each in its passages (store migration 17).
    const words = (q: string) =>
      (
        store.db
          .prepare(
            "select p.item from kb_words join kb_passage p on p.id = kb_words.rowid where kb_words match ? order by p.item",
          )
          .all(q) as { item: number }[]
      ).map((r) => r.item);
    assert.deepEqual(words("loads"), [1]);
    assert.deepEqual(words("verifier"), [7]);
    // A new item takes an id after every one given before, the deleted one's too.
    store.kb().index(
      { rig: "rig-a", ledger: "ledger-a" },
      {
        at: "2026-10-29T10:00:00.000Z",
        actor: "lane-1",
        kind: "journal_note",
        subject: "gs-1",
        body: { id: 3, by: "lane-1", kind: "surprise", text: "Faster than the guide" },
      },
    );
    const added = store.db.prepare("select id, seq from kb_item where ref = '3'").get() as {
      id: number;
      seq: number;
    };
    assert.ok(added.id > 7, `id ${added.id}`);
    assert.equal(added.seq, 16);
    store.db.close();
  });

  test("a new store has the hierarchy, empty, and opening it again changes nothing", () => {
    const path = fresh();
    const store = new ControlStore(path);
    for (const t of [
      "kb_item",
      "kb_version",
      "kb_link",
      "kb_file",
      "kb_collection",
      "kb_scope",
      "kb_words",
    ])
      assert.ok(store.db.prepare("select 1 from sqlite_master where name = ?").get(t), t);
    store.campaigns.put({ campaign: "gemv", version: 1, contract: {}, sha: "a", by: "owner:ui" });
    store.db.close();
    const again = new ControlStore(path);
    assert.deepEqual(
      again
        .kb()
        .collections()
        .map((c) => c.campaign),
      ["gemv"],
    );
    again.db.close();
  });
});
