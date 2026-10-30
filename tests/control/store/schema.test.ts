import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { copiesOf } from "../../../src/common/db-copy.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import { keepOldRows, withEventsTable } from "../../helpers/old-store.ts";

const V010 = readFileSync(
  join(import.meta.dirname, "..", "..", "helpers", "data", "control-v0.1.0.sql"),
  "utf8",
);
const fresh = () => join(mkdtempSync(join(tmpdir(), "thermite-store-")), "control.db");
const version = (db: DatabaseSync) =>
  (db.prepare("select max(version) as v from schema_migrations").get() as { v: number }).v;

describe("control's store migrations", () => {
  test("a store that v0.1.0 wrote is copied, then migrated, and keeps its data", () => {
    const path = fresh();
    const old = new DatabaseSync(path);
    old.exec(V010);
    old.close();

    const store = new ControlStore(path);
    assert.equal(version(store.db), 17);
    const folder = store.db.prepare("select name from campaign_folder").get() as { name: string };
    assert.equal(folder.name, "speed");
    store.db.close();

    const copies = copiesOf(path);
    assert.equal(copies.length, 1);
    assert.equal(copies[0]?.version, 0);
    const copy = new DatabaseSync(copies[0]?.path ?? "", { readOnly: true });
    const tables = copy
      .prepare("select name from sqlite_master where type = 'table' and name = 'schema_migrations'")
      .all();
    assert.deepEqual(tables, [], "the copy is the store as v0.1.0 left it");
    copy.close();

    new ControlStore(path).db.close();
    assert.equal(copiesOf(path).length, 1, "a store at this code's version is not copied again");
  });

  test("a new store is not copied", () => {
    const path = fresh();
    const store = new ControlStore(path);
    assert.equal(version(store.db), 17);
    store.db.close();
    assert.deepEqual(copiesOf(path), []);
  });

  test("a store at version 1 is copied, then gets the table of updates under way (goal 165)", () => {
    const path = fresh();
    const one = new ControlStore(path);
    withEventsTable(one.db, 1);
    one.db.exec("drop table rig_update");
    one.db.close();
    const store = new ControlStore(path);
    assert.equal(version(store.db), 17);
    assert.ok(store.db.prepare("select 1 from sqlite_master where name = 'rig_update'").get());
    store.db.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [1],
    );
  });

  test("a store at version 3 gets the agents' public names in its usage records (goal 125)", () => {
    const path = fresh();
    const three = new ControlStore(path);
    withEventsTable(three.db, 3);
    const row = three.db.prepare(
      `insert into model_call (rig, ledger_id, event_id, run, agent, harness, model, at, tokens_in,
         tokens_out) values ('rig-a', 'l-1', ?, 'r-1', ?, 'pi', 'm', '2026-10-27T00:00:00Z', 1, 1)`,
    );
    for (const [id, agent] of [
      [1, "combiner"],
      [2, "panel"],
      [3, "workers"],
    ] as const)
      row.run(id, agent);
    three.db.close();
    const store = new ControlStore(path);
    assert.equal(version(store.db), 17);
    const agents = store.db.prepare("select agent from model_call order by event_id").all();
    assert.deepEqual(
      agents.map((r) => r.agent),
      ["merged_by", "review_panel", "workers"],
    );
    store.db.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [3],
    );
  });

  test("a store at version 9 gets the synthesizer's and the final writer's model slots, and keeps every agent's model (goal 166)", () => {
    const path = fresh();
    const nine = new ControlStore(path);
    // The table as version 9 left it: its check takes the roles of goal 074 only.
    nine.db.exec(`drop table rig_role_model;
      create table rig_role_model (
        rig text not null,
        role text not null check (role in ('planner', 'teachers', 'second_teacher', 'merged_by', 'auditor', 'review_panel')),
        provider text not null, model text not null, effort text, assigned_at text not null,
        harness text, context_cap integer, compact_at integer,
        primary key (rig, role));
      insert into rig_role_model values ('rig-a', 'teachers', 'lab', 'wide-model', 'high', '2026-10-27', 'codex', 65536, 70);
      insert into rig_role_model values ('rig-a', 'auditor', 'lab', 'strong-model', null, '2026-10-27', null, null, null);
      delete from schema_migrations where version >= 10`);
    assert.throws(() =>
      nine.db
        .prepare(
          "insert into rig_role_model (rig, role, provider, model, assigned_at) values ('rig-a', 'synthesizer', 'lab', 'm', 'now')",
        )
        .run(),
    );
    nine.db.close();
    const store = new ControlStore(path);
    assert.equal(version(store.db), 17);
    const roles = store.agentModels.byRole("rig-a");
    assert.deepEqual(roles.teachers, {
      provider: "lab",
      model: "wide-model",
      effort: "high",
      harness: "codex",
      contextCap: 65_536,
      compactAt: 70,
    });
    assert.equal(roles.auditor?.model, "strong-model");
    // The two new slots take a model; a role the check does not name is still refused.
    store.modelProviders.put({
      name: "lab",
      type: "openai",
      base_url: "https://models.example.com/v1",
      key: { sealed: "sealed-for-tests", hint: "…ests" },
    });
    store.agentModels.assignRole("rig-a", "synthesizer", { provider: "lab", model: "wide-model" });
    store.agentModels.assignRole("rig-a", "final_writer", {
      provider: "lab",
      model: "strong-model",
      harness: "pi",
    });
    const after = store.agentModels.byRole("rig-a");
    assert.deepEqual(
      [after.synthesizer?.model, after.final_writer?.model, after.final_writer?.harness],
      ["wide-model", "strong-model", "pi"],
    );
    assert.throws(() =>
      store.db
        .prepare(
          "insert into rig_role_model (rig, role, provider, model, assigned_at) values ('rig-a', 'writer', 'lab', 'm', 'now')",
        )
        .run(),
    );
    store.db.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [9],
    );
  });

  test("a store at version 10 gets the events stream's place and each rig ledger's held cursor, at the start (goal 168)", () => {
    const path = fresh();
    const ten = new ControlStore(path);
    ten.db.exec(`drop table bus_position;
      create table rig_ledger_10 (rig text not null, ledger_id text not null, first_seen text not null,
        superseded_at text, primary key (rig, ledger_id));
      insert into rig_ledger_10 values ('rig-a', 'l-1', '2026-10-28', '2026-10-29'), ('rig-a', 'l-2', '2026-10-29', null);
      drop table rig_ledger;
      alter table rig_ledger_10 rename to rig_ledger;
      delete from schema_migrations where version >= 11`);
    ten.db.close();
    const store = new ControlStore(path);
    assert.equal(version(store.db), 17);
    // Nothing applied from the stream yet: the apply goes through it from its first message.
    assert.equal(store.busPositions.of("EVENTS"), 0);
    assert.deepEqual(
      ["l-1", "l-2"].map((l) => store.reportedRigs.heldCursor("rig-a", l)),
      [0, 0],
    );
    // The ledgers keep what they had.
    const left = store.db
      .prepare("select ledger_id, superseded_at from rig_ledger order by ledger_id")
      .all()
      .map((r) => ({ ...r }));
    assert.deepEqual(left, [
      { ledger_id: "l-1", superseded_at: "2026-10-29" },
      { ledger_id: "l-2", superseded_at: null },
    ]);
    store.db.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [10],
    );
  });

  test("the events table's drop waits for the move: the store stays at version 11, and nothing is copied again", () => {
    const path = fresh();
    const old = new ControlStore(path);
    withEventsTable(old.db);
    keepOldRows(old.db, [
      { rig: "rig-a", ledger: "l-1", id: 1, kind: "journal_note" },
      { rig: "rig-a", ledger: "l-1", id: 2, kind: "journal_note" },
    ]);
    old.db.close();
    for (let start = 0; start < 2; start++) {
      const store = new ControlStore(path);
      assert.equal(version(store.db), 11, "the drop waits");
      assert.equal(store.eventsTable.size().rows, 2);
      store.db.close();
    }
    assert.deepEqual(copiesOf(path), [], "a start that migrates nothing copies nothing");
    // A move that found other than the table holds: the drop still waits.
    const store = new ControlStore(path);
    assert.equal(store.migrate({ eventsMoved: { rows: 1, lastSeq: 2 } }), undefined);
    assert.equal(version(store.db), 11);
    // The move found the stream to hold the table whole: the table goes, its copy kept outside
    // the rotation, and the rig's last cursor with it.
    const kept = store.migrate({ eventsMoved: { rows: 2, lastSeq: 2 } });
    assert.match(kept ?? "", /control\.db\.v11\..*\.kept$/);
    assert.equal(version(store.db), 17);
    assert.equal(store.eventsTable.exists(), false);
    const rigCols = store.db.prepare("pragma table_info(rig)").all() as { name: string }[];
    assert.ok(!rigCols.some((c) => c.name === "last_cursor"));
    assert.deepEqual(copiesOf(path), [], "not one of the copies the rotation removes");
    const copy = new DatabaseSync(kept ?? "", { readOnly: true });
    assert.equal((copy.prepare("select count(*) as n from rig_event").get() as { n: number }).n, 2);
    copy.close();
    store.db.close();
  });

  test("an events table with no row goes at once, with no copy kept", () => {
    const path = fresh();
    const old = new ControlStore(path);
    withEventsTable(old.db);
    old.db.close();
    const store = new ControlStore(path);
    assert.equal(version(store.db), 17);
    assert.equal(store.eventsTable.exists(), false);
    store.db.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [11],
      "the copy before it is one of the rotation's",
    );
    assert.ok(!readdirSync(dirname(path)).some((f) => f.endsWith(".kept")));
  });

  test("a store at version 14 binds each Git access to the one host its campaigns fetch from", () => {
    const path = fresh();
    const store = new ControlStore(path);
    const add = (name: string) =>
      store.gitAccess.add({
        name,
        kind: "token",
        public_key: null,
        fingerprint: null,
        secret_sealed: "sealed",
        hint: "…1234",
        username: null,
        host: null,
        by: "owner:ui",
      });
    for (const name of ["one-host", "two-hosts", "unused"]) add(name);
    const assign = (id: string, imports: unknown[]) =>
      store.db
        .prepare(
          "insert into command (id, rig, kind, signed, issued_by, issued_at, status) values (?, 'rig-a', 'assign_campaign', ?, 'owner:ui', ?, 'delivered')",
        )
        .run(
          id,
          JSON.stringify({ envelope: { payload: { imports } }, signature: "" }),
          new Date().toISOString(),
        );
    const fromGit = (git: string, access: string) => ({ source: { git, access } });
    assign("c-1", [fromGit("git@git.example.com:team/a.git", "one-host")]);
    assign("c-2", [
      fromGit("https://git.example.com/team/b.git", "one-host"),
      fromGit("https://git.example.com/team/c.git", "two-hosts"),
      fromGit("https://other.example.net/team/c.git", "two-hosts"),
    ]);
    store.db.exec(
      "alter table git_access drop column host; delete from schema_migrations where version >= 15",
    );
    store.db.close();
    const after = new ControlStore(path);
    assert.equal(version(after.db), 17);
    assert.deepEqual(
      after.gitAccess.list().map((g) => [g.name, g.host]),
      [
        ["one-host", "git.example.com"],
        ["two-hosts", null],
        ["unused", null],
      ],
    );
    after.db.close();
  });

  test("a store newer than this code is refused, naming the copy to restore", () => {
    const path = fresh();
    const old = new DatabaseSync(path);
    old.exec(V010);
    old.close();
    const store = new ControlStore(path);
    store.db.prepare("insert into schema_migrations (version) values (18)").run();
    store.db.close();
    assert.throws(
      () => new ControlStore(path),
      /control store is at schema version 18, newer than this code's 17: .*the copy made then: .*control\.db\.v0\..*\.copy/,
    );
  });
});
