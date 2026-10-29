import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createUser, fromSeed } from "@nats-io/nkeys";
import {
  BUS_CONFIG_DIR_SETTING,
  BUS_USERS_FILE,
  BUS_USERS_SYNC_MS,
  BusUsers,
  busConfigDir,
  takeRigBusKey,
} from "../../../src/control/bus/users.ts";
import { STEP_WORDS } from "../../../src/control/rigs/setup.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import {
  BUS_ACCOUNT,
  backupPermissions,
  controlPermissions,
  rigPermissions,
  SYSTEM_ACCOUNT,
  userKeyFingerprint,
} from "../../../src/core/link/users.ts";
import { controlOnly, RIG_TOKEN } from "../../helpers/control-stack.ts";

const RIG_B_TOKEN = "rig-b-token-abcdef";
const user = () => createUser().getPublicKey();
const usersPath = () => join(mkdtempSync(join(tmpdir(), "thermite-bus-users-")), "users.conf");

/** The server's side of a reload: each call's seed, and whether it fails. */
class FakeServer {
  readonly calls: string[] = [];
  failing = false;
  reload = async (seed: Uint8Array) => {
    this.calls.push(fromSeed(seed).getPublicKey());
    if (this.failing) throw new Error("connection refused: nats:4222");
  };
}

/** The users file's accounts, read back from its JSON value. */
function accountsIn(path: string) {
  const text = readFileSync(path, "utf8");
  const json = /^accounts: (\{[\s\S]*?\n\})$/m.exec(text)?.[1] ?? "{}";
  return JSON.parse(json) as Record<string, { users: { nkey: string; permissions?: unknown }[] }>;
}

/** Control with two rigs, the bus's users kept in a file, and a fake server that reloads. */
function setup(o: { secrets?: SecretBox; store?: ControlStore } = {}) {
  const file = usersPath();
  const server = new FakeServer();
  const secrets = o.secrets ?? SecretBox.ephemeral();
  let users: BusUsers | undefined;
  const s = controlOnly({
    tokens: { rigs: { "rig-a": RIG_TOKEN, "rig-b": RIG_B_TOKEN } },
    ...(o.store ? { store: o.store } : {}),
    options: (store) => {
      users = new BusUsers({ store, secrets, file, reload: server.reload });
      return { busUsers: users };
    },
  });
  if (!users) throw new Error("no bus users");
  /** The supervisor's regular call, its figures with this key. */
  const figures = (rig: string, busKey: unknown) =>
    s.control.request(`/v1/rigs/${rig}/supervisor`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rig === "rig-a" ? RIG_TOKEN : RIG_B_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ at: new Date().toISOString(), bus_key: busKey }),
    });
  const audits = (action: string) => s.store.auditLog.list(50, { action }).map((e) => e.body);
  const steps = (rig: string) =>
    s.store.rigHistory.list(rig).filter((e) => e.step.startsWith("bus"));
  return { ...s, file, server, users, secrets, figures, audits, steps };
}

