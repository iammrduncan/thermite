import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiConsole } from "../../../src/agents/pi-view/index.ts";
import { spawnTrial } from "../../../src/harness/agents/spawn.ts";
import type { Runner, RunOutcome } from "../../../src/harness/broker/index.ts";

/** A runner whose worker process prints `stdout`: what a worker running as `agent-N` could print. */
function printing(stdout: string): Runner {
  return {
    separated: true,
    run: async () => ({ stdout, stderr: "", exitCode: 0 }) as unknown as RunOutcome,
    handOver: async () => {},
    reclaim: async () => {},
    remove: async () => {},
    killRole: async () => 0,
    runPair: async () => {
      throw new Error("not in this test");
    },
  };
}

const trial = {
  kind: "code" as const,
  spec: {
    trialId: "t-0123456789abcdef",
    run: "r",
    lane: "lane-1" as const,
    workspace: "/nowhere",
    parentCommit: "c".repeat(40),
    editablePaths: [],
    brief: "",
  },
};

const run = (stdout: string) =>
  spawnTrial(trial, printing(stdout), mkdtempSync(join(tmpdir(), "thermite-spawn-")), 9);

test("a worker's result is read through its schema: what it is, and nothing else", async () => {
  const good = {
    submitted: { attempt: "a-0123456789abcdef", lifecycle: "queued", violations: [] },
    stopped: "submitted",
    turns: 3,
    toolCalls: 5,
    tokensIn: 100,
    tokensOut: 20,
    errorKind: "rate_limit",
    failing: { since: "2026-10-30T00:00:00.000Z", kind: "server", words: "503" },
  };
  assert.deepEqual(await run(`some output\n${JSON.stringify(good)}`), good);

  // A kind of error the harness does not know, a count that is not one, a stop that is not a
  // stop, a field of the wrong type: the trial ended with an error, in words, and none of it.
  for (const bad of [
    { ...good, errorKind: "anything" },
    { ...good, turns: -1 },
    { ...good, tokensIn: "lots" },
    { ...good, stopped: "won" },
    { ...good, submitted: { attempt: 7 } },
    "not an object",
  ]) {
    const r = await run(JSON.stringify(bad));
    assert.equal(r.stopped, "error", JSON.stringify(bad));
    assert.equal(r.submitted, undefined);
    assert.equal(r.errorKind, undefined);
    assert.equal(r.turns, 0);
    assert.match(r.error ?? "", /^worker process gave a result that is not a trial's: /);
  }
  const none = await run("no JSON here");
  assert.equal(none.stopped, "error");
  assert.match(none.error ?? "", /^worker process gave no result \(0\)/);
});

test("the trials' folder may be passed through, never listed; each trial's folder is its worker's alone", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "thermite-spawn-"));
  // Made before with the old mode: set again.
  mkdirSync(join(scratch, "agents"), { mode: 0o700 });
  const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
  await spawnTrial(trial, printing("{}"), scratch, 9);
  assert.equal(mode(join(scratch, "agents")), "711");
  assert.equal(mode(join(scratch, "agents", trial.spec.trialId)), "700");
});

test("a worker in Pi whose terminal can't start ends its trial with why, and the harness's log says so", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "thermite-spawn-"));
  const said: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  // The harness's log lines are kept; anything else (the test runner's own) goes on as it came.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    if (String(chunk).startsWith('{"at":')) said.push(String(chunk));
    else write(chunk, ...rest);
    return true;
  }) as typeof process.stdout.write;
  let r: Awaited<ReturnType<typeof spawnTrial>>;
  try {
    // The host's run ends at once, with none of its lines: as a host that could not run.
    r = await spawnTrial(
      trial,
      printing('{"level":"error","msg":"the host could not run","error":"listen EACCES"}'),
      scratch,
      9,
      undefined,
      undefined,
      new PiConsole(),
    );
  } finally {
    process.stdout.write = write;
  }
  assert.equal(r.stopped, "error");
  assert.match(
    r.error ?? "",
    /^worker process could not start in its terminal: the terminal host could not run \(exit 0\): listen EACCES/,
  );
  const line = said.map((l) => JSON.parse(l)).find((l) => l.msg?.includes("could not start"));
  assert.equal(line?.level, "warn");
  assert.equal(line?.trial, trial.spec.trialId);
  assert.match(line?.error ?? "", /listen EACCES/);
  assert.equal((statSync(join(scratch, "agents")).mode & 0o777).toString(8), "711");
});
