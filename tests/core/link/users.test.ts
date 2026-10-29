import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAccount, createUser } from "@nats-io/nkeys";
import { commandConsumerName } from "../../../src/core/link/commands.ts";
import { configConsumerName, configSubjects } from "../../../src/core/link/config.ts";
import { EVENT_STREAM, EVENT_SUBJECTS } from "../../../src/core/link/events.ts";
import { REPORT_STREAM } from "../../../src/core/link/report.ts";
import {
  BACKUP_INBOX_PREFIX,
  BUS_ACCOUNT,
  backupPermissions,
  controlPermissions,
  isUserKey,
  jetStreamFiguresSubject,
  reloadSubject,
  rigInboxPrefix,
  rigPermissions,
  STREAMS_KEPT_FOR_GOOD,
  SYSTEM_ACCOUNT,
  userKeyFingerprint,
  usersFile,
} from "../../../src/core/link/users.ts";

const user = () => createUser().getPublicKey();

/** A users file's accounts and system account, read back from its JSON values. */
function readUsers(text: string) {
  const accounts = /^accounts: (\{[\s\S]*?\n\})$/m.exec(text)?.[1];
  const system = /^system_account: (.*)$/m.exec(text)?.[1];
  assert.ok(accounts && system, "the file has its accounts and its system account");
  return {
    accounts: JSON.parse(accounts) as Record<
      string,
      { jetstream?: string; users: { nkey: string; permissions?: unknown }[] }
    >,
    system: JSON.parse(system) as string,
  };
}

