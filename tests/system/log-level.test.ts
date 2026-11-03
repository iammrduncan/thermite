import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { logLevel, startLogging } from "../../src/common/log.ts";
import { onLogLevelTaken } from "../../src/supervisor/log-level.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

/** The lines written while `fn` runs, as objects; nothing reaches the test's output. */
async function linesOf(t: TestContext, fn: () => unknown) {
  const lines: Record<string, unknown>[] = [];
  t.mock.method(process.stdout, "write", (chunk: string) => {
    lines.push(JSON.parse(chunk) as Record<string, unknown>);
    return true;
  });
  try {
    await fn();
  } finally {
    t.mock.restoreAll();
  }
  return lines;
}

test("a signed log_level changes the harness's level or leaves it to the supervisor, and only the owner's issuers send one (the guide's question 16)", async (t) => {
  const env = makeHarnessEnv();
  startLogging("harness", {});
  const harness = env.sign("log_level", { part: "harness", level: "debug" });
  let out: Awaited<ReturnType<typeof env.service.applyCommand>> | undefined;
  const said = await linesOf(t, async () => {
    out = await env.service.applyCommand(harness);
  });
  assert.ok(out?.status === "applied" && out.accepted, JSON.stringify(out));
  assert.deepEqual(out.result, {
    part: "harness",
    level: "debug",
    was: "info",
    lasts:
      "until another log_level command changes it, or the part restarts: then it writes at its THERMITE_LOG_LEVEL again",
  });
  assert.equal(logLevel(), "debug");
  const line = said.find((l) => l.msg === "log level now debug");
  assert.deepEqual(
    [line?.component, line?.by, line?.command],
    ["harness", "control:owner", harness.envelope.id],
  );

  // The supervisor's: the harness takes it and leaves its own level as it is.
  const supervisor = env.sign("log_level", { part: "supervisor", level: "warn" });
  const left = await env.service.applyCommand(supervisor);
  assert.ok(left.status === "applied" && left.accepted);
  assert.deepEqual(left.result, { part: "supervisor", level: "warn", left_to: "the supervisor" });
  assert.equal(logLevel(), "debug");
  // The supervisor, once its harness took it, sets its own; a harness's command is not its own.
  await linesOf(t, () => {
    assert.equal(onLogLevelTaken(harness), false);
    assert.equal(onLogLevelTaken(supervisor), true);
  });
  assert.equal(logLevel(), "warn", "in this process, the supervisor's set it");

  // null: back to THERMITE_LOG_LEVEL's.
  await linesOf(t, () =>
    env.service.applyCommand(env.sign("log_level", { part: "harness", level: null })),
  );
  assert.equal(logLevel(), "info");

  // An agent's token never changes a level; an operator acts for the owner.
  const agent = await env.service.applyCommand(
    env.sign("log_level", { part: "harness", level: "debug" }, { issuedBy: "agent:mcp" }),
  );
  assert.ok(agent.status === "applied" && !agent.accepted);
  assert.deepEqual(agent.result, { error: "log_level is the owner's to issue, not agent:mcp's" });
  assert.equal(logLevel(), "info");
  const bad = await env.service.applyCommand(
    env.sign("log_level", { part: "broker", level: "debug" }),
  );
  assert.equal(bad.status, "rejected");
  await linesOf(t, () =>
    env.service.applyCommand(
      env.sign("log_level", { part: "harness", level: "error" }, { issuedBy: "owner:operator" }),
    ),
  );
  assert.equal(logLevel(), "error");
  for (const l of process.listeners("SIGUSR2")) process.removeListener("SIGUSR2", l);
});
