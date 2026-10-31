// The advisors' runner as the agent runtimes' runner (AdvisorRoleRunner), against a real run-as
// helper that keeps no run apart (not root: every run is the test's own user), as the other
// supervisor tests run it. Only the images' acceptance checks run it as root, with advisor users.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { RunAsClient, RunAsServer } from "../../../src/common/run-as/index.ts";
import { AdvisorRoleRunner } from "../../../src/supervisor/advisor-runs/index.ts";

// Short: a socket's path is at most 104 bytes on some systems.
const top = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "ar-"));
after(() => rmSync(top, { recursive: true, force: true }));
const root = join(top, "runs");
mkdirSync(root);
const socket = join(top, "runs.sock");
const server = new RunAsServer({ socketPath: socket, root, callerGid: process.getgid?.() ?? 0 });
server.listen();
await new Promise((r) => server.server.once("listening", r));
after(() => server.server.close());
const runner = new AdvisorRoleRunner({ client: new RunAsClient(socket), root });

const folder = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
};

test("a run: its command in its folder, with its environment and input; its exit and output", async () => {
  const dir = folder("one");
  const r = await runner.run({
    role: "advisor-auditor-r-1",
    argv: ["sh", "-c", 'cat; printf " %s %s" "$A" "$(basename "$PWD")"; exit 3'],
    cwd: dir,
    env: { A: "set" },
    stdin: "in",
  });
  assert.deepEqual([r.exitCode, r.signal, r.killedFor, r.stdout], [3, null, null, "in set one"]);
  await runner.remove(dir);
  assert.equal(existsSync(dir), false);
});

test("a run the helper refuses resolves with why, as the broker's runs do", async () => {
  const r = await runner.run({ role: "x", argv: ["true"], cwd: top });
  assert.equal(r.exitCode, null);
  assert.match(r.stderr, /a run's folder is one of/);
});

test("killRole ends that role's runs only; its folder is removed once the helper lets it go", async () => {
  const dir = folder("two");
  const other = folder("three");
  const long = runner.run({ role: "advisor-a", argv: ["sleep", "30"], cwd: dir });
  const kept = runner.run({
    role: "advisor-b",
    argv: ["sh", "-c", "sleep 0.5; echo b"],
    cwd: other,
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await runner.killRole("advisor-a"), 1);
  const stopped = await long;
  assert.equal(stopped.exitCode, null);
  assert.equal(stopped.signal, "SIGKILL");
  assert.equal((await kept).stdout, "b\n");
  assert.equal(await runner.killRole("advisor-a"), 0);
  writeFileSync(join(dir, "left"), "x");
  await runner.remove(dir);
  assert.equal(existsSync(dir), false);
  await runner.remove(other);
});