describe("who may do what on the message bus", () => {
  test("a user key is an nkey's public part that starts with U, its checksum right", () => {
    const key = user();
    assert.equal(isUserKey(key), true);
    const seed = new TextDecoder().decode(createUser().getSeed());
    for (const bad of [
      "",
      key.toLowerCase(),
      key.slice(0, -1),
      `${key}A`,
      // Its last character changed: the checksum no longer matches.
      `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`,
      createAccount().getPublicKey(),
      seed,
      "U".padEnd(56, "1"),
    ])
      assert.equal(isUserKey(bad), false, bad);
  });

  test("a key's fingerprint is short and is not the key", () => {
    const key = user();
    const fp = userKeyFingerprint(key);
    assert.match(fp, /^[0-9a-f]{16}$/);
    assert.equal(fp, userKeyFingerprint(key));
    assert.notEqual(fp, userKeyFingerprint(user()));
    assert.ok(!key.includes(fp));
  });

  test("a rig may publish its own reports, live lines and files, ask control to search and read the knowledge base, take its own commands and read its own config, and nothing else", () => {
    assert.deepEqual(rigPermissions("rig-a"), {
      publish: {
        allow: [
          "thermite.rig.rig-a.report",
          "thermite.rig.rig-a.live.*",
          "$JS.API.CONSUMER.INFO.COMMANDS.rig-rig-a-commands",
          "$JS.API.CONSUMER.MSG.NEXT.COMMANDS.rig-rig-a-commands",
          "$JS.ACK.COMMANDS.rig-rig-a-commands.>",
          "$JS.API.CONSUMER.INFO.CONFIG.rig-rig-a-config",
          "$JS.API.CONSUMER.MSG.NEXT.CONFIG.rig-rig-a-config",
          "$JS.ACK.CONFIG.rig-rig-a-config.>",
          "$JS.API.DIRECT.GET.CONFIG.thermite.rig.rig-a.config.*",
          "thermite.rig.rig-a.kbfile",
          "thermite.kb.search.rig-a",
          "thermite.kb.read.rig-a",
        ],
      },
      subscribe: { allow: ["_INBOX.rig.rig-a.>"] },
    });
    // It puts the knowledge base's files on its own subjects; it may not read or remove any.
    const kbFiles = rigPermissions("rig-a").publish.allow.filter((x) => x.includes("KB_FILES"));
    assert.deepEqual(kbFiles, [], "no call of the JetStream API on the KB_FILES stream");
    // It makes no consumer and removes none: control makes the two it reads, with their settings.
    // It reads its own keys' latest values by their subjects, and publishes to none of them,
    // which only control writes.
    const allow = rigPermissions("rig-a").publish.allow;
    assert.ok(!allow.some((x) => /\.CONSUMER\.(CREATE|DURABLE\.CREATE|DELETE)\b/.test(x)));
    assert.ok(allow[2]?.endsWith(`.${commandConsumerName("rig-a")}`));
    assert.ok(allow[5]?.endsWith(`.${configConsumerName("rig-a")}`));
    const direct = allow[8]?.replace(/\*$/, "");
    assert.ok(
      configSubjects("rig-a").every((s) => s.startsWith(direct?.split("CONFIG.")[1] ?? "-")),
    );
    assert.ok(!allow.some((x) => x.startsWith("thermite.rig.rig-a.config")));
    assert.equal(rigInboxPrefix("rig-a"), "_INBOX.rig.rig-a");
    // Nothing of one rig's is in another's: no subject of rig-a's is open to rig-b.
    const b = JSON.stringify(rigPermissions("rig-b"));
    assert.ok(!b.includes("rig-a"));
    assert.ok(!/\*(?!")/.test(b), "no wildcard but the source of its own live subjects");
    for (const bad of ["rig.a", "rig-a.>", "*", "", "Rig-A"])
      assert.throws(() => rigPermissions(bad), /not a rig's name/, bad);
  });

  test("a rig may publish the live lines of the runs control gives it, the newest 1000", () => {
    const allow = (runs: string[]) => rigPermissions("rig-a", runs).publish.allow;
    assert.deepEqual(allow(["sort-3", "sort-2", "sort-3"]).slice(0, 4), [
      "thermite.rig.rig-a.report",
      "thermite.rig.rig-a.live.*",
      "thermite.run.sort-3.live.*",
      "thermite.run.sort-2.live.*",
    ]);
    // A run named before goal 170 has no subject of its own: its lines go on the rig's.
    assert.deepEqual(allow(["Old.Run"]), allow([]));
    const many = Array.from({ length: 1200 }, (_, i) => `run-${i}`);
    const runs = allow(many).filter((s) => s.startsWith("thermite.run."));
    assert.equal(runs.length, 1000);
    assert.equal(runs[0], "thermite.run.run-0.live.*", "the newest first");
  });

  test("the users file: control may do everything, each rig its own, and a system user reloads", () => {
    const keys = { control: user(), system: user(), a: user(), b: user() };
    const text = usersFile({
      control: keys.control,
      system: keys.system,
      rigs: [
        { rig: "rig-b", key: keys.b },
        { rig: "rig-a", key: keys.a, runs: ["sort-3"] },
      ],
    });
    assert.match(text, /^# The message bus's users, written by Thermite's control/);
    const { accounts, system } = readUsers(text);
    assert.equal(system, SYSTEM_ACCOUNT);
    assert.deepEqual(Object.keys(accounts), [BUS_ACCOUNT, SYSTEM_ACCOUNT]);
    assert.equal(accounts[BUS_ACCOUNT]?.jetstream, "enabled");
    assert.deepEqual(accounts[BUS_ACCOUNT]?.users, [
      { nkey: keys.control, permissions: controlPermissions() },
      { nkey: keys.a, permissions: rigPermissions("rig-a", ["sort-3"]) },
      { nkey: keys.b, permissions: rigPermissions("rig-b") },
    ]);
    assert.deepEqual(accounts[SYSTEM_ACCOUNT]?.users, [
      {
        nkey: keys.system,
        permissions: {
          publish: { allow: ["$SYS.REQ.SERVER.*.RELOAD", "$SYS.REQ.SERVER.*.JSZ"] },
          subscribe: { allow: ["_INBOX.>"] },
        },
      },
    ]);
    assert.equal(reloadSubject("NABC"), "$SYS.REQ.SERVER.NABC.RELOAD");
    assert.equal(jetStreamFiguresSubject("NABC"), "$SYS.REQ.SERVER.NABC.JSZ");
    // With no rig: control's users alone.
    const none = readUsers(usersFile({ control: keys.control, system: keys.system, rigs: [] }));
    assert.deepEqual(none.accounts[BUS_ACCOUNT]?.users, [
      { nkey: keys.control, permissions: controlPermissions() },
    ]);
  });

  test("the backup's user may snapshot and restore the streams kept for good, and nothing else", () => {
    const keys = { control: user(), system: user(), backup: user() };
    const { accounts } = readUsers(usersFile({ ...keys, rigs: [] }));
    assert.deepEqual(accounts[BUS_ACCOUNT]?.users, [
      { nkey: keys.control, permissions: controlPermissions() },
      { nkey: keys.backup, permissions: backupPermissions() },
    ]);
    assert.deepEqual(backupPermissions(), {
      publish: {
        allow: [
          `$JS.API.STREAM.INFO.${EVENT_STREAM}`,
          `$JS.API.STREAM.MSG.GET.${EVENT_STREAM}`,
          `$JS.API.STREAM.SNAPSHOT.${EVENT_STREAM}`,
          `$JS.SNAPSHOT.ACK.${EVENT_STREAM}.>`,
          `$JS.API.STREAM.RESTORE.${EVENT_STREAM}`,
          `$JS.SNAPSHOT.RESTORE.${EVENT_STREAM}.>`,
        ],
      },
      subscribe: { allow: [`${BACKUP_INBOX_PREFIX}.>`] },
    });
    assert.deepEqual(STREAMS_KEPT_FOR_GOOD, [EVENT_STREAM]);
    // No delete, no purge, no publish to a stream's subjects.
    const text = JSON.stringify(backupPermissions());
    for (const word of ["DELETE", "PURGE", "CREATE", "thermite."])
      assert.ok(!text.includes(word), word);
    assert.throws(
      () => usersFile({ ...keys, backup: "UNOTAKEY", rigs: [] }),
      /not a NATS user key/,
    );
  });

  test("control may do everything but delete or purge a stream kept for good", () => {
    // A stream's deny_delete and deny_purge guard its messages; the stream itself is guarded here.
    assert.deepEqual(controlPermissions(), {
      publish: {
        deny: [`$JS.API.STREAM.DELETE.${EVENT_STREAM}`, `$JS.API.STREAM.PURGE.${EVENT_STREAM}`],
      },
    });
    // The reports stream is an inbox: control may make it again, as it does once from one kept
    // for good.
    assert.ok(!JSON.stringify(controlPermissions()).includes(REPORT_STREAM));
    assert.equal(JSON.stringify(controlPermissions()).includes("allow"), false);
  });

  test("a rig has nothing on the events stream, whatever runs it has", () => {
    const text = JSON.stringify(rigPermissions("rig-a", ["sort-3", "sort-2"]));
    assert.ok(!text.includes(EVENT_STREAM));
    for (const p of EVENT_SUBJECTS) {
      const [, of, , kind] = p.split(".");
      for (const name of ["rig-a", "sort-3"])
        assert.ok(!text.includes(`thermite.${of}.${name}.${kind}`), `${of} ${name} ${kind}`);
    }
  });

  test("a key that is not a user key never reaches the file", () => {
    const good = { control: user(), system: user(), rigs: [] };
    for (const bad of [
      { ...good, control: "UNOTAKEY" },
      { ...good, system: createAccount().getPublicKey() },
      { ...good, rigs: [{ rig: "rig-a", key: "U" }] },
    ])
      assert.throws(() => usersFile(bad), /^Error: not a NATS user key for the bus's users file$/);
    assert.throws(
      () => usersFile({ ...good, rigs: [{ rig: "rig.a", key: user() }] }),
      /not a rig's name/,
    );
  });
});
