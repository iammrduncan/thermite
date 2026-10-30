import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { RunAsClient, RunAsServer } from "../../../src/common/run-as/index.ts";
import { ADVISOR_RUNS_ENV } from "../../../src/core/advisor-runs.ts";
import { isFailure } from "../../../src/harness/selftest/index.ts";
import { advisorProbes, probeAdvisorUsers } from "../../../src/supervisor/advisor-runs/index.ts";

/**
 * The supervisor's part of the isolation check. As the test's own user the runner keeps no run
 * apart, so every probe of the supervisor's own files gets through: what the check must then show.
 * As root on Linux, with the image's users, the same probes are refused (the rig image and compose
 * acceptance checks run it there).
 */

function supervisorTree() {
  const base = mkdtempSync(join(tmpdir(), "thermite-advisor-probe-"));
  after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "state");
  const inbox = join(base, "inbox");
  const runs = join(base, "runs");
  const etc = join(base, "advisors");
  for (const d of [home, join(inbox, "repos"), runs, etc]) mkdirSync(d, { recursive: true });
  chmodSync(runs, 0o711);
  writeFileSync(join(home, "bus-key.seed"), "a seed");
  writeFileSync(join(home, "relay-state.json"), "{}");
  writeFileSync(join(inbox, "repos", "kit.bundle"), "answers");
  writeFileSync(join(base, "harness-token"), "a token", { mode: 0o600 });
  writeFileSync(join(etc, "teacher.key"), "a key", { mode: 0o600 });
  writeFileSync(
    join(etc, "advisors.json"),
    JSON.stringify({ teachers: [{ name: "t", api_key_file: join(etc, "teacher.key") }] }),
  );
  const env = {
    THERMITE_HARNESS_TOKEN_FILE: join(base, "harness-token"),
    THERMITE_CONTROL_TOKEN_FILE: join(base, "not-there"),
    THERMITE_ADVISORS_FILE: join(etc, "advisors.json"),
    [ADVISOR_RUNS_ENV.socket]: join(base, "runs.sock"),
  };
  return { base, home, inbox, runs, env };
}

describe("what an advisor user must not reach on the supervisor", () => {
  test("the probes name the supervisor's tokens, keys, state, inbox and the advisors file's keys, as far as they exist", () => {
    const t = supervisorTree();
    const probes = advisorProbes({
      env: t.env,
      home: t.home,
      inboxDir: t.inbox,
      runner: { client: new RunAsClient(t.env[ADVISOR_RUNS_ENV.socket] as string), root: t.runs },
      pid: 4242,
    });
    const by = Object.fromEntries(probes.map((p) => [p.name, p]));
    assert.equal(by["state-list"]?.path, t.home);
    assert.equal(by["inbox-list"]?.path, t.inbox);
    assert.equal(by["inbox-read"]?.path, join(t.inbox, "repos", "kit.bundle"));
    assert.equal(by["bus-key"]?.op, "read");
    assert.equal(by["harness-token"]?.path, t.env.THERMITE_HARNESS_TOKEN_FILE);
    // The folder of the supervisor's secret files, never a /run/secrets the platform mounted.
    assert.equal(by[`secrets-list:${t.base}`]?.op, "list");
    assert.equal(
      probes.some((p) => p.path === "/run/secrets"),
      false,
    );
    assert.equal(by["advisor-key-1"]?.path, join(t.base, "advisors", "teacher.key"));
    assert.equal(by["supervisor-signal"]?.path, "4242");
    assert.equal(by["supervisor-environ"]?.path, "/proc/4242/environ");
    assert.equal(by["control-token"], undefined, "a file that is not there is not probed");
    assert.equal(by["seal-key"], undefined);
    // A secret file in the supervisor's state, as in the one-container rig image: its folder is the
    // state, listed once as state-list.
    const inState = advisorProbes({
      env: { THERMITE_HARNESS_TOKEN_FILE: join(t.home, "bus-key.seed") },
      home: t.home,
      inboxDir: t.inbox,
      runner: { client: new RunAsClient(t.env[ADVISOR_RUNS_ENV.socket] as string), root: t.runs },
      pid: 4242,
    });
    assert.deepEqual(
      inState.filter((p) => p.name.startsWith("secrets-list")),
      [],
    );
  });

  test("through a runner that keeps no run apart, the check shows each probe that got through", async () => {
    const t = supervisorTree();
    const socket = t.env[ADVISOR_RUNS_ENV.socket] as string;
    const server = new RunAsServer({
      socketPath: socket,
      root: t.runs,
      callerGid: process.getgid?.() ?? 0,
    });
    server.listen();
    await new Promise((r) => server.server.once("listening", r));
    after(() => server.server.close());
    const runner = { client: new RunAsClient(socket), root: t.runs };
    const r = await probeAdvisorUsers({ env: t.env, home: t.home, inboxDir: t.inbox, runner });
    assert.equal(r.separated, false);
    assert.equal(r.probes["advisor-user"]?.startsWith("ALLOWED"), true);
    assert.equal(r.probes["harness-token"], "ALLOWED");
    assert.equal(r.probes["inbox-read"], "ALLOWED");
    assert.equal(r.probes["supervisor-signal"], "ALLOWED");
    assert.ok(Object.values(r.probes).some(isFailure));
    // Without a runner the supervisor says so, as a failure.
    const none = await probeAdvisorUsers({ ...t, inboxDir: t.inbox, runner: undefined });
    assert.equal(none.separated, false);
    assert.ok(Object.values(none.probes).every(isFailure));
  });
});
