import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  setBusStoreAside,
} from "../../../src/common/backup/index.ts";
import { BackupManifest, CONTROL_STATE, restoreMemoryBytes } from "../../../src/core/backup.ts";
import { EVENT_STREAM, EVENT_STREAM_CONFIG } from "../../../src/core/link/events.ts";
import { FakeBackupBus } from "../../helpers/fake-backup-bus.ts";
import { FakeBus } from "../../helpers/fake-bus.ts";

/**
 * The parts of a backup and a restore that need no control (goal 173): the bus's store set aside,
 * never deleted; a manifest read back refuses a path outside the backup; a backup that stopped
 * part way is left as `.partial` and is never read as whole; the memory a restore needs; which
 * stream on the bus a restore keeps, and which it refuses.
 */

const fresh = (name: string) => mkdtempSync(join(tmpdir(), `thermite-${name}-`));
const BUILD = { version: "0.1.1", commit: null };
const places = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A bus whose EVENTS stream holds a message at each of `at`; the one at `changed` another. */
function eventsAt(at: readonly number[], changed?: number): FakeBus {
  const bus = new FakeBus();
  bus.putStream(
    EVENT_STREAM_CONFIG,
    at.map((seq) => ({
      stream: EVENT_STREAM,
      subject: "thermite.rig.rig-a.ev.journal_note",
      seq,
      id: undefined,
      data: seq === changed ? `another event at ${seq}` : `event ${seq}`,
      headers: {},
    })),
  );
  return bus;
}

/** A backup of a control whose bus holds `bus`'s EVENTS. */
async function backupOf(bus: FakeBus): Promise<string> {
  const dir = fresh("control");
  writeFileSync(join(dir, CONTROL_STATE.db), "");
  const backup = { stateDir: dir, into: fresh("backups"), bus: new FakeBackupBus(bus) };
  return (await backupControl({ ...backup, build: BUILD })).folder;
}

/** What a restore says of the stream it finds on `bus`, into a new state folder. */
async function keeps(folder: string, bus: FakeBus): Promise<string | undefined> {
  const lines: string[] = [];
  const stateDir = fresh("restored");
  await restoreControl({
    from: folder,
    stateDir,
    bus: new FakeBackupBus(bus),
    say: (l) => lines.push(l),
  });
  return lines[1];
}

/** A restore refused for the stream on `bus`, for `why`, with nothing of control's written. */
async function refuses(folder: string, bus: FakeBus, why: string): Promise<void> {
  const stateDir = fresh("restored");
  await assert.rejects(
    restoreControl({ from: folder, stateDir, bus: new FakeBackupBus(bus) }),
    (err: unknown) =>
      err instanceof RestoreRefused &&
      err.message.startsWith(`EVENTS on the bus is not the backup's: ${why}. `) &&
      err.message.endsWith(" Nothing of control's state was changed."),
  );
  assert.deepEqual(readdirSync(stateDir), []);
}

