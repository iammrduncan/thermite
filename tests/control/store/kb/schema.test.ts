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
 * every item. Store migration 26: the agents' slots take the agents' names, and the table of a
 * grant's copies goes.
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
  test("a store's items go into their runs' records slots, with their ids and seqs", () => {
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
    assert.equal(v.v, 27);
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
    // The rig's runs are known as before.
    store.db
      .prepare(
        "insert into rig (id, first_seen, last_seen, ledger_id, summary) values ('rig-a', 'x', 'x', 'ledger-a', '{}')",
      )
      .run();
    assert.equal(store.kb().runCampaign("rig-a", "other-run"), undefined);
    store.db
      .prepare(
        "insert into kb_run (rig, ledger, run, campaign) values ('rig-a', 'ledger-a', 'gs-2', 'gemv')",
      )
      .run();
    assert.equal(store.kb().runCampaign("rig-a", "gs-2"), "gemv");
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

  test("store migration 26: the agents' slots take the agents' names everywhere the store keeps one, and a grant's copies go", () => {
    const path = fresh();
    const old = new ControlStore(path);
    const RIG = { rig: "rig-a", ledger: "ledger-a" };
    old.kb().index(RIG, {
      at: "2026-11-01T10:00:00.000Z",
      actor: "harness",
      kind: "run_created",
      subject: "gs-1",
      body: { campaign: "gemv", mode: "goal" },
    });
    const at = { ...RIG, run: "gs-1", at: "2026-11-01T11:00:00.000Z" };
    const review = {
      slot: "review_panel",
      item: 1,
      version: 1,
      kind: "review" as const,
      title: "The win holds",
      text: "The panel read the diff and the judge's findings: the gain is real.",
      links: [],
    };
    assert.equal(old.kb().write({ ...at, event: 10 }, review), undefined);
    assert.equal(
      old.kb().write(
        { ...at, event: 11 },
        {
          slot: "teachers",
          item: 1,
          version: 1,
          kind: "note",
          title: "Blocking next",
          text: "Cache blocking is the next step after the panel's review.",
          links: [{ rel: "follows", to: "gemv/gs-1/review_panel/review:1" }],
        },
      ),
      undefined,
    );
    // The store as an earlier build kept it: the slots spelled as before, and a grant's copies.
    // The words index holds the same words either way: `_` and `-` part words, and the stemmer
    // reads teachers as teacher.
    old.db.exec(`
drop trigger kb_version_never_changed;
update kb_item set slot = 'review-panel', by = 'review-panel',
  context = replace(context, 'review_panel', 'review-panel') where slot = 'review_panel';
update kb_item set slot = 'teacher', by = 'teacher',
  context = replace(context, 'teachers', 'teacher') where slot = 'teachers';
update kb_version set by = 'review-panel' where by = 'review_panel';
update kb_version set by = 'teacher' where by = 'teachers';
update kb_link set target = 'gemv/gs-1/review-panel/review:1';
create table kb_grant_item (campaign text not null, reads text not null, item integer not null,
  seq integer not null, primary key (campaign, reads, item));
create index kb_grant_item_seq on kb_grant_item (campaign, seq);
create trigger kb_version_never_changed before update on kb_version
begin select raise(abort, 'a version of an item is never changed'); end;
delete from schema_migrations where version >= 26;`);
    old.db.close();

    const store = new ControlStore(path);
    const rows = (sql: string) =>
      (store.db.prepare(sql).all() as Record<string, unknown>[]).map((r) => ({ ...r }));
    assert.deepEqual(rows("select slot, by from kb_item where slot != 'records' order by id"), [
      { slot: "review_panel", by: "review_panel" },
      { slot: "teachers", by: "teachers" },
    ]);
    assert.deepEqual(
      rows(
        "select v.by from kb_version v join kb_item i on i.id = v.item where i.slot != 'records' order by v.item, v.version",
      ),
      [{ by: "review_panel" }, { by: "teachers" }],
    );
    assert.deepEqual(rows("select rel, target from kb_link"), [
      { rel: "follows", target: "gemv/gs-1/review_panel/review:1" },
    ]);
    const context = rows("select context from kb_item where slot != 'records' order by id").map(
      (r) => String(r.context),
    );
    assert.match(context[0] ?? "", /\breview_panel\b/);
    assert.match(context[1] ?? "", /\bteachers\b/);
    // The words index agrees with the rows, and still finds the items.
    store.db.exec("insert into kb_words (kb_words) values ('integrity-check')");
    const found = store.db
      .prepare(
        "select distinct p.item from kb_words join kb_passage p on p.id = kb_words.rowid where kb_words match ? order by p.item",
      )
      .all("panel") as { item: number }[];
    assert.equal(found.length, 2);
    // An address given before still finds its item; the link reads under today's name.
    assert.equal(store.kb().at("gemv/gs-1/review-panel/review:1")?.slot, "review_panel");
    assert.equal(store.kb().at("gemv/gs-1/teacher/note:1")?.title, "Blocking next");
    // The table of a grant's copies is gone; the versions are kept as they were written again.
    assert.equal(
      store.db.prepare("select 1 from sqlite_master where name = 'kb_grant_item'").get(),
      undefined,
    );
    assert.throws(
      () => store.db.exec("update kb_version set by = 'someone'"),
      /a version of an item is never changed/,
    );
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
