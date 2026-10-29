import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ControlStore } from "../../../../src/control/store/index.ts";
import type { KbItemBody } from "../../../../src/core/kb.ts";

/**
 * The hierarchy's items in control's store (goal 175): a collection made with its campaign; a
 * writer's items in its own slot, each later version kept beside the older ones, with its links;
 * a record's change is a new version too; the words index in the same transaction as each item;
 * a grant, and a run's scope (the data only).
 */

const RIG = { rig: "rig-a", ledger: "ledger-a" };

/** A store with one run, gs-1, filed in the gemv collection. */
function storeWithRun(): ControlStore {
  const store = new ControlStore(":memory:");
  store.kb().index(RIG, {
    at: "2026-10-29T10:00:00.000Z",
    actor: "harness",
    kind: "run_created",
    subject: "gs-1",
    body: { campaign: "gemv", mode: "goal" },
  });
  return store;
}

const body = (o: Partial<KbItemBody> = {}): KbItemBody => ({
  slot: "worker-1",
  item: 1,
  version: 1,
  kind: "finding",
  title: "Vector loads double the bandwidth",
  text: "128-bit loads of the packed weights doubled the measured bandwidth.",
  links: [],
  ...o,
});

const write = (store: ControlStore, b: KbItemBody, event = 10) =>
  store.kb().write({ ...RIG, run: "gs-1", event, at: "2026-10-29T11:00:00.000Z" }, b);

const words = (store: ControlStore, q: string) =>
  (
    store.db
      .prepare(
        "select i.slot, i.ref from kb_words w join kb_item i on i.id = w.rowid where kb_words match ? order by i.id",
      )
      .all(q) as { slot: string; ref: string }[]
  ).map((r) => `${r.slot}/${r.ref}`);

