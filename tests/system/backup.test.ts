import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  backupControl,
  RestoreRefused,
  readManifest,
  restoreControl,
} from "../../src/common/backup/index.ts";
import { EventsApply } from "../../src/control/events/index.ts";
import { ControlStore, type IngestReport } from "../../src/control/store/index.ts";
import { CONTROL_STATE, STREAMS_LEFT_OUT, snapshotFile } from "../../src/core/backup.ts";
import { EVENT_STREAM } from "../../src/core/link/events.ts";
import { applied, closeBus, controlStore, ingestReport } from "../helpers/control-store.ts";
import { FakeBackupBus } from "../helpers/fake-backup-bus.ts";
import { FakeBus } from "../helpers/fake-bus.ts";

/**
 * Backup and restore of control (goal 173), in a layout as the compose stack's: control's state
 * folder (its store on the fake bus, its keys, a kit and an export) and the bus's EVENTS stream.
 * A backup holds both, with a manifest; a restore onto a new folder and an empty bus brings back
 * the stream, checked, then control's state, and control then starts on it, its start check
 * holding; a restore over a folder keeps what it replaced; a stream that comes back short, or one
 * the bus already holds that is not the backup's, is refused, naming it, with control's state left
 * as it was.
 */

const BUILD = { version: "0.1.1", commit: null };
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
    at: new Date(Date.UTC(2026, 9, 29, 8, 0, 0, from + i)).toISOString(),
    actor: "harness",
    kind: "journal_note",
    subject: null,
    body: { n: from + i },
    run: null,
  })),
});

/** Control's state folder as compose keeps it, its store holding `events` events of rig-a. */
async function controlState(events: number): Promise<{ dir: string; bus: FakeBus }> {
  const dir = fresh("control");
  const bus = new FakeBus();
  const store = controlStore(join(dir, CONTROL_STATE.db), bus);
  for (let from = 1; from <= events; from += 50)
    await ingestReport(store, page("rig-a", from, Math.min(50, events - from + 1)));
  await applied(store);
  closeBus(store);
  store.db.close();
  writeFileSync(join(dir, CONTROL_STATE.signingKey), "the signing key\n", { mode: 0o600 });
  writeFileSync(join(dir, CONTROL_STATE.signingPub), "the public key\n");
  writeFileSync(join(dir, CONTROL_STATE.secretsKey), "the secrets key\n", { mode: 0o600 });
  writeFileSync(join(dir, CONTROL_STATE.busCaCert), "the authority\n");
  writeFileSync(join(dir, CONTROL_STATE.busCaKey), "the authority's key\n", { mode: 0o600 });
  writeFileSync(join(dir, CONTROL_STATE.busBackupSeed), "SUA-the-seed\n", { mode: 0o600 });
  mkdirSync(join(dir, "kits", "matmul", "refs"), { recursive: true });
  writeFileSync(join(dir, "kits", "matmul", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, "exports", "rig-b"), { recursive: true });
  writeFileSync(join(dir, "exports", "rig-b", "ledger.db"), Buffer.alloc(70_000, 3));
  // Not control's: a backup leaves it out, and a restore leaves it where it is.
  writeFileSync(join(dir, "notes.txt"), "the owner's own file\n");
  return { dir, bus };
}

/** A restore refused, with words that match `words`. */
const refused = (words: RegExp) => (err: unknown) =>
  err instanceof RestoreRefused && words.test(err.message);

/** The store's place in the events stream, read from its file. */
function placeIn(dir: string): number {
  const store = new ControlStore(join(dir, CONTROL_STATE.db));
  try {
    return store.busPositions.of(EVENT_STREAM);
  } finally {
    store.db.close();
  }
}

