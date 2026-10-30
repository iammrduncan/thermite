import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { localEnroll } from "../../src/cli/local-enroll.ts";
import { controlClient } from "../../src/common/api/control.ts";
import { ADMIN, controlOnly } from "../helpers/control-stack.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../src/cli/thermite/main.ts");

/** A control with no rig enrolled, the enroll step's client of it, and its rig's token file. */
function stack() {
  const c = controlOnly({ tokens: { rigs: {} } });
  const client = controlClient({
    url: "http://control:8800",
    token: ADMIN,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      return await c.control.request(`${url.pathname}${url.search}`, init);
    },
  });
  const tokenFile = join(mkdtempSync(join(tmpdir(), "thermite-enroll-")), "control-rig-token");
  writeFileSync(tokenFile, "", { mode: 0o644 });
  const said: string[] = [];
  const enroll = (o: { control?: typeof client } = {}) =>
    localEnroll({
      control: o.control ?? client,
      rig: "local-1",
      tokenFile,
      say: (l) => said.push(l),
    });
  const held = () => readFileSync(tokenFile, "utf8").trim();
  return { ...c, client, tokenFile, said, enroll, held };
}

describe("thermite local enroll: the compose stack's enroll step", () => {
  test("enrolls the rig once; a later up keeps its token; control keeps only the hash", async () => {
    const s = stack();
    assert.equal(await s.enroll(), "enrolled");
    const token = s.held();
    assert.ok(token.length >= 32);
    assert.ok(s.store.enrollments.tokenMatches("local-1", token));
    assert.ok(!JSON.stringify(s.store.db.prepare("select * from rig_token").all()).includes(token));
    // Written in place, the file the supervisor's container mounts, readable by its user.
    assert.equal(statSync(s.tokenFile).mode & 0o777, 0o644 & ~process.umask());
    // A second `up`, and a third: the token stays, and control enrolls nothing again.
    assert.equal(await s.enroll(), "kept");
    assert.equal(await s.enroll(), "kept");
    assert.equal(s.held(), token);
    assert.equal(s.store.auditLog.list(50, { action: "rig_enrolled" }).length, 1);
    assert.deepEqual(s.said, [
      "local-1 enrolled with control",
      "local-1 is enrolled with control: its token is kept",
      "local-1 is enrolled with control: its token is kept",
    ]);
  });

  test("a token file emptied gets a new token; a control whose state is gone enrolls the rig again", async () => {
    const s = stack();
    await s.enroll();
    const first = s.held();
    writeFileSync(s.tokenFile, "");
    assert.equal(await s.enroll(), "replaced");
    const second = s.held();
    assert.notEqual(second, first);
    assert.ok(s.store.enrollments.tokenMatches("local-1", second));
    assert.ok(!s.store.enrollments.tokenMatches("local-1", first));
    // A new control (its volume removed): the token in the file is not one it made.
    const fresh = stack();
    writeFileSync(fresh.tokenFile, `${second}\n`);
    assert.equal(await fresh.enroll(), "enrolled");
    assert.notEqual(fresh.held(), second);
    assert.ok(fresh.store.enrollments.tokenMatches("local-1", fresh.held()));
  });

  test("a rig the owner retired is left retired; brought back, it is enrolled again", async () => {
    const s = stack();
    await s.enroll();
    const token = s.held();
    s.store.retired.add("local-1", "owner:ui");
    assert.equal(await s.enroll(), "retired");
    assert.equal(s.held(), token);
    assert.equal(s.store.enrollments.rig("local-1"), undefined, "still retired");
    assert.match(String(s.said.at(-1)), /^local-1 is retired in control: it is not enrolled again/);
    // Brought back by the owner, its token stays ended: the next up enrolls it again.
    s.store.retired.bringBack("local-1", "owner:ui");
    assert.equal(await s.enroll(), "enrolled");
    assert.notEqual(s.held(), token);
    assert.ok(s.store.enrollments.tokenMatches("local-1", s.held()));
  });

  test("it waits for control while control starts, and gives up after its wait, in words", async () => {
    const s = stack();
    let asked = 0;
    const starting = controlClient({
      url: "http://control:8800",
      token: ADMIN,
      fetchImpl: async (input, init) => {
        asked++;
        if (asked === 1) throw new Error("connection refused");
        if (asked === 2) return Response.json({ error: "starting" }, { status: 503 });
        const url = new URL(String(input));
        return await s.control.request(`${url.pathname}${url.search}`, init);
      },
    });
    const waits: number[] = [];
    const enrolled = await localEnroll({
      control: starting,
      rig: "local-1",
      tokenFile: s.tokenFile,
      say: () => {},
      sleep: async (ms) => void waits.push(ms),
    });
    assert.equal(enrolled, "enrolled");
    assert.deepEqual(waits, [2000, 2000]);
    // Never up: the step fails once its wait is over, and the supervisor does not start.
    const down = controlClient({
      url: "http://control:8800",
      token: ADMIN,
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    await assert.rejects(
      localEnroll({
        control: down,
        rig: "local-1",
        tokenFile: s.tokenFile,
        say: () => {},
        waitMs: 0,
      }),
      /connection refused/,
    );
    // A wrong owner's token is not waited on.
    const wrong = controlClient({
      url: "http://control:8800",
      token: "not-the-owner",
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        return await s.control.request(`${url.pathname}${url.search}`, init);
      },
    });
    const t0 = Date.now();
    await assert.rejects(
      localEnroll({ control: wrong, rig: "local-1", tokenFile: s.tokenFile, say: () => {} }),
      (err: { status?: number }) => err.status === 401,
    );
    assert.ok(Date.now() - t0 < 5_000);
  });

  test("the command enrolls the rig into the file it names and prints no token", async () => {
    const s = stack();
    const server = serve({ fetch: s.control.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const owner = join(mkdtempSync(join(tmpdir(), "thermite-owner-")), "control-admin-token");
      writeFileSync(owner, `${ADMIN}\n`, { mode: 0o600 });
      const cli = (...args: string[]) =>
        run(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args]);
      const args = ["--control", url, "--token-file", owner, "--out", s.tokenFile];
      const first = await cli("local", "enroll", "local-1", ...args);
      assert.equal(first.stdout, "local enroll: local-1 enrolled with control\n");
      assert.ok(s.store.enrollments.tokenMatches("local-1", s.held()));
      assert.ok(!first.stdout.includes(s.held()));
      const again = await cli("local", "enroll", "local-1", ...args);
      assert.equal(
        again.stdout,
        "local enroll: local-1 is enrolled with control: its token is kept\n",
      );
      await assert.rejects(
        cli("local", "enroll", "local-1"),
        (e: { code?: number }) => e.code === 2,
      );
    } finally {
      server.close();
    }
  });
});
