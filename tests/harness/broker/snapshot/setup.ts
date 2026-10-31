/**
 * The rig's state over a stop that empties the container's disk (a RunPod pod): live on the
 * container's disk, a sealed snapshot on the volume. The live tree, its ledger and the opened
 * manifest that the snapshot's tests share.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deriveKeys, unseal } from "../../../../src/harness/broker/seal.ts";
import {
  backupLedger,
  LEDGER_FILE,
  restoreSnapshot,
  SEALED,
  type SnapshotArea,
  type SnapshotManifest,
  takeSnapshot,
} from "../../../../src/harness/broker/snapshot/index.ts";

export const uid = process.getuid?.() ?? 0;
export const gid = process.getgid?.() ?? 0;
export const RIG = "rp-test0001";

/** A rig's live state under `root/live`, with every part, its snapshot folder and its key. */
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "thermite-snapshot-"));
  const live = join(root, "live");
  const dir = join(root, "volume", "thermite");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const areas: SnapshotArea[] = [
    { name: "harness", live: join(live, "harness"), uid, gid },
    { name: "outbox", live: join(live, "outbox"), uid, gid },
    { name: "inbox", live: join(live, "inbox"), uid, gid },
    { name: "supervisor", live: join(live, "supervisor"), uid, gid },
    { name: "secrets", live: join(live, "secrets"), uid, gid, only: "supervisor-token" },
  ];
  const put = (path: string, text: string, mode = 0o644) => {
    mkdirSync(dirname(join(live, path)), { recursive: true });
    writeFileSync(join(live, path), text);
    chmodSync(join(live, path), mode);
  };
  const key = randomBytes(32);
  const keys = deriveKeys(key);
  const take = (reason: string, o: { backup?: (s: string) => Promise<string> } = {}) =>
    takeSnapshot({
      dir,
      areas,
      reason,
      keys,
      rig: RIG,
      backupLedger: o.backup ?? stagedBackup(root),
    });
  const restore = (o: { keys?: typeof keys; rig?: string; areas?: SnapshotArea[] } = {}) =>
    restoreSnapshot({
      dir,
      areas: o.areas ?? areas,
      keys: o.keys ?? keys,
      rig: o.rig ?? RIG,
      own: () => undefined,
    });
  return { root, live, dir, areas, put, key, keys, take, restore };
}

/** A ledger in WAL mode, as the harness keeps it, with `rows` rows in each of two tables. */
export function makeLedger(path: string, rows = 3): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; create table a (n integer); create table b (n integer);");
  for (let i = 0; i < rows; i++) {
    db.prepare("insert into a values (?)").run(i);
    db.prepare("insert into b values (?)").run(i);
  }
  db.close();
}

export const rowsIn = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const one = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    return {
      ok: (db.prepare("pragma integrity_check").get() as Record<string, string>).integrity_check,
      a: one("select count(*) as n from a"),
      b: one("select count(*) as n from b"),
    };
  } finally {
    db.close();
  }
};

/** The ledger's copy for a take, made in-process as the broker's helper makes it. */
export const stagedBackup = (root: string) => async (source: string) => {
  const copy = join(root, `staged-${Math.random().toString(36).slice(2)}.db`);
  await backupLedger(source, copy);
  return copy;
};

/** A typical live state: the ledger, a kit, a build, an export, the supervisor's keys, a token. */
export function typicalState(f: ReturnType<typeof fixture>): void {
  makeLedger(join(f.live, "harness", LEDGER_FILE));
  chmodSync(join(f.live, "harness", "ledger"), 0o700);
  f.put("harness/ledger/rig-signing.key", "rig key", 0o600);
  f.put("harness/kits/abc/kit.json", '{"kit":1}');
  f.put("harness/builds/k1/bin/run", "#!/bin/sh\n", 0o755);
  chmodSync(join(f.live, "harness", "builds"), 0o711);
  f.put("harness/rig-settings.json", "{}", 0o600);
  f.put("outbox/20261022-aaaa/manifest.json", "{}", 0o640);
  f.put("outbox/.tmp-20261022-bbbb/manifest.json", "half written");
  f.put("inbox/models/m.bin", "weights", 0o640);
  f.put("supervisor/tunnel/keys.json", '{"sign":"private"}', 0o600);
  chmodSync(join(f.live, "supervisor", "tunnel"), 0o700);
  f.put("supervisor/enrolled/control.pub", "control key");
  f.put("supervisor/enrolled/rig.env", "THERMITE_RIG_ID=rig-1\n");
  f.put("supervisor/relay-state.json", '{"cursor":7}', 0o600);
  f.put("supervisor/tmp/scratch", "temporary");
  f.put("supervisor/harness-token", "copy of the token", 0o600);
  f.put("secrets/supervisor-token", "the token", 0o600);
  f.put("secrets/other", "not ours");
}

/** The snapshot's manifest, opened with the pod's keys. */
export const manifestOf = (f: ReturnType<typeof fixture>, name: string = SEALED.manifest) =>
  JSON.parse(
    unseal(f.keys.manifest, "manifest", readFileSync(join(f.dir, name))).toString("utf8"),
  ) as SnapshotManifest;

/** The sealed file a path of a part is in. */
export const sealedOf = (f: ReturnType<typeof fixture>, label: string) => {
  const e = manifestOf(f).entries.find((x) => `${x.area}/${x.path}` === label);
  assert.ok(e?.sealed, `${label} is in the snapshot`);
  return join(f.dir, e.sealed);
};
