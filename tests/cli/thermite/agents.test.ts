import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { promptRecord } from "../../../src/agents/prompt.ts";
import { ROLES, renderAuditor } from "../../../src/agents/roles/index.ts";
import { promptEventBody, sha256 } from "../../../src/core/prompts.ts";
import { controlOnly } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");
const OWNER = "owner-token-abcdef";

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

test("thermite agents list and show: the roles, and the prompt a run's role was sent (goal 166)", async () => {
  const { store, control: api } = controlOnly({ tokens: { admin: OWNER, rigs: {} } });
  // The auditor's prompt for an audit of r-1, as its rig's event gives it to control.
  const sent = renderAuditor(
    { pkg: { diff: "the diff to audit" } },
    { program: "pi", mcpServers: [] },
  );
  const fixed = new Set(ROLES.flatMap((r) => r.texts.map((t) => sha256(t.text))));
  const at = (i: number) => new Date(Date.parse("2026-10-28T10:00:00Z") + i * 1000).toISOString();
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "l-1",
    cursor: 0,
    next: 2,
    events: [
      {
        id: 1,
        at: at(0),
        actor: "harness",
        kind: "run_created",
        subject: "r-1",
        body: { campaign: "c", mode: "hill_climb", agents: true },
        run: "r-1",
      },
      {
        id: 2,
        at: at(1),
        actor: "supervisor",
        kind: "agent_prompt",
        subject: "r-1",
        body: promptEventBody(7, promptRecord(sent, { call: "audit a-1" }), fixed),
        run: "r-1",
      },
    ],
    summary: {},
  });
  const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((r) => server.once("listening", r));
  try {
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const token = join(mkdtempSync(join(tmpdir(), "thermite-agents-")), "owner");
    writeFileSync(token, `${OWNER}\n`, { mode: 0o600 });
    const on = ["--control", control, "--token-file", token];
    const list = await cli("agents", "list", ...on);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /^worker\s+Worker: /m);
    assert.equal(list.stdout.trim().split("\n").length, 15);
    const role = await cli("agents", "show", "auditor", ...on);
    assert.match(role.stdout, /put together by renderAuditor/);
    assert.match(role.stdout, /# system: its instructions\nYou audit a candidate change/);
    const shown = await cli("agents", "show", "auditor", "--run", "r-1", ...on);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^prompt 7 of r-1 on rig-a: auditor in pi, audit a-1/);
    assert.match(shown.stdout, /# system · system · from role \(the role's definition\)/);
    assert.match(
      shown.stdout,
      /# message · package · from package · \d+ characters\nAudit package \(untrusted data\):/,
    );
    const sources = await cli("agents", "show", "auditor", "--run", "r-1", "--sections", ...on);
    assert.doesNotMatch(sources.stdout, /Audit package/);
    assert.match(sources.stdout, /^message · package · from package/m);
    const none = await cli("agents", "show", "worker", "--run", "r-1", ...on);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /r-1 has sent no worker a prompt yet/);
    assert.equal((await cli("agents", "show", ...on)).code, 2);
  } finally {
    server.close();
  }
});