describe("backup and restore of control (goal 173)", () => {
  test("a backup holds control's state and EVENTS, the store first, with a manifest", async () => {
    const { dir, bus } = await controlState(120);
    const into = fresh("backups");
    const lines: string[] = [];
    const at = new Date("2026-10-29T10:00:00.000Z");
    const { folder, manifest } = await backupControl({
      stateDir: dir,
      into,
      bus: new FakeBackupBus(bus),
      build: BUILD,
      now: at,
      say: (l) => lines.push(l),
    });
    assert.equal(folder, join(into, "thermite-backup-2026-10-29T10-00-00-000Z"));
    assert.deepEqual(readdirSync(into), ["thermite-backup-2026-10-29T10-00-00-000Z"]);
    assert.deepEqual(readManifest(folder), manifest);
    assert.equal(manifest.made_at, at.toISOString());
    assert.deepEqual(manifest.thermite, BUILD);
    assert.equal(manifest.store.positions[EVENT_STREAM], 120);
    assert.ok(manifest.store.schema >= 13);
    assert.deepEqual(
      manifest.files.map((f) => f.path),
      [
        "state/control.db",
        "state/control-signing.key",
        "state/control-signing.pub",
        "state/secrets.key",
        "state/bus-ca.pem",
        "state/bus-ca.key",
        "state/bus-backup.seed",
        "state/kits/matmul/HEAD",
        "state/exports/rig-b/ledger.db",
      ],
    );
    assert.equal(statSync(join(folder, "state", CONTROL_STATE.signingKey)).mode & 0o777, 0o600);
    const [events] = manifest.streams;
    assert.equal(manifest.streams.length, 1);
    assert.equal(events?.name, EVENT_STREAM);
    assert.equal(events?.messages, 120);
    assert.equal(events?.last_seq, 120);
    assert.match(events?.last_sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(events?.file.path, snapshotFile(EVENT_STREAM));
    // The streams left out, each with why: control makes them again.
    assert.deepEqual(Object.keys(manifest.left_out).sort(), [
      "COMMANDS",
      "CONFIG",
      "LIVE",
      "REPORTS",
    ]);
    assert.deepEqual(manifest.left_out, STREAMS_LEFT_OUT);
    assert.match(lines[0] ?? "", /^copied control\.db: schema \d+/);
    assert.match(lines.at(-1) ?? "", /^took EVENTS's snapshot: 120 messages to 120$/);
    // A second backup in the same second never writes over the first.
    await assert.rejects(
      backupControl({ stateDir: dir, into, bus: new FakeBackupBus(bus), build: BUILD, now: at }),
      /is there already: a backup never writes over one/,
    );
  });

  test("a restore onto an empty bus brings EVENTS back, checked, and control starts on it", async () => {
    const { dir, bus } = await controlState(120);
    const into = fresh("backups");
    const { folder } = await backupControl({
      stateDir: dir,
      into,
      bus: new FakeBackupBus(bus),
      build: BUILD,
    });
    // A new machine: an empty state folder and an empty bus.
    const target = fresh("restored");
    const newBus = new FakeBus();
    const lines: string[] = [];
    const r = await restoreControl({
      from: folder,
      stateDir: target,
      bus: new FakeBackupBus(newBus),
      say: (l) => lines.push(l),
    });
    assert.equal(r.replaced, undefined);
    assert.deepEqual(lines.slice(1), [
      "EVENTS: restoring 120 messages; the bus's server needs about 129 MiB of memory for it",
      "EVENTS: restored and checked, 120 messages to 120",
      "control's state: the backup's put back",
    ]);
    assert.deepEqual(
      newBus.kept.map((k) => [k.seq, k.subject, k.data]),
      bus.kept.filter((k) => k.stream === EVENT_STREAM).map((k) => [k.seq, k.subject, k.data]),
    );
    for (const name of [CONTROL_STATE.signingKey, "kits/matmul/HEAD", "exports/rig-b/ledger.db"])
      assert.deepEqual(readFileSync(join(target, name)), readFileSync(join(dir, name)), name);
    assert.equal(existsSync(join(target, "notes.txt")), false, "not control's: not in the backup");
    assert.equal(placeIn(target), 120);
    // Control starts on the restored store and stream: its start check holds, and it applies the
    // stream from its place, including what came after it.
    const store = new ControlStore(join(target, CONTROL_STATE.db));
    const apply = new EventsApply({ store, bus: newBus, retryMs: 5 });
    await apply.start();
    assert.equal(apply.stopped, null);
    assert.equal(store.busPositions.of(EVENT_STREAM), 120);
    apply.close();
    store.db.close();
    // Run again, it finds the stream and the state as the backup holds them, and changes nothing.
    const again: string[] = [];
    await restoreControl({
      from: folder,
      stateDir: target,
      bus: new FakeBackupBus(newBus),
      say: (l) => again.push(l),
    });
    assert.ok(again.includes("EVENTS is on the bus as the backup holds it"));
  });

  test("a restore over control's state keeps what it replaces, moved aside, never deleted", async () => {
    const { dir, bus } = await controlState(60);
    const { folder } = await backupControl({
      stateDir: dir,
      into: fresh("backups"),
      bus: new FakeBackupBus(bus),
      build: BUILD,
    });
    // Control goes on after the backup: a new kit, a new key, its store further on.
    writeFileSync(join(dir, CONTROL_STATE.signingKey), "a newer signing key\n");
    mkdirSync(join(dir, "kits", "later"));
    writeFileSync(join(dir, "kits", "later", "HEAD"), "later\n");
    const before = readFileSync(join(dir, CONTROL_STATE.db));
    const at = new Date("2026-10-29T11:00:00.000Z");
    const r = await restoreControl({
      from: folder,
      stateDir: dir,
      bus: new FakeBackupBus(bus),
      now: at,
    });
    const aside = join(dir, "replaced-2026-10-29T11-00-00-000Z");
    assert.equal(r.replaced, aside);
    assert.equal(
      readFileSync(join(aside, CONTROL_STATE.signingKey), "utf8"),
      "a newer signing key\n",
    );
    assert.equal(readFileSync(join(aside, "kits", "later", "HEAD"), "utf8"), "later\n");
    assert.deepEqual(readFileSync(join(aside, CONTROL_STATE.db)), before);
    assert.equal(readFileSync(join(dir, CONTROL_STATE.signingKey), "utf8"), "the signing key\n");
    assert.equal(existsSync(join(dir, "kits", "later")), false);
    assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "the owner's own file\n");
    assert.equal(statSync(join(dir, CONTROL_STATE.busCaKey)).mode & 0o777, 0o600);
    assert.equal(placeIn(dir), 60);
  });

  test("a stream that comes back short is refused, naming it, and control's state is left", async () => {
    const { dir, bus } = await controlState(120);
    const { folder } = await backupControl({
      stateDir: dir,
      into: fresh("backups"),
      bus: new FakeBackupBus(bus),
      build: BUILD,
    });
    const target = fresh("restored");
    const newBus = new FakeBus();
    // The server is stopped part way through the restore: it keeps a stream that looks whole.
    const stopped = new FakeBackupBus(newBus);
    stopped.stopAfter = 70;
    await assert.rejects(
      restoreControl({ from: folder, stateDir: target, bus: stopped }),
      refused(
        /^the restore of EVENTS failed: connection closed\. .*Nothing of control's state was changed\.$/,
      ),
    );
    assert.deepEqual(readdirSync(target), []);
    // Run again with the server back: the stream it left is refused, named, not taken as whole.
    await assert.rejects(
      restoreControl({ from: folder, stateDir: target, bus: new FakeBackupBus(newBus) }),
      refused(
        /^EVENTS on the bus is not the backup's: it holds 70 messages to 70, and the backup holds 120 to 120\./,
      ),
    );
    assert.deepEqual(readdirSync(target), []);
  });

  test("a stream the bus holds that is not the backup's is refused, as is a changed backup", async () => {
    const { dir, bus } = await controlState(60);
    const { folder } = await backupControl({
      stateDir: dir,
      into: fresh("backups"),
      bus: new FakeBackupBus(bus),
      build: BUILD,
    });
    const before = readdirSync(dir).sort();
    // The bus ran on since the backup: its stream holds more.
    const store = controlStore(join(fresh("other"), CONTROL_STATE.db), bus);
    await ingestReport(store, page("rig-c", 1, 5));
    closeBus(store);
    await assert.rejects(
      restoreControl({ from: folder, stateDir: dir, bus: new FakeBackupBus(bus) }),
      refused(
        /^EVENTS on the bus is not the backup's: it holds 65 messages to 65, and the backup holds 60 to 60\./,
      ),
    );
    assert.deepEqual(readdirSync(dir).sort(), before);
    // A file of the backup that changed since: refused before anything is looked at.
    const key = join(folder, "state", CONTROL_STATE.busCaKey);
    chmodSync(key, 0o600);
    writeFileSync(key, "another key\n");
    await assert.rejects(
      restoreControl({ from: folder, stateDir: dir, bus: new FakeBackupBus(new FakeBus()) }),
      refused(/^state\/bus-ca\.key is not the file the backup's manifest names: it changed$/),
    );
  });
});
