import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { logLevel, startLogging } from "../../src/common/log.ts";
import { applyControlLogLevel, controlLogLevelOf } from "../../src/control/log-level.ts";
import { openControlStore } from "../../src/control/store/index.ts";
import { ADMIN, controlOnly, mcpClient } from "../helpers/control-stack.ts";
import { controlStore } from "../helpers/control-store.ts";

/**
 * Log levels from control (the guide's question 16): control's own, a setting it keeps, applied at
 * once and across its restarts, over REST and MCP; and a rig part's, by the signed `log_level`
 * command over REST and MCP's issue_command. Each change is in the audit log.
 */

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  rigs: {},
};

/** The lines a call writes are kept from the test's output. */
function quiet(t: TestContext) {
  t.mock.method(process.stdout, "write", () => true);
}

async function stack(store = controlStore()) {
  const { control } = await controlOnly({ tokens: TOKENS, store });
  await store.reportedRigs.addUnreported("rig-a", new Date().toISOString());
  const rest = async (method: string, path: string, body?: unknown, token = ADMIN) => {
    const r = await control.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const tool = async (token: string, name: string, args: Record<string, unknown>) => {
    const client = await mcpClient(control, token);
    const out = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { error: out.isError === true, text: String(out.content[0]?.text) };
  };
  return { store, control, rest, tool };
}

describe("log levels from control (the guide's question 16)", () => {
  test("control's own: read, set at once over REST and MCP, refused in words, audited", async (t) => {
    startLogging("control", {});
    const s = await stack();
    assert.deepEqual((await s.rest("GET", "/v1/control/log-level")).body, {
      level: "info",
      from: "environment",
      environment: "info",
      now: "info",
      set_by: null,
      set_at: null,
    });
    quiet(t);
    const set = await s.rest("PUT", "/v1/control/log-level", { level: "debug" });
    t.mock.restoreAll();
    assert.equal(set.status, 200);
    assert.deepEqual(
      [set.body.level, set.body.from, set.body.now, set.body.set_by, set.body.said],
      [
        "debug",
        "setting",
        "debug",
        "owner:api",
        "Control writes its log lines at debug and above, from the setting on control.",
      ],
    );
    assert.equal(logLevel(), "debug", "applied at once");
    for (const body of [{ level: "verbose" }, {}, { level: "warn", part: "control" }]) {
      const r = await s.rest("PUT", "/v1/control/log-level", body);
      assert.equal(r.status, 400);
      assert.match(String(r.body.error), /^bad request: (level|body): /);
    }
    // MCP: the operator reads it and may not set it; the owner sets it, null back to the
    // environment's.
    const read = await s.tool(TOKENS.operator, "control_log_level", {});
    assert.equal(JSON.parse(read.text).level, "debug");
    const client = await mcpClient(s.control, TOKENS.operator);
    assert.ok(!(await client.listTools()).tools.some((x) => x.name === "set_control_log_level"));
    quiet(t);
    const back = await s.tool(ADMIN, "set_control_log_level", { level: null });
    t.mock.restoreAll();
    assert.deepEqual(
      [JSON.parse(back.text).level, JSON.parse(back.text).from],
      ["info", "environment"],
    );
    assert.equal(logLevel(), "info");
    assert.deepEqual(
      (await s.store.auditLog.list(20, { action: "control_log_level_set" })).map((e) => [
        e.actor,
        e.body,
      ]),
      [
        ["owner:mcp", { level: null, was: "debug" }],
        ["owner:api", { level: "debug", was: "info" }],
      ],
    );
  });

  test("control's own level stays across its restarts, over THERMITE_LOG_LEVEL", async (t) => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-log-level-")), "control.db");
    startLogging("control", {});
    const s = await stack(controlStore(path));
    quiet(t);
    await s.rest("PUT", "/v1/control/log-level", { level: "warn" });
    t.mock.restoreAll();
    await s.store.close();
    // A restart: the environment's level first, then the one the owner set.
    startLogging("control", { THERMITE_LOG_LEVEL: "error" });
    assert.equal(logLevel(), "error");
    const again = openControlStore(path);
    quiet(t);
    await applyControlLogLevel(again);
    t.mock.restoreAll();
    assert.equal(logLevel(), "warn");
    assert.deepEqual(
      [(await controlLogLevelOf(again)).level, (await controlLogLevelOf(again)).environment],
      ["warn", "error"],
    );
    await again.close();
    for (const l of process.listeners("SIGUSR2")) process.removeListener("SIGUSR2", l);
  });

  test("a rig part's level goes as a signed log_level command, from the owner's and the operator's tokens, and the audit log says which", async () => {
    const s = await stack();
    const sent = await s.rest("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "log_level",
      payload: { part: "supervisor", level: "debug" },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const op = await s.tool(TOKENS.operator, "issue_command", {
      rig: "rig-a",
      kind: "log_level",
      payload: { part: "harness", level: null },
    });
    assert.equal(op.error, false, op.text);
    // An agent's token has no log_level among its kinds.
    const agent = await s.tool(TOKENS.agent, "issue_command", {
      rig: "rig-a",
      kind: "log_level",
      payload: { part: "harness", level: "debug" },
    });
    assert.equal(agent.error, true);
    assert.match(agent.text, /Input validation error/);
    // A part that is not a rig's is refused before it is signed.
    const bad = await s.rest("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "log_level",
      payload: { part: "control", level: "debug" },
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(
      (await s.store.auditLog.list(20, { action: "log_level_sent" })).map((e) => [
        e.actor,
        (e.body as { part: string }).part,
        (e.body as { level: unknown }).level,
      ]),
      [
        ["owner:operator", "harness", null],
        ["owner:api", "supervisor", "debug"],
      ],
    );
    const first = (await s.store.auditLog.list(20, { action: "log_level_sent" }))[1];
    assert.equal((first?.body as { command?: string } | undefined)?.command, sent.body.id);
  });
});
