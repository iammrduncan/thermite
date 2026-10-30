import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { RunAsClient, RunAsServer } from "../../src/common/run-as/index.ts";
import { ADVISOR_USERS } from "../../src/core/advisor-runs.ts";

/** A helper on a socket of its own, its root, and a client. */
async function helper(separate?: boolean, wrap?: string[]) {
  const base = mkdtempSync(join(tmpdir(), "thermite-run-as-"));
  // Advisor users pass through to their own folders, as through the supervisor's state.
  chmodSync(base, 0o711);
  const root = join(base, "advisors");
  mkdirSync(root, { mode: 0o711 });
  const socketPath = join(base, "s.sock");
  const server = new RunAsServer({
    socketPath,
    root,
    callerGid: process.getgid?.() ?? 0,
    separate,
    wrap,
  }).listen();
  await new Promise((r) => server.once("listening", r));
  after(() => {
    server.close();
    rmSync(base, { recursive: true, force: true });
  });
  const folder = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    return dir;
  };
  return { base, root, socketPath, folder, client: new RunAsClient(socketPath) };
}

/** A program that prints what it was given: its stdin, file descriptor 3, folder and settings. */
const SAY = [
  process.execPath,
  "-e",
  `const fs = require("node:fs");
let token = null;
try { token = fs.readFileSync(3, "utf8"); } catch {}
const stdin = fs.readFileSync(0, "utf8");
console.log(JSON.stringify({ stdin, token, cwd: process.cwd(), home: process.env.HOME,
  tmp: process.env.TMPDIR, route: process.env.ROUTE ?? null, secret: process.env.HELPER_SECRET ?? null,
  uid: process.getuid() }));`,
];

