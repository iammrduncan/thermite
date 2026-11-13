import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { copiesOf } from "../../../src/common/db-copy.ts";
import { mapInTurn } from "../../../src/common/in-turn.ts";
import { sqliteBehind } from "../../../src/control/store/behind.ts";
import { openControlStore, STORE_VERSION } from "../../../src/control/store/index.ts";
import { campaignProposalTable } from "../../../src/control/store/proposals.ts";
import { keepOldRows, withEventsTable } from "../../helpers/old-store.ts";

const V010 = readFileSync(
  join(import.meta.dirname, "..", "..", "helpers", "data", "control-v0.1.0.sql"),
  "utf8",
);
const fresh = () => join(mkdtempSync(join(tmpdir(), "thermite-store-")), "control.db");
const version = (db: DatabaseSync) =>
  (db.prepare("select max(version) as v from schema_migrations").get() as { v: number }).v;
/** Every migration applied but the events table's drop (12), which waits for the move. */
const dropWaits = (db: DatabaseSync) =>
  !db.prepare("select 1 from schema_migrations where version = 12").get() &&
  version(db) === STORE_VERSION;

describe("control's store migrations", () => {
  test("goal 205's followers go (goal 206): a store at version 30 loses their table and column, and gets the runners' keys", async () => {
    const path = fresh();
    const made = openControlStore(path);
    // The two things goal 205's migrations 29 and 30 made, as a store that ran them has them.
    sqliteBehind(made).db.exec(`create table machine_bus_key (
      rig text not null, machine text not null, public_key text not null,
      registered_at text not null, primary key (rig, machine))`);
    sqliteBehind(made).db.exec("alter table machine_rig add column followers text");
    sqliteBehind(made).db.exec("drop table runner_bus_key");
    sqliteBehind(made).db.exec("drop table runner_use");
    sqliteBehind(made).db.exec("delete from schema_migrations where version >= 31");
    await made.close();

    const store = openControlStore(path);
    assert.equal(version(sqliteBehind(store).db), STORE_VERSION);
    const table = sqliteBehind(store)
      .db.prepare("select 1 from sqlite_master where type = 'table' and name = 'machine_bus_key'")
      .get();
    assert.equal(table, undefined);
    const cols = sqliteBehind(store).db.prepare("pragma table_info(machine_rig)").all() as {
      name: string;
    }[];
    assert.ok(!cols.some((c) => c.name === "followers"));
    const runners = sqliteBehind(store)
      .db.prepare("select 1 from sqlite_master where type = 'table' and name = 'runner_bus_key'")
      .get();
    assert.ok(runners, "migration 32 made the runners' keys' table");
    const placed = sqliteBehind(store)
      .db.prepare("select 1 from sqlite_master where type = 'table' and name = 'rig_runner'")
      .get();
    assert.ok(placed, "migration 33 made the table of the runners control sets up");
    const machineCols = sqliteBehind(store).db.prepare("pragma table_info(machine_rig)").all() as {
      name: string;
    }[];
    assert.ok(
      machineCols.some((c) => c.name === "judge_on_runners"),
      "migration 34: a machine rig's core may judge on its runners alone",
    );
    const workers = sqliteBehind(store)
      .db.prepare("select 1 from sqlite_master where type = 'table' and name = 'rig_workers'")
      .get();
    assert.ok(workers, "migration 35 made the table of Add a rig's Workers at a time");
    const use = sqliteBehind(store)
      .db.prepare("select 1 from sqlite_master where type = 'table' and name = 'runner_use'")
      .get();
    assert.ok(use, "migration 36 made the table of the runners' time (goal 231)");
    await store.close();
  });

  test("a store at version 36 gets the cache-write price and the input written to the cache (goal 195)", async () => {
    const path = fresh();
    const old = openControlStore(path);
    sqliteBehind(old).db.exec(`alter table model_price drop column cache_write;
      alter table model_call drop column cache_write_in;
      delete from schema_migrations where version >= 37`);
    await old.close();
    const store = openControlStore(path);
    assert.equal(version(sqliteBehind(store).db), STORE_VERSION);
    const cols = (table: string) =>
      (
        sqliteBehind(store).db.prepare(`pragma table_info(${table})`).all() as { name: string }[]
      ).map((c) => c.name);
    assert.ok(cols("model_price").includes("cache_write"), "a price's cache write");
    assert.ok(cols("model_call").includes("cache_write_in"), "a call's input written to the cache");
    await store.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [36],
    );
  });

  test("a store that v0.1.0 wrote is copied, then migrated, and keeps its data", async () => {
    const path = fresh();
    const old = new DatabaseSync(path);
    old.exec(V010);
    old.close();

    const store = openControlStore(path);
    assert.equal(version(sqliteBehind(store).db), STORE_VERSION);
    const folder = sqliteBehind(store).db.prepare("select name from campaign_folder").get() as {
      name: string;
    };
    assert.equal(folder.name, "speed");
    await store.close();

    const copies = copiesOf(path);
    assert.equal(copies.length, 1);
    assert.equal(copies[0]?.version, 0);
    const copy = new DatabaseSync(copies[0]?.path ?? "", { readOnly: true });
    const tables = copy
      .prepare("select name from sqlite_master where type = 'table' and name = 'schema_migrations'")
      .all();
    assert.deepEqual(tables, [], "the copy is the store as v0.1.0 left it");
    copy.close();

    await openControlStore(path).close();
    assert.equal(copiesOf(path).length, 1, "a store at this code's version is not copied again");
  });

  test("a store that v0.1.0 wrote, once migrated, has every table, column and index a new store has", async () => {
    const shape = (db: DatabaseSync) => {
      const tables = db
        .prepare(
          "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
        )
        .all() as { name: string }[];
      const columns = tables.map(({ name }) => [
        name,
        (db.prepare(`pragma table_info(${name})`).all() as Record<string, unknown>[]).map(
          (c) => `${c.name} ${c.type} ${c.notnull} ${c.dflt_value} ${c.pk}`,
        ),
      ]);
      const indexes = db
        .prepare(
          "select tbl_name || '.' || name as i from sqlite_master where type = 'index' and name not like 'sqlite_%' order by i",
        )
        .all() as { i: string }[];
      return { columns, indexes: indexes.map((x) => x.i) };
    };
    const made = openControlStore(fresh());
    const path = fresh();
    const old = new DatabaseSync(path);
    old.exec(V010);
    old.close();
    const upgraded = openControlStore(path);
    assert.deepEqual(shape(sqliteBehind(upgraded).db), shape(sqliteBehind(made).db));
    await made.close();
    await upgraded.close();
  });

  test("a store from before v0.1.0 is refused in words, and kept as it is, with no copy", () => {
    const cases: [string, string][] = [
      ["create table unit (id text primary key)", "it has the table unit"],
      [
        "create table model_route (name text primary key, model text not null)",
        "it has the table model_route",
      ],
      [
        "create table rig (id text primary key, first_seen text not null, last_seen text not null, last_cursor integer not null default 0, ledger_id text, summary text not null default '{}')",
        "its table rig has no column pubkey",
      ],
    ];
    for (const [sql, why] of cases) {
      const path = fresh();
      const old = new DatabaseSync(path);
      old.exec(sql);
      old.close();
      assert.throws(
        () => openControlStore(path),
        (e: Error) =>
          e.message ===
          `this control store is from before v0.1.0 (${why}): start Thermite v0.1.0 on it once, which brings it to v0.1.0's tables, then this version. The store is kept as it is: ${path}`,
      );
      const kept = new DatabaseSync(path, { readOnly: true });
      assert.deepEqual(
        kept.prepare("select name from sqlite_master where type = 'table'").all().length,
        1,
        why,
      );
      kept.close();
      assert.deepEqual(copiesOf(path), [], why);
    }
  });

  test("a new store is not copied", async () => {
    const path = fresh();
    const store = openControlStore(path);
    assert.equal(version(sqliteBehind(store).db), STORE_VERSION);
    await store.close();
    assert.deepEqual(copiesOf(path), []);
  });

  test("a store at version 1 is copied, then gets the table of updates under way (goal 165)", async () => {
    const path = fresh();
    const one = openControlStore(path);
    withEventsTable(sqliteBehind(one).db, 1);
    sqliteBehind(one).db.exec("drop table rig_update");
    await one.close();
    const store = openControlStore(path);
    assert.equal(version(sqliteBehind(store).db), STORE_VERSION);
    assert.ok(
      sqliteBehind(store).db.prepare("select 1 from sqlite_master where name = 'rig_update'").get(),
    );
    await store.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [1],
    );
  });

  test("a store at version 3 gets the agents' public names in its usage records (goal 125)", async () => {
    const path = fresh();
    const three = openControlStore(path);
    withEventsTable(sqliteBehind(three).db, 3);
    const row = sqliteBehind(three).db.prepare(
      `insert into model_call (rig, ledger_id, event_id, run, agent, harness, model, at, tokens_in,
         tokens_out) values ('rig-a', 'l-1', ?, 'r-1', ?, 'pi', 'm', '2026-10-27T00:00:00Z', 1, 1)`,
    );
    for (const [id, agent] of [
      [1, "combiner"],
      [2, "panel"],
      [3, "workers"],
    ] as const)
      row.run(id, agent);
    await three.close();
    const store = openControlStore(path);
    assert.equal(version(sqliteBehind(store).db), STORE_VERSION);
    const agents = sqliteBehind(store)
      .db.prepare("select agent from model_call order by event_id")
      .all();
    assert.deepEqual(
      agents.map((r) => r.agent),
      ["merged_by", "review_panel", "workers"],
    );
    await store.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [3],
    );
  });

  test("a store at version 9 gets the synthesizer's and the final writer's model slots, and keeps every agent's model (goal 166)", async () => {
    const path = fresh();
    const nine = openControlStore(path);
    // The table as version 9 left it: its check takes the roles of goal 074 only.
    sqliteBehind(nine).db.exec(`drop table rig_role_model;
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
      sqliteBehind(nine)
        .db.prepare(
          "insert into rig_role_model (rig, role, provider, model, assigned_at) values ('rig-a', 'synthesizer', 'lab', 'm', 'now')",
        )
        .run(),
    );
    await nine.close();
    const store = openControlStore(path);
    assert.equal(version(sqliteBehind(store).db), STORE_VERSION);
    const roles = await store.agentModels.byRole("rig-a");
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
    await store.modelProviders.put({
      name: "lab",
      type: "openai",
      base_url: "https://models.example.com/v1",
      key: { sealed: "sealed-for-tests", hint: "…ests" },
    });
    await store.agentModels.assignRole("rig-a", "synthesizer", {
      provider: "lab",
      model: "wide-model",
    });
    await store.agentModels.assignRole("rig-a", "final_writer", {
      provider: "lab",
      model: "strong-model",
      harness: "pi",
    });
    const after = await store.agentModels.byRole("rig-a");
    assert.deepEqual(
      [after.synthesizer?.model, after.final_writer?.model, after.final_writer?.harness],
      ["wide-model", "strong-model", "pi"],
    );
    assert.throws(() =>
      sqliteBehind(store)
        .db.prepare(
          "insert into rig_role_model (rig, role, provider, model, assigned_at) values ('rig-a', 'writer', 'lab', 'm', 'now')",
        )
        .run(),
    );
    await store.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [9],
    );
  });

  test("a store at version 10 gets the events stream's place and each rig ledger's held cursor, at the start (goal 168)", async () => {
    const path = fresh();
    const ten = openControlStore(path);
    sqliteBehind(ten).db.exec(`drop table bus_position;
      create table rig_ledger_10 (rig text not null, ledger_id text not null, first_seen text not null,
        superseded_at text, primary key (rig, ledger_id));
      insert into rig_ledger_10 values ('rig-a', 'l-1', '2026-10-28', '2026-10-29'), ('rig-a', 'l-2', '2026-10-29', null);
      drop table rig_ledger;
      alter table rig_ledger_10 rename to rig_ledger;
      delete from schema_migrations where version >= 11`);
    await ten.close();
    const store = openControlStore(path);
    assert.equal(version(sqliteBehind(store).db), STORE_VERSION);
    // Nothing applied from the stream yet: the apply goes through it from its first message.
    assert.equal(await store.busPositions.of("EVENTS"), 0);
    assert.deepEqual(
      await mapInTurn(["l-1", "l-2"], async (l) => store.reportedRigs.heldCursor("rig-a", l)),
      [0, 0],
    );
    // The ledgers keep what they had.
    const left = sqliteBehind(store)
      .db.prepare("select ledger_id, superseded_at from rig_ledger order by ledger_id")
      .all()
      .map((r) => ({ ...r }));
    assert.deepEqual(left, [
      { ledger_id: "l-1", superseded_at: "2026-10-29" },
      { ledger_id: "l-2", superseded_at: null },
    ]);
    await store.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [10],
    );
  });

  test("the events table's drop alone waits for the move: every other migration runs, and a start that migrates nothing copies nothing", async () => {
    const path = fresh();
    const old = openControlStore(path);
    withEventsTable(sqliteBehind(old).db);
    keepOldRows(sqliteBehind(old).db, [
      { rig: "rig-a", ledger: "l-1", id: 1, kind: "journal_note" },
      { rig: "rig-a", ledger: "l-1", id: 2, kind: "journal_note" },
    ]);
    await old.close();
    for (let start = 0; start < 2; start++) {
      const store = openControlStore(path);
      assert.equal(
        dropWaits(sqliteBehind(store).db),
        true,
        "the drop waits, every other migration ran",
      );
      assert.equal((await store.eventsTable.size()).rows, 2);
      await store.close();
    }
    // The first start ran the migrations after the drop, with a copy first; the second ran none.
    assert.equal(copiesOf(path).length, 1, "a start that migrates nothing copies nothing");
    // A move that found other than the table holds: the drop still waits.
    const store = openControlStore(path);
    assert.equal(await store.migrate({ eventsMoved: { rows: 1, lastSeq: 2 } }), undefined);
    assert.equal(dropWaits(sqliteBehind(store).db), true);
    // The move found the stream to hold the table whole: the table goes, its copy kept outside
    // the rotation, and the rig's last cursor with it.
    const kept = await store.migrate({ eventsMoved: { rows: 2, lastSeq: 2 } });
    assert.match(kept ?? "", /control\.db\.v37\..*\.kept$/);
    assert.equal(version(sqliteBehind(store).db), STORE_VERSION);
    assert.equal(await store.eventsTable.exists(), false);
    const rigCols = sqliteBehind(store).db.prepare("pragma table_info(rig)").all() as {
      name: string;
    }[];
    assert.ok(!rigCols.some((c) => c.name === "last_cursor"));
    assert.equal(copiesOf(path).length, 1, "the first start's copy, alone in the rotation");
    assert.ok(
      !copiesOf(path).some((c) => c.path === kept),
      "not one of the copies the rotation removes",
    );
    const copy = new DatabaseSync(kept ?? "", { readOnly: true });
    assert.equal((copy.prepare("select count(*) as n from rig_event").get() as { n: number }).n, 2);
    copy.close();
    await store.close();
  });

  test("an events table with no row goes at once, with no copy kept", async () => {
    const path = fresh();
    const old = openControlStore(path);
    withEventsTable(sqliteBehind(old).db);
    await old.close();
    const store = openControlStore(path);
    assert.equal(version(sqliteBehind(store).db), STORE_VERSION);
    assert.equal(await store.eventsTable.exists(), false);
    await store.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [11],
      "the copy before it is one of the rotation's",
    );
    assert.ok(!readdirSync(dirname(path)).some((f) => f.endsWith(".kept")));
  });

  test("a store at version 14 binds each Git access to the one host its campaigns fetch from", async () => {
    const path = fresh();
    const store = openControlStore(path);
    const add = async (name: string) =>
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
    for (const name of ["one-host", "two-hosts", "unused"]) await add(name);
    const assign = (id: string, imports: unknown[]) =>
      sqliteBehind(store)
        .db.prepare(
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
    sqliteBehind(store).db.exec(
      "alter table git_access drop column host; delete from schema_migrations where version >= 15",
    );
    await store.close();
    const after = openControlStore(path);
    assert.equal(version(sqliteBehind(after).db), STORE_VERSION);
    assert.deepEqual(
      (await after.gitAccess.list()).map((g) => [g.name, g.host]),
      [
        ["one-host", "git.example.com"],
        ["two-hosts", null],
        ["unused", null],
      ],
    );
    await after.close();
  });

  test("a store at version 17 keeps the proposals waiting, and takes a proposed grant after", async () => {
    const path = fresh();
    const old = openControlStore(path);
    // The table as version 16 made it, which takes no grant.
    sqliteBehind(old).db.exec(
      "drop table campaign_proposal; delete from schema_migrations where version >= 18",
    );
    campaignProposalTable(sqliteBehind(old).db);
    const by = "owner:operator";
    await old.proposals.propose({
      campaign: "c",
      field: "role_additions",
      value: { worker: "x" },
      by,
    });
    await assert.rejects(
      async () => old.proposals.propose({ campaign: "c", field: "kb_grant", value: "d", by }),
      /CHECK constraint/,
    );
    await old.close();
    const store = openControlStore(path);
    assert.equal(version(sqliteBehind(store).db), STORE_VERSION);
    const waiting = async () =>
      (await store.proposals.waiting("c")).map((p) => [p.id, p.field, p.value]);
    assert.deepEqual(await waiting(), [[1, "role_additions", { worker: "x" }]]);
    // A grant of each collection waits on its own; a newer one of the same collection replaces it.
    await store.proposals.propose({ campaign: "c", field: "kb_grant", value: "d", by });
    await store.proposals.propose({ campaign: "c", field: "kb_grant", value: "e", by });
    await store.proposals.propose({ campaign: "c", field: "kb_grant", value: "d", by });
    assert.deepEqual(await waiting(), [
      [1, "role_additions", { worker: "x" }],
      [3, "kb_grant", "e"],
      [4, "kb_grant", "d"],
    ]);
    assert.equal((await store.proposals.get(2))?.decision, "replaced");
    await store.close();
  });

  test("a store at version 18 keeps every audit entry, and a refusal that repeats after is one entry", async () => {
    const path = fresh();
    const old = openControlStore(path);
    // The audit table as version 18 left it.
    sqliteBehind(old).db.exec(`drop index audit_repeat;
      alter table audit drop column count; alter table audit drop column last_at;
      alter table audit drop column repeat; delete from schema_migrations where version >= 19`);
    const refused = { path: "/v1/commands", why: "no rig rig-9" };
    for (let i = 0; i < 2; i++)
      sqliteBehind(old)
        .db.prepare("insert into audit (at, actor, action, body) values (?, ?, ?, ?)")
        .run("2026-10-29T00:00:00.000Z", "owner:api", "refused", JSON.stringify(refused));
    await old.close();
    const store = openControlStore(path);
    assert.equal(version(sqliteBehind(store).db), STORE_VERSION);
    const entries = async () => (await store.auditLog.list(10)).map((e) => [e.action, e.count]);
    assert.deepEqual(await entries(), [
      ["refused", 1],
      ["refused", 1],
    ]);
    await store.auditLog.refusal("owner:api", "refused", refused);
    await store.auditLog.refusal("owner:api", "refused", refused);
    assert.deepEqual(await entries(), [
      ["refused", 2],
      ["refused", 1],
      ["refused", 1],
    ]);
    await store.close();
  });

  test("a store newer than this code is refused, naming the copy to restore", async () => {
    const path = fresh();
    const old = new DatabaseSync(path);
    old.exec(V010);
    old.close();
    const store = openControlStore(path);
    const newer = STORE_VERSION + 1;
    sqliteBehind(store).db.prepare("insert into schema_migrations (version) values (?)").run(newer);
    await store.close();
    assert.throws(
      () => openControlStore(path),
      new RegExp(
        `control store is at schema version ${newer}, newer than this code's ${STORE_VERSION}: .*the copy made then: .*control\\.db\\.v0\\..*\\.copy`,
      ),
    );
  });
});
