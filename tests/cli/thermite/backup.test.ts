import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { backupControl } from "../../../src/common/backup/index.ts";
import { CONTROL_STATE } from "../../../src/core/backup.ts";
import { EVENT_STREAM_CONFIG } from "../../../src/core/link/events.ts";
import { FakeBackupBus } from "../../helpers/fake-backup-bus.ts";
import { FakeBus } from "../../helpers/fake-bus.ts";

/**
 * thermite backup and thermite restore look at the bus before anything else (goal 173): a backup
 * with the bus away writes nothing, not a `.partial` folder that stops on the bus's address, and
 * says to start it; a restore through the bus says the same; a restore that sets the bus's store
 * aside refuses while the bus answers.
 */

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");
const fresh = (name: string) => mkdtempSync(join(tmpdir(), `thermite-${name}-`));

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      CLI,
      ...args,
    ]);
    return { code: 0, ...r };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

/** A server on a port of its own, listening. */
async function listening(): Promise<Server> {
  const server = createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

/** A port nothing answers at: one a server listened on, closed. */
async function closedPort(): Promise<number> {
  const server = await listening();
  const { port } = server.address() as AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

/** Control's state folder as a backup reads it: its store and the backup's key on the bus. */
function controlState(): string {
  const dir = fresh("control");
  writeFileSync(join(dir, CONTROL_STATE.db), "");
  writeFileSync(join(dir, CONTROL_STATE.busBackupSeed), "SUAEXAMPLE\n");
  return dir;
}

/** A whole backup of a control, made on a fake bus. */
async function wholeBackup(): Promise<string> {
  const bus = new FakeBus();
  await bus.makeStream(EVENT_STREAM_CONFIG);
  const made = await backupControl({
    stateDir: controlState(),
    into: fresh("backups"),
    bus: new FakeBackupBus(bus),
    build: { version: "0.2.4", commit: null },
  });
  return made.folder;
}

test("a backup with the bus away writes nothing and says to start the bus", async () => {
  const state = controlState();
  const into = fresh("backups");
  const port = await closedPort();
  const r = await cli("backup", into, "--state", state, "--bus", `nats://127.0.0.1:${port}`);
  assert.equal(r.code, 2);
  assert.equal(
    r.stderr,
    `the bus does not answer at 127.0.0.1:${port}: start it, then run this again\n`,
  );
  assert.deepEqual(readdirSync(into), [], "no .partial folder");
});

test("a restore through the bus with the bus away is refused, with control's state unchanged", async () => {
  const backup = await wholeBackup();
  const state = controlState();
  const port = await closedPort();
  const r = await cli("restore", backup, "--state", state, "--bus", `nats://127.0.0.1:${port}`);
  assert.equal(r.code, 1);
  assert.equal(
    r.stderr,
    `restore refused: the bus does not answer at 127.0.0.1:${port}: start it first, with room for the restore\n`,
  );
  assert.deepEqual(readdirSync(state).sort(), [CONTROL_STATE.busBackupSeed, CONTROL_STATE.db]);
});

test("a restore that sets the bus's store aside is refused while the bus answers", async (t) => {
  const state = controlState();
  const store = join(fresh("bus"), "store");
  mkdirSync(store);
  writeFileSync(join(store, "kept"), "");
  const server = await listening();
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const r = await cli(
    "restore",
    await wholeBackup(),
    "--state",
    state,
    "--bus",
    `nats://127.0.0.1:${port}`,
    "--bus-store",
    store,
  );
  assert.equal(r.code, 1);
  assert.equal(
    r.stderr,
    `restore refused: the bus answers at 127.0.0.1:${port}: stop it first, then set its store aside\n`,
  );
  assert.deepEqual(readdirSync(store), ["kept"], "the store is where it was");
});