describe("advisor programs as users of their own: the helper's core", () => {
  test("a run gets its prompt, its token, its folder and the settings it is given, and nothing else", async () => {
    process.env.HELPER_SECRET = "the helper's own";
    try {
      const h = await helper();
      const dir = h.folder("call-1");
      const r = await h.client.run({
        dir,
        argv: SAY,
        env: { ROUTE: "http://127.0.0.1:9/v1" },
        stdin: "the prompt",
        token: "a sign-in token",
      });
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(r.timedOut, false);
      const said = JSON.parse(r.stdout) as Record<string, unknown>;
      assert.equal(said.stdin, "the prompt");
      assert.equal(said.token, "a sign-in token");
      assert.equal(said.route, "http://127.0.0.1:9/v1");
      assert.equal(said.secret, null, "nothing of the helper's environment");
      assert.ok(String(said.cwd).endsWith("/call-1"));
      assert.equal(said.home, said.cwd);
      assert.equal(said.tmp, said.cwd);
      // The folder goes once the run is over, with what it left.
      writeFileSync(join(dir, "left.txt"), "x");
      await h.client.remove(dir);
      assert.equal(existsSync(dir), false);
    } finally {
      delete process.env.HELPER_SECRET;
    }
  });

  test("a run past its time ends with everything it started; a stopped call ends its run", async () => {
    const h = await helper();
    const pidFile = join(h.base, "child.pid");
    const r = await h.client.run({
      dir: h.folder("slow"),
      argv: [
        process.execPath,
        "-e",
        `const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setInterval(() => {}, 1000);`,
      ],
      env: {},
      stdin: "",
      timeoutMs: 300,
    });
    assert.equal(r.timedOut, true);
    assert.notEqual(r.exitCode, 0);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const child = Number(await import("node:fs").then((fs) => fs.readFileSync(pidFile, "utf8")));
    assert.equal(alive(child), false, "the program's own child went with it");

    const stop = new AbortController();
    const started = Date.now();
    const call = h.client.run(
      {
        dir: h.folder("stopped"),
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        env: {},
        stdin: "",
      },
      stop.signal,
    );
    setTimeout(() => stop.abort(), 200);
    await assert.rejects(call, /stopped/);
    assert.ok(Date.now() - started < 5000);
  });

  test("refused, in words: a folder outside the root, a link, the root itself, a bad request", async () => {
    const h = await helper();
    const outside = mkdtempSync(join(tmpdir(), "thermite-run-as-out-"));
    after(() => rmSync(outside, { recursive: true, force: true }));
    const run = (dir: string) => h.client.run({ dir, argv: SAY, env: {}, stdin: "" });
    await assert.rejects(run(outside), /a run's folder is one of/);
    await assert.rejects(run(h.root), /a run's folder is one of/);
    const deep = join(h.folder("a"), "b");
    mkdirSync(deep);
    await assert.rejects(run(deep), /a run's folder is one of/);
    const link = join(h.root, "link");
    symlinkSync(outside, link);
    await assert.rejects(run(link), /not a folder/);
    await assert.rejects(h.client.remove(link), /not a folder/);
    assert.ok(existsSync(outside), "a link's target stays");
    await assert.rejects(
      h.client.run({ dir: "relative", argv: SAY, env: {}, stdin: "" }),
      /advisor runs: /,
    );
    await assert.rejects(
      h.client.run({ dir: h.folder("env"), argv: SAY, env: { "BAD NAME": "x" }, stdin: "" }),
      /advisor runs: /,
    );
    // A line that is not a request is refused under its own id, or none.
    const answer = await new Promise<string>((resolve) => {
      const sock = connect(h.socketPath);
      sock.setEncoding("utf8");
      sock.on("data", (d: string) => {
        resolve(d);
        sock.destroy();
      });
      sock.write(`${JSON.stringify({ id: 7, op: "chown", dir: "/" })}\n`);
    });
    assert.equal(JSON.parse(answer).id, 7);
    assert.equal(JSON.parse(answer).ok, false);
  });

  test("a run's program starts under the helper's wrap, with its token still on fd 3", async () => {
    // /usr/bin/env stands in for no_new_privs and the GPU fence: it sets a value, then runs it.
    const h = await helper(undefined, ["/usr/bin/env", "ROUTE=wrapped"]);
    const r = await h.client.run({
      dir: h.folder("wrapped"),
      argv: SAY,
      env: {},
      stdin: "the prompt",
      token: "a sign-in token",
    });
    assert.equal(r.exitCode, 0, r.stderr);
    const said = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(said.route, "wrapped");
    assert.equal(said.token, "a sign-in token");
    assert.equal(said.stdin, "the prompt");
  });

  // Root on Linux: each run is an advisor user, and its folder its own for the run.
  const asRoot = process.getuid?.() === 0 && process.platform === "linux";
  test("as root: a run is an advisor user that owns its folder and reads none of the caller's files", {
    skip: asRoot ? false : "needs root on Linux",
  }, async () => {
    const h = await helper(true);
    // The caller's own file, 0600, beside the root: what an advisor must not read.
    const secret = join(h.base, "token");
    writeFileSync(secret, "the supervisor's token", { mode: 0o600 });
    const dir = h.folder("call");
    writeFileSync(join(dir, "config.toml"), "written by the caller", { mode: 0o600 });
    const r = await h.client.run({
      dir,
      argv: [
        process.execPath,
        "-e",
        `const fs = require("node:fs");
let read = "refused";
try { fs.readFileSync(${JSON.stringify(secret)}); read = "read"; } catch {}
fs.mkdirSync("private", { mode: 0o700 });
fs.writeFileSync("private/rollout.jsonl", "kept", { mode: 0o600 });
console.log(JSON.stringify({ uid: process.getuid(), config: fs.readFileSync("config.toml", "utf8"), read,
  during: fs.statSync(".").uid }));`,
      ],
      env: {},
      stdin: "",
    });
    const said = JSON.parse(r.stdout) as {
      uid: number;
      config: string;
      read: string;
      during: number;
    };
    assert.ok(
      said.uid > ADVISOR_USERS.base && said.uid <= ADVISOR_USERS.base + ADVISOR_USERS.count,
    );
    assert.equal(said.config, "written by the caller");
    assert.equal(said.read, "refused");
    assert.equal(said.during, said.uid, "the folder was the run's user's while it ran");
    // Once it has ended, the folder is the caller's again, a folder the run made private too.
    const me = process.getuid?.();
    assert.equal(statSync(dir).uid, me);
    assert.equal(statSync(dir).mode & 0o7777, 0o2750);
    assert.equal(statSync(join(dir, "private")).uid, me);
    assert.equal(readFileSync(join(dir, "private", "rollout.jsonl"), "utf8"), "kept");
    // A file linked from elsewhere is never handed over.
    const linked = h.folder("linked");
    linkSync(secret, join(linked, "token"));
    await assert.rejects(
      h.client.run({ dir: linked, argv: SAY, env: {}, stdin: "" }),
      /linked from elsewhere/,
    );
    await h.client.remove(dir);
  });
});
