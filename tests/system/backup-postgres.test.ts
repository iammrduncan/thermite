import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  backupControl,
  RestoreRefused,
  readManifest,
  restoreControl,
} from "../../src/common/backup/index.ts";
import { rowsBehind } from "../../src/control/store/behind.ts";
import { type IngestReport, openSqliteStore } from "../../src/control/store/index.ts";
import { keepFolds } from "../../src/control/views/index.ts";
import { CONTROL_STATE } from "../../src/core/backup.ts";
import { EVENT_STREAM } from "../../src/core/link/events.ts";
import {
  applied,
  busOf,
  closeBus,
  heldEvents,
  ingestReport,
  storeOnBus,
} from "../helpers/control-store.ts";
import { FakeBackupBus } from "../helpers/fake-backup-bus.ts";
import { FakeBus } from "../helpers/fake-bus.ts";
import { emptyDatabase, postgresConnection, postgresStore } from "../helpers/postgres.ts";

/**
 * Backup and restore of a control whose store is on PostgreSQL (goal 268), in a layout as the
 * compose stack's: control's state folder (its keys, a kit), its database, and the bus's EVENTS
 * stream. A backup holds the store's rows as they stood at one moment, in a dump, where a backup
 * of a control on SQLite holds its file. A restore puts the dump in control's state folder, and
 * control loads it into its empty database as it starts, then goes on from its place in the
 * stream. A database that holds a store is never loaded over, and a backup goes to a control
 * whose store is where the backup's was.
 */

const BUILD = { version: "0.3.0", commit: null };
const fresh = (name: string) => mkdtempSync(join(tmpdir(), `thermite-${name}-`));

/** A page of a rig ledger's notes, as a report that passed control's checks carries them. */
const page = (rig: string, from: number, n: number): IngestReport => ({
  rig,
  ledger_id: "l-1",
  cursor: from - 1,
  next: from + n - 1,
  generated_at: new Date().toISOString(),
  summary: {},
  events: Array.from({ length: n }, (_, i) => ({
    id: from + i,
    at: new Date(Date.UTC(2026, 10, 14, 8, 0, 0, from + i)).toISOString(),
    actor: "harness",
    kind: "journal_note",
    subject: null,
    body: { n: from + i },
    run: null,
  })),
});

const dbOf = (dir: string) => join(dir, CONTROL_STATE.db);

/** Control's store on PostgreSQL for the state folder `dir`, on `bus`, started as control starts it. */
const control = (dir: string, bus: FakeBus) => storeOnBus(postgresStore(dbOf(dir)), bus);

/** Control's state folder and database, its store holding `events` events of rig-a. */
async function controlState(events: number): Promise<{ dir: string; bus: FakeBus }> {
  const dir = fresh("control");
  const bus = new FakeBus();
  const store = control(dir, bus);
  for (let from = 1; from <= events; from += 50)
    await ingestReport(store, page("rig-a", from, Math.min(50, events - from + 1)));
  await store.ownSettings.set("log_level", "debug", "owner:ui");
  await applied(store);
  closeBus(store);
  await store.close();
  writeFileSync(join(dir, CONTROL_STATE.signingKey), "the signing key\n", { mode: 0o600 });
  writeFileSync(join(dir, CONTROL_STATE.signingPub), "the public key\n");
  writeFileSync(join(dir, CONTROL_STATE.busCaCert), "the authority\n");
  writeFileSync(join(dir, CONTROL_STATE.busCaKey), "the authority's key\n", { mode: 0o600 });
  writeFileSync(join(dir, CONTROL_STATE.busBackupSeed), "SUA-the-seed\n", { mode: 0o600 });
  mkdirSync(join(dir, "kits", "matmul"), { recursive: true });
  writeFileSync(join(dir, "kits", "matmul", "HEAD"), "ref: refs/heads/main\n");
  return { dir, bus };
}

const backup = (dir: string, bus: FakeBus, say?: (line: string) => void) =>
  backupControl({
    stateDir: dir,
    into: fresh("backups"),
    bus: new FakeBackupBus(bus),
    build: BUILD,
    say,
    postgres: postgresConnection(dbOf(dir)),
  });

const refused = (words: RegExp) => (err: unknown) =>
  err instanceof RestoreRefused && words.test(err.message);