describe("each rig's key on the message bus", () => {
  test("control records a rig's first key, gives it a user, and has the server reload", async () => {
    const s = setup();
    await s.users.sync();
    assert.equal(s.server.calls.length, 1, "the users file is written and reloaded at start");
    const key = user();
    const r = await s.figures("rig-a", key);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(s.store.busKeys.rigKey("rig-a"), key);
    const fp = userKeyFingerprint(key);
    assert.deepEqual(s.audits("rig_bus_key_registered"), [{ fingerprint: fp }]);
    assert.deepEqual(
      s.steps("rig-a").map((e) => [e.step, e.ok, e.detail]),
      [["bus_key", true, `fingerprint ${fp}`]],
    );
    assert.equal(STEP_WORDS.bus_key, "Its key on the message bus registered");
    // The answer came after the reload: the supervisor may sign in at once.
    assert.equal(s.server.calls.length, 2);
    const users = accountsIn(s.file)[BUS_ACCOUNT]?.users ?? [];
    assert.deepEqual(users[1], { nkey: key, permissions: rigPermissions("rig-a") });
    // The key is kept apart from the figures, which pages show.
    assert.equal("bus_key" in (s.store.reportedRigs.supervisor("rig-a") ?? {}), false);
    // The same key again changes nothing, and asks no reload.
    assert.equal((await s.figures("rig-a", key)).status, 200);
    assert.equal(s.server.calls.length, 2);
    assert.equal(s.audits("rig_bus_key").length, 1);
  });

  test("a change of key is kept in the rig's history and the audit log, and reloaded", async () => {
    const s = setup();
    const [first, second] = [user(), user()];
    await s.figures("rig-a", first);
    const before = s.server.calls.length;
    assert.equal((await s.figures("rig-a", second)).status, 200);
    const [was, now] = [userKeyFingerprint(first), userKeyFingerprint(second)];
    assert.deepEqual(s.audits("rig_bus_key_changed"), [{ fingerprint: now, previous: was }]);
    assert.deepEqual(
      s.steps("rig-a").map((e) => [e.step, e.detail]),
      [
        ["bus_key", `fingerprint ${was}`],
        ["bus_key_changed", `fingerprint ${was} → ${now}`],
      ],
    );
    assert.equal(STEP_WORDS.bus_key_changed, "Its key on the message bus changed");
    assert.equal(s.server.calls.length, before + 1);
    const text = readFileSync(s.file, "utf8");
    assert.ok(text.includes(second));
    assert.ok(!text.includes(first), "the old key has no user any more");
  });

  test("a key that is not a NATS user key is refused, and nothing is recorded", async () => {
    const s = setup();
    await s.users.sync();
    const calls = s.server.calls.length;
    const seed = new TextDecoder().decode(createUser().getSeed());
    for (const bad of ["UNOTAKEY", seed, user().toLowerCase(), 42, "A".repeat(200)]) {
      const r = await s.figures("rig-a", bad);
      assert.equal(r.status, 400, String(bad));
      const body = (await r.json()) as { error: string };
      if (typeof bad === "string" && bad.length <= 100) {
        assert.equal(
          body.error,
          "bus_key is not a NATS user key's public part: 56 characters of A-Z and 2-7, starting with U",
        );
        assert.ok(!body.error.includes(bad), "the answer does not repeat what was sent");
      }
    }
    assert.equal(s.store.busKeys.rigKey("rig-a"), undefined);
    assert.deepEqual(s.audits("rig_bus_key"), []);
    assert.deepEqual(s.steps("rig-a"), []);
    assert.equal(
      s.store.reportedRigs.supervisor("rig-a"),
      null,
      "the figures with it are refused whole",
    );
    assert.equal(s.server.calls.length, calls);
    // Figures without a key are taken as before.
    const r = await s.figures("rig-a", undefined);
    assert.equal(r.status, 200);
  });

  test("the users file names control, its system user and each rig with its own permissions", async () => {
    const s = setup();
    const keys = { a: user(), b: user() };
    await s.figures("rig-a", keys.a);
    await s.figures("rig-b", keys.b);
    assert.equal(statSync(s.file).mode & 0o777, 0o644);
    const accounts = accountsIn(s.file);
    const control = accounts[BUS_ACCOUNT]?.users[0];
    assert.deepEqual(
      control?.permissions,
      controlPermissions(),
      "control may do everything but delete or purge a stream kept for good",
    );
    assert.deepEqual(accounts[BUS_ACCOUNT]?.users.slice(1), [
      { nkey: keys.a, permissions: rigPermissions("rig-a") },
      { nkey: keys.b, permissions: rigPermissions("rig-b") },
    ]);
    assert.equal(accounts[SYSTEM_ACCOUNT]?.users.length, 1);
    // Each reload signs in as the system user, whose key is the file's.
    const system = accounts[SYSTEM_ACCOUNT]?.users[0]?.nkey;
    assert.ok(s.server.calls.length > 0);
    for (const k of s.server.calls) assert.equal(k, system);
    // Control signs in to the bus as its own user, not as the system one.
    assert.equal(fromSeed(s.users.controlSeed).getPublicKey(), control?.nkey);
    // No seed is in the file.
    assert.ok(!/\bS[UA][A-Z2-7]{56}\b/.test(readFileSync(s.file, "utf8")));
  });

  test("a reload that fails is logged without a key, and tried again at the next sync", async (t) => {
    const s = setup();
    s.server.failing = true;
    const said: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => said.push(chunk));
    await s.figures("rig-a", user());
    t.mock.restoreAll();
    const line = said.find((l) => l.includes("did not reload its users"));
    assert.ok(line, said.join(""));
    assert.match(line, /connection refused/);
    assert.ok(!/\b[US][A-Z2-7]{55,57}\b/.test(said.join("")), "no key or seed in the log");
    const calls = s.server.calls.length;
    s.server.failing = false;
    await s.users.sync();
    assert.equal(s.server.calls.length, calls + 1);
    // Taken now: the next sync with nothing new asks nothing.
    await s.users.sync();
    assert.equal(s.server.calls.length, calls + 1);
  });

  test("the server's certificate is written before its users, and a new one is reloaded", async () => {
    const file = usersPath();
    const server = new FakeServer();
    const order: string[] = [];
    let renew = true;
    const tls = {
      write: () => {
        order.push(existsSync(file) ? "certificate after the users" : "certificate");
        const wrote = renew;
        renew = false;
        return wrote;
      },
    };
    const store = new ControlStore(":memory:");
    const users = new BusUsers({
      store,
      secrets: SecretBox.ephemeral(),
      file,
      tls,
      reload: server.reload,
    });
    await users.sync();
    assert.deepEqual(order, ["certificate"]);
    assert.equal(server.calls.length, 1);
    // Nothing new: no reload.
    await users.sync();
    assert.equal(server.calls.length, 1);
    // A certificate made anew, as near its end: the server reads it again, with the same users.
    renew = true;
    await users.sync();
    assert.equal(server.calls.length, 2);
    // A certificate that can't be written is logged, and the users wait for it.
    const broken = new BusUsers({
      store: new ControlStore(":memory:"),
      secrets: SecretBox.ephemeral(),
      file: usersPath(),
      tls: {
        write: () => {
          throw new Error("EACCES: permission denied");
        },
      },
      reload: server.reload,
    });
    await broken.sync();
    assert.equal(server.calls.length, 2);
  });

  test("the runs control's run registry gives a rig open their live subjects to its user", async () => {
    const s = setup();
    const key = user();
    await s.figures("rig-a", key);
    const calls = s.server.calls.length;
    const at = new Date().toISOString();
    const created = { kind: "run_created", subject: "sort-3", body: { campaign: "sort" }, at };
    s.store.runRegistry.registerRunCreated("rig-a", "ledger-1", created);
    s.store.runRegistry.registerRunCreated("rig-b", "ledger-2", { ...created, subject: "other-1" });
    // Looked at every few seconds: a new run is written, and the server reloads once.
    assert.equal(BUS_USERS_SYNC_MS, 5000);
    await s.users.sync();
    assert.equal(s.server.calls.length, calls + 1);
    const users = accountsIn(s.file)[BUS_ACCOUNT]?.users ?? [];
    assert.deepEqual(users[1], { nkey: key, permissions: rigPermissions("rig-a", ["sort-3"]) });
    assert.ok(!JSON.stringify(users[1]).includes("other-1"), "another rig's run is not rig-a's");
    await s.users.sync();
    assert.equal(s.server.calls.length, calls + 1, "nothing changed: no reload");
  });

  test("a rig retired loses its user at the next sync; a rig not on the bus has none", async () => {
    const s = setup();
    const key = user();
    await s.figures("rig-a", key);
    const calls = s.server.calls.length;
    s.store.retired.add("rig-a", "owner:test");
    await s.users.sync();
    assert.equal(s.server.calls.length, calls + 1);
    assert.ok(!readFileSync(s.file, "utf8").includes(key));
    assert.equal(accountsIn(s.file)[BUS_ACCOUNT]?.users.length, 1, "control's own alone");
    // Its key stays recorded: brought back, it has its user again.
    s.store.retired.bringBack("rig-a", "owner:test");
    await s.users.sync();
    assert.ok(readFileSync(s.file, "utf8").includes(key));
  });

  test("control's own keys are made once, kept sealed, and the same after a restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-bus-store-")), "control.db");
    const secrets = SecretBox.ephemeral();
    const first = setup({ secrets, store: new ControlStore(path) });
    await first.users.sync();
    const control = fromSeed(first.users.controlSeed).getPublicKey();
    const rows = first.store.db.prepare("select * from bus_identity order by name").all();
    assert.deepEqual(
      rows.map((r) => r.name),
      ["control", "system"],
    );
    // Sealed: control's seed is in no row as it is (a seed's text starts "SU" and is 58 long).
    const seed = new TextDecoder().decode(first.users.controlSeed);
    assert.match(seed, /^SU[A-Z2-7]{56}$/);
    for (const r of rows) {
      assert.match(String(r.seed_sealed), /^s1:/);
      assert.ok(!String(r.seed_sealed).includes(seed));
    }
    first.store.db.close();
    const again = setup({ secrets, store: new ControlStore(path) });
    assert.equal(fromSeed(again.users.controlSeed).getPublicKey(), control);
    again.store.db.close();
    // With another secrets key, the seeds do not open: control says what to look at.
    const store = new ControlStore(path);
    assert.throws(
      () =>
        new BusUsers({
          store,
          secrets: SecretBox.ephemeral(),
          file: usersPath(),
          reload: async () => {},
        }),
      /^Error: control's control key on the message bus does not open with its secrets key \(was THERMITE_CONTROL_SECRETS_KEY_FILE replaced\?\)$/,
    );
    store.db.close();
  });

  test("the backup's key: made once in its file, 0600, a user that may back up and restore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-bus-backup-"));
    const seedFile = join(dir, "bus-backup.seed");
    const store = new ControlStore(":memory:");
    const secrets = SecretBox.ephemeral();
    const make = (file = usersPath()) =>
      new BusUsers({
        store,
        secrets,
        file,
        reload: async () => {},
        backupSeedFile: seedFile,
      });
    const file = usersPath();
    await make(file).sync();
    assert.equal(statSync(seedFile).mode & 0o777, 0o600);
    const seed = readFileSync(seedFile, "utf8");
    assert.match(seed, /^SU[A-Z2-7]{56}$/);
    const backup = fromSeed(new TextEncoder().encode(seed)).getPublicKey();
    const users = accountsIn(file)[BUS_ACCOUNT]?.users ?? [];
    assert.deepEqual(users[1], { nkey: backup, permissions: backupPermissions() });
    // Control started again keeps it.
    await make().sync();
    assert.equal(readFileSync(seedFile, "utf8"), seed);
    // A file that holds no seed stops control, saying what to do.
    const bad = join(dir, "bad.seed");
    writeFileSync(bad, "not a seed\n");
    assert.throws(
      () =>
        new BusUsers({
          store,
          secrets,
          file: usersPath(),
          reload: async () => {},
          backupSeedFile: bad,
        }),
      /does not hold the seed of a NATS user key: remove it, and control makes the backup's key anew as it starts$/,
    );
    store.db.close();
  });

  test("a key is recorded without the bus too; control needs the server's folder named", () => {
    const store = new ControlStore(":memory:");
    const key = user();
    assert.equal(takeRigBusKey(store, "rig-a", key), "new");
    assert.equal(takeRigBusKey(store, "rig-a", key), "same");
    assert.equal(takeRigBusKey(store, "rig-a", user()), "changed");
    assert.equal(BUS_CONFIG_DIR_SETTING, "THERMITE_NATS_CONFIG_DIR");
    assert.equal(BUS_USERS_FILE, "users.conf");
    assert.equal(busConfigDir({ THERMITE_NATS_CONFIG_DIR: " /nats-config " }), "/nats-config");
    for (const env of [{}, { THERMITE_NATS_CONFIG_DIR: " " }])
      assert.throws(
        () => busConfigDir(env),
        /^Error: control needs THERMITE_NATS_CONFIG_DIR: the folder control writes the bus's users and TLS certificate to, which the server's configuration includes$/,
      );
  });
});