describe("a backup's parts (goal 173)", () => {
  test("the bus's store is set aside into a dated folder inside it, nothing deleted", () => {
    const store = fresh("bus-store");
    const block = join(store, "jetstream", "THERMITE", "streams", "EVENTS", "msgs");
    mkdirSync(block, { recursive: true });
    writeFileSync(join(block, "1.blk"), "the stream's first block");
    mkdirSync(join(store, "replaced-2026-10-28T09-00-00-000Z"));
    const aside = setBusStoreAside(store, new Date("2026-10-29T12:00:00.000Z"));
    assert.equal(aside, join(store, "replaced-2026-10-29T12-00-00-000Z"));
    assert.deepEqual(readdirSync(store).sort(), [
      "replaced-2026-10-28T09-00-00-000Z",
      "replaced-2026-10-29T12-00-00-000Z",
    ]);
    assert.equal(
      readFileSync(
        join(aside, "jetstream", "THERMITE", "streams", "EVENTS", "msgs", "1.blk"),
        "utf8",
      ),
      "the stream's first block",
    );
    // An empty store: nothing to move. No store at all: said in words.
    assert.equal(setBusStoreAside(store, new Date("2026-10-29T12:01:00.000Z")), undefined);
    assert.throws(
      () => setBusStoreAside(join(store, "none")),
      (err: unknown) => err instanceof RestoreRefused && /: the bus's store$/.test(err.message),
    );
  });

  test("a manifest names control's files only inside the backup's state folder", () => {
    const sha256 = "0".repeat(64);
    const of = (path: string) =>
      BackupManifest.safeParse({
        v: 1,
        of: "control",
        made_at: "2026-10-29T12:00:00.000Z",
        thermite: { version: "0.1.1", commit: null },
        store: { schema: 13, positions: { EVENTS: 4 } },
        files: [{ path, bytes: 1, sha256 }],
        streams: [],
        left_out: {},
      }).success;
    assert.equal(of("state/control.db"), true);
    assert.equal(of("state/kits/matmul/HEAD"), true);
    for (const bad of [
      "../etc/passwd",
      "state/../../x",
      "/state/control.db",
      "state//x",
      "streams/EVENTS.snapshot",
      "other/x",
      "state",
    ])
      assert.equal(of(bad), false, bad);
  });

  test("a backup that stops part way is left as .partial, and never read as whole", async () => {
    const dir = fresh("control");
    writeFileSync(join(dir, CONTROL_STATE.db), "");
    const into = fresh("backups");
    // A bus with no EVENTS stream: the snapshot fails after control's files were copied.
    await assert.rejects(
      backupControl({
        stateDir: dir,
        into,
        bus: new FakeBackupBus(new FakeBus()),
        build: { version: "0.1.1", commit: null },
        now: new Date("2026-10-29T12:00:00.000Z"),
      }),
      /stream not found/,
    );
    const left = readdirSync(into);
    assert.deepEqual(left, ["thermite-backup-2026-10-29T12-00-00-000Z.partial"]);
    assert.throws(
      () => readManifest(join(into, left[0] ?? "")),
      /has no manifest\.json: not a whole backup \(one that stopped part way ends in \.partial\)$/,
    );
    // A folder that is not control's state is refused before anything is written.
    await assert.rejects(
      backupControl({
        stateDir: fresh("empty"),
        into,
        bus: new FakeBackupBus(new FakeBus()),
        build: { version: "0.1.1", commit: null },
      }),
      /holds no control\.db: is it control's state folder\?$/,
    );
    assert.equal(existsSync(join(into, "thermite-backup")), false);
  });

  test("a restore's memory: about 1 KiB a message over 128 MiB", () => {
    assert.equal(restoreMemoryBytes(0), 128 * 2 ** 20);
    // A million events: the pinned server took 879 MiB at the most; 500,000 stopped one of 256 MiB.
    assert.equal(Math.ceil(restoreMemoryBytes(1_000_000) / 2 ** 20), 1105);
    assert.ok(restoreMemoryBytes(500_000) > 256 * 2 ** 20);
  });

  test("a stream on the bus is kept when it holds the backup's events, newer ones after or none", async () => {
    const folder = await backupOf(eventsAt(places(1, 60)));
    assert.equal(
      await keeps(folder, eventsAt(places(1, 60))),
      "EVENTS is on the bus as the backup holds it",
    );
    // A bus that ran on since the backup; control's place in the backup (an empty store's) is 0.
    assert.equal(
      await keeps(folder, eventsAt(places(1, 65))),
      "EVENTS on the bus holds the backup's events and 5 newer ones after them, to 65: control applies them from its place, 0, as it starts",
    );
    // A backup of a stream with no event yet: any stream from the first place on holds it.
    assert.equal(
      await keeps(await backupOf(eventsAt([])), eventsAt(places(1, 3))),
      "EVENTS on the bus holds the backup's events and 3 newer ones after them, to 3: control applies them from its place, 0, as it starts",
    );
  });

  test("any other stream on the bus is refused, naming what differs", async () => {
    const folder = await backupOf(eventsAt(places(1, 60)));
    await refuses(
      folder,
      eventsAt(places(1, 59)),
      "it holds 59 messages to 59, and the backup holds 60 to 60",
    );
    await refuses(
      folder,
      eventsAt(places(1, 65), 60),
      "its message at 60, the backup's last place, is not the one the backup recorded",
    );
    await refuses(folder, eventsAt(places(2, 65)), "its first place is 2, and the backup's is 1");
    // A place with no message: the stream deletes none, so it is not the backup's.
    await refuses(
      folder,
      eventsAt(places(1, 65).filter((p) => p !== 30)),
      "it holds 64 messages to 65, and the backup holds 60 to 60: a place holds no message, and this stream deletes none",
    );
  });
});
