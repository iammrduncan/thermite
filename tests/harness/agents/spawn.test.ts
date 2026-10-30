import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