describe("the knowledge base's items, versions, links and words", () => {
  test("a collection is made with its campaign, and with a run filed from a rig's events", () => {
    const store = new ControlStore(":memory:");
    assert.deepEqual(store.kb().collections(), []);
    store.campaigns.put({ campaign: "saved", version: 1, contract: {}, sha: "a", by: "owner:ui" });
    store.campaigns.put({ campaign: "saved", version: 2, contract: {}, sha: "b", by: "owner:ui" });
    assert.deepEqual(
      store
        .kb()
        .collections()
        .map((c) => [c.campaign, c.items, c.runs]),
      [["saved", 0, 0]],
    );
    store.kb().index(RIG, {
      at: "2026-10-29T10:00:00.000Z",
      actor: "harness",
      kind: "run_created",
      subject: "gs-1",
      body: { campaign: "gemv" },
    });
    assert.deepEqual(
      store
        .kb()
        .collections()
        .map((c) => c.campaign)
        .sort(),
      ["gemv", "saved"],
    );
  });

  test("a writer's item in its slot, a new version that keeps the one before, its links", () => {
    const store = storeWithRun();
    assert.equal(write(store, body()), undefined);
    const link = { rel: "supports" as const, to: "gemv/gs-1/records/experiment:x-1" };
    assert.equal(
      write(store, body({ version: 2, text: "Doubled on the A100 too.", links: [link] }), 11),
      undefined,
    );
    const items = store
      .kb()
      .search("", ["gemv"])
      .filter((i) => i.slot === "worker-1");
    assert.equal(items.length, 1);
    const x = items[0];
    assert.ok(x);
    assert.deepEqual(
      [x.slot, x.ref, x.version, x.kind, x.by, x.body],
      ["worker-1", "1", 2, "finding", "worker-1", "Doubled on the A100 too."],
    );
    const versions = store.kb().versions(x.id);
    assert.deepEqual(
      versions.map((v) => [v.version, v.body, v.event, v.links]),
      [
        [1, "128-bit loads of the packed weights doubled the measured bandwidth.", 10, []],
        [2, "Doubled on the A100 too.", 11, [{ rel: "supports", to: link.to }]],
      ],
    );
    // No version is ever changed or removed.
    assert.throws(
      () => store.db.prepare("update kb_version set body = 'x'").run(),
      /never changed/,
    );
    assert.throws(() => store.db.prepare("delete from kb_version").run(), /never removed/);
    // Another writer's slot holds its own item 1; a file item; the records slot's own ids.
    assert.equal(
      write(store, body({ slot: "planner", kind: "decision", title: "Try vector loads first" })),
      undefined,
    );
    assert.equal(
      write(
        store,
        body({
          slot: "worker-1",
          item: 2,
          kind: "reference",
          title: "The guide",
          text: undefined,
          file: { sha256: "a".repeat(64), name: "guide.pdf", type: "application/pdf", bytes: 1234 },
        }),
      ),
      undefined,
    );
    assert.equal(
      write(store, body({ slot: "records", kind: "note", title: "From code" })),
      undefined,
    );
    const refs = store.db
      .prepare("select slot, ref, kind, file_sha256 from kb_item order by id")
      .all();
    assert.deepEqual(
      refs.map((r) => ({ ...r })),
      [
        { slot: "records", ref: "gs-1", kind: "run", file_sha256: null },
        { slot: "worker-1", ref: "1", kind: "finding", file_sha256: null },
        { slot: "planner", ref: "1", kind: "decision", file_sha256: null },
        { slot: "worker-1", ref: "2", kind: "reference", file_sha256: "a".repeat(64) },
        { slot: "records", ref: "w1", kind: "note", file_sha256: null },
      ],
    );
  });

  test("a version out of order, of nothing, of another kind, or a number taken is refused, in words", () => {
    const store = storeWithRun();
    assert.equal(write(store, body()), undefined);
    assert.match(
      String(write(store, body())),
      /item 1 of slot worker-1 exists already: a new version of it is version 2/,
    );
    assert.match(
      String(write(store, body({ version: 3 }))),
      /is at version 1: the next is 2, not 3/,
    );
    assert.match(
      String(write(store, body({ item: 5, version: 2 }))),
      /item 5 of slot worker-1 does not exist/,
    );
    assert.match(
      String(write(store, body({ version: 2, kind: "note" }))),
      /is a finding: a version keeps its kind, not note/,
    );
    // A run control filed under no campaign has no collection to write in.
    const none = store.kb().write({ ...RIG, run: "nowhere", event: 1, at: "x" }, body());
    assert.match(String(none), /run nowhere has no collection/);
    assert.equal(
      store.db.prepare("select count(*) as n from kb_version where event is not null").get()?.n,
      1,
    );
  });

  test("a record's change is its next version, and the one before stays", () => {
    const store = storeWithRun();
    const note = (text: string) =>
      store.kb().index(RIG, {
        at: "2026-10-29T10:05:00.000Z",
        actor: "lane-1",
        kind: "journal_note",
        subject: "gs-1",
        body: { id: 4, by: "lane-1", kind: "observation", text },
      });
    note("The L2 is 4 MB");
    note("The L2 is 6 MB, not 4");
    const id = (
      store.db.prepare("select id from kb_item where kind = 'note' and ref = '4'").get() as {
        id: number;
      }
    ).id;
    assert.deepEqual(
      store
        .kb()
        .versions(id)
        .map((v) => v.version),
      [1, 2],
    );
    assert.ok(store.kb().versions(id)[0]?.body.includes("4 MB"));
  });

  test("the words index is written in the item's own transaction: a failed write leaves neither", () => {
    const store = storeWithRun();
    assert.throws(() =>
      store.tx(() => {
        write(store, body({ title: "Shared memory tiling", text: "Tiles of 64 by 64" }));
        assert.deepEqual(words(store, "tiling"), ["worker-1/1"], "seen inside its transaction");
        throw new Error("the write fails after the item");
      }),
    );
    assert.deepEqual(words(store, "tiling"), []);
    assert.equal(
      store.db.prepare("select count(*) as n from kb_item where slot = 'worker-1'").get()?.n,
      0,
    );
    assert.equal(
      store.db.prepare("select count(*) as n from kb_version where event is not null").get()?.n,
      0,
    );
    // Written: found by its words, stemmed; a new version's words replace the old ones'.
    write(
      store,
      body({ title: "Shared memory tiling", text: "Tiles of 64 by 64 failed to improve speed" }),
    );
    assert.deepEqual(words(store, "fail"), ["worker-1/1"]);
    write(store, body({ version: 2, title: "Shared memory tiling", text: "Tiles of 128 helped" }));
    assert.deepEqual(words(store, "fail"), []);
    assert.deepEqual(words(store, "helped"), ["worker-1/1"]);
  });

  test("a grant and a run's scope: the data only, never past what the campaign may read", () => {
    const store = storeWithRun();
    const kb = store.kb();
    for (const c of ["survey", "papers"]) kb.makeCollection(c);
    assert.deepEqual(kb.scope("gemv", "gs-1"), { fresh: false, granted: [] });
    assert.throws(
      () => kb.setScope("gemv", "gs-1", { fresh: true, granted: ["survey"] }, "owner:ui"),
      /gemv may not read survey: the owner grants a collection first/,
    );
    assert.equal(kb.grant("gemv", "survey", "owner:ui"), true);
    assert.equal(kb.grant("gemv", "papers", "owner:ui"), true);
    // No scope set: the whole collection and every grant.
    assert.deepEqual(kb.scope("gemv", "gs-1"), { fresh: false, granted: ["papers", "survey"] });
    kb.setScope("gemv", "gs-1", { fresh: true, granted: ["survey"] }, "owner:ui");
    assert.deepEqual(kb.scope("gemv", "gs-1"), { fresh: true, granted: ["survey"] });
    // A grant removed since leaves the scope too.
    kb.revoke("gemv", "survey");
    assert.deepEqual(kb.scope("gemv", "gs-1"), { fresh: true, granted: [] });
    assert.deepEqual(kb.scope("gemv", "gs-2"), { fresh: false, granted: ["papers"] });
  });
});