describe("backup and restore of a control whose store is on PostgreSQL", () => {
  test("a backup holds the store's rows in a dump, where the SQLite file would be, with its place", async () => {
    const { dir, bus } = await controlState(120);
    const lines: string[] = [];
    const { folder, manifest } = await backup(dir, bus, (l) => lines.push(l));
    assert.deepEqual(readManifest(folder), manifest);
    assert.equal(manifest.store.kind, "postgres");
    assert.equal(manifest.store.positions[EVENT_STREAM], 120);
    assert.ok(manifest.store.schema >= 1);
    assert.deepEqual(
      manifest.files.map((f) => f.path),
      [
        "state/store.dump",
        "state/control-signing.key",
        "state/control-signing.pub",
        "state/bus-ca.pem",
        "state/bus-ca.key",
        "state/bus-backup.seed",
        "state/kits/matmul/HEAD",
      ],
    );
    assert.match(
      lines[0] ?? "",
      /^dumped the store on PostgreSQL to store\.dump: schema \d+, \d+ bytes$/,
    );
    assert.equal(existsSync(join(folder, "state", CONTROL_STATE.db)), false, "no SQLite file");
    const dump = readFileSync(join(folder, "state", CONTROL_STATE.storeDump), "utf8");
    assert.match(dump, /"table":"control_setting"/);
    assert.match(dump.trimEnd().split("\n").at(-1) ?? "", /^\{"whole":true/);
    assert.equal(manifest.streams[0]?.last_seq, 120);
  });

  test("a restore brings the stream back, and control loads its store into its empty database as it starts", async () => {
    const { dir, bus } = await controlState(120);
    const { folder } = await backup(dir, bus);
    // A new machine: an empty state folder, an empty bus and an empty database.
    const target = fresh("restored");
    const newBus = new FakeBus();
    const lines: string[] = [];
    await restoreControl({
      from: folder,
      stateDir: target,
      bus: new FakeBackupBus(newBus),
      say: (l) => lines.push(l),
      store: { kind: "postgres", conn: postgresConnection(dbOf(target)) },
    });
    assert.deepEqual(lines.slice(2), [
      "EVENTS: restored and checked, 120 messages to 120",
      "control's state: the backup's put back",
      "control's store: its rows are in store.dump in control's state folder; control loads them into its empty database as it starts, checks their counts, and removes the file",
    ]);
    const dump = join(target, CONTROL_STATE.storeDump);
    assert.ok(existsSync(dump));
    // Control starts: its store is loaded, its start check holds, and it goes on from its place.
    const store = control(target, newBus);
    const events = await heldEvents(store, "rig-a");
    assert.equal(busOf(store).apply.stopped, null);
    assert.equal(existsSync(dump), false, "loaded, and removed: the backup still holds it");
    assert.equal(await store.busPositions.of(EVENT_STREAM), 120);
    assert.equal((await store.ownSettings.get("log_level"))?.value, "debug");
    assert.equal(events.length, 120);
    assert.deepEqual(keepFolds(store).held(), [{ rig: "rig-a", ledger: "l-1", seq: 120 }]);
    // It works on from there: the rig's next events are new, and a new row's key is the next.
    assert.equal(await ingestReport(store, page("rig-a", 121, 3)), 3);
    const ids = (await rowsBehind(store, "select id from audit order by id")).map((r) =>
      Number(r.id),
    );
    await store.auditLog.add("owner:ui", "after the restore", {});
    assert.equal(await store.auditLog.newestId(), (ids.at(-1) ?? 0) + 1);
    closeBus(store);
    await store.close();
  });

  test("backed up while it works: a bus that ran on is kept, and control applies its newer events", async () => {
    const { dir, bus } = await controlState(60);
    // Control is at work while the backup is made: its store is open, and it goes on after.
    const working = control(dir, bus);
    await applied(working);
    const { folder, manifest } = await backup(dir, bus);
    assert.equal(manifest.store.positions[EVENT_STREAM], 60);
    await ingestReport(working, page("rig-a", 61, 5));
    assert.equal(await working.busPositions.of(EVENT_STREAM), 65);
    closeBus(working);
    await working.close();
    // The owner gives control an empty database, and the backup goes back; the bus is kept.
    emptyDatabase(dbOf(dir));
    const lines: string[] = [];
    await restoreControl({
      from: folder,
      stateDir: dir,
      bus: new FakeBackupBus(bus),
      say: (l) => lines.push(l),
      store: { kind: "postgres", conn: postgresConnection(dbOf(dir)) },
    });
    assert.equal(
      lines[1],
      "EVENTS on the bus holds the backup's events and 5 newer ones after them, to 65: control applies them from its place, 60, as it starts",
    );
    const store = control(dir, bus);
    const events = await heldEvents(store, "rig-a");
    assert.equal(busOf(store).apply.stopped, null);
    assert.equal(
      await store.busPositions.of(EVENT_STREAM),
      65,
      "the events after the backup are back",
    );
    assert.equal(await store.reportedRigs.heldCursor("rig-a", "l-1"), 65);
    assert.deepEqual(
      events.map((e) => [e.seq, e.id]),
      Array.from({ length: 65 }, (_, i) => [i + 1, i + 1]),
    );
    assert.equal(await ingestReport(store, page("rig-a", 61, 5)), 0, "none of it is new");
    closeBus(store);
    await store.close();
  });

  test("a database that holds a store is never loaded over: the restore is refused, and so is control's start", async () => {
    const { dir, bus } = await controlState(20);
    const { folder } = await backup(dir, bus);
    const before = readFileSync(join(dir, CONTROL_STATE.signingKey), "utf8");
    // The database still holds the store the backup was made of.
    await assert.rejects(
      restoreControl({
        from: folder,
        stateDir: dir,
        bus: new FakeBackupBus(bus),
        store: { kind: "postgres", conn: postgresConnection(dbOf(dir)) },
      }),
      refused(
        /^the store's database holds \d+ tables already: a backup of a store on PostgreSQL is restored into an empty database, where control loads its rows as it starts, and never over a store\. .* Nothing was changed\.$/,
      ),
    );
    assert.equal(existsSync(join(dir, CONTROL_STATE.storeDump)), false);
    assert.equal(readFileSync(join(dir, CONTROL_STATE.signingKey), "utf8"), before);
    // A dump left beside a database that holds a store: control does not start, and says why.
    writeFileSync(
      join(dir, CONTROL_STATE.storeDump),
      readFileSync(join(folder, "state", CONTROL_STATE.storeDump)),
    );
    const store = postgresStore(dbOf(dir));
    await assert.rejects(
      store.reportedRigs.list(),
      /a restore's dump of control's store waits at .*store\.dump, and the database holds \d+ tables already.*To keep the store that is there: move the dump away, and start control again\. Nothing was changed/,
    );
    assert.ok(existsSync(join(dir, CONTROL_STATE.storeDump)), "the dump is kept");
  });

  test("a backup goes to a control whose store is where the backup's was", async () => {
    const { dir, bus } = await controlState(10);
    const { folder } = await backup(dir, bus);
    const target = fresh("restored");
    await assert.rejects(
      restoreControl({
        from: folder,
        stateDir: target,
        bus: new FakeBackupBus(new FakeBus()),
        store: { kind: "sqlite" },
      }),
      refused(
        /^the backup is of a control whose store is on PostgreSQL, and control's settings say SQLite \(THERMITE_CONTROL_STORE\): restore it to a control whose store is on PostgreSQL\. Nothing was changed\.$/,
      ),
    );
    assert.equal(existsSync(join(target, CONTROL_STATE.storeDump)), false);
    // And a backup of a control on SQLite, to one on PostgreSQL.
    const lite = fresh("sqlite");
    const liteBus = new FakeBus();
    const sqlite = storeOnBus(openSqliteStore(dbOf(lite)), liteBus);
    await ingestReport(sqlite, page("rig-a", 1, 5));
    closeBus(sqlite);
    await sqlite.close();
    const made = await backupControl({
      stateDir: lite,
      into: fresh("backups"),
      bus: new FakeBackupBus(liteBus),
      build: BUILD,
    });
    assert.equal(made.manifest.store.kind, "sqlite");
    await assert.rejects(
      restoreControl({
        from: made.folder,
        stateDir: fresh("restored"),
        bus: new FakeBackupBus(new FakeBus()),
        store: { kind: "postgres", conn: postgresConnection() },
      }),
      refused(
        /^the backup is of a control whose store is on SQLite, and control's settings say PostgreSQL/,
      ),
    );
  });
});
