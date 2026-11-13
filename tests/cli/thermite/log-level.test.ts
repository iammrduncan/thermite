import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { ADMIN, controlOnly } from "../../helpers/control-stack.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");

test("thermite log-level reads and sets control's level, sends a rig part's, and refuses in words (the guide's question 16)", async () => {
  const { control: api, store } = await controlOnly({ tokens: { admin: ADMIN, rigs: {} } });
  await store.reportedRigs.addUnreported("rig-a", new Date().toISOString());
  const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((r) => server.once("listening", r));
  const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = join(mkdtempSync(join(tmpdir(), "thermite-cli-log-level-")), "owner-token");
  writeFileSync(token, `${ADMIN}\n`, { mode: 0o600 });
  const cli = async (...args: string[]) => {
    const out = await run(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      CLI,
      "log-level",
      ...args,
      "--control",
      control,
      "--token-file",
      token,
    ]);
    return JSON.parse(out.stdout) as Record<string, unknown>;
  };
  const refused = (args: string[], words: RegExp) =>
    assert.rejects(cli(...args), (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", words);
      return true;
    });
  try {
    assert.equal((await cli()).from, "environment");
    const set = await cli("control", "warn");
    assert.deepEqual([set.level, set.from, set.set_by], ["warn", "setting", "owner:api"]);
    assert.equal((await cli("control")).level, "warn");
    assert.equal((await cli("control", "default")).from, "environment");
    const sent = await cli("supervisor", "debug", "--rig", "rig-a", "--ttl", "30");
    assert.equal(sent.status, "pending");
    const issued = (await store.commands.get(String(sent.id))) as unknown as {
      kind: string;
      payload: unknown;
    };
    assert.deepEqual(
      (await store.auditLog.list(5, { action: "log_level_sent" })).map((e) => e.body),
      [{ command: sent.id, rig: "rig-a", part: "supervisor", level: "debug" }],
    );
    assert.ok(issued, "the command is pending on control");
    await refused(
      ["broker", "debug"],
      /log-level takes control, harness, supervisor, not "broker"/,
    );
    await refused(
      ["harness", "loud"],
      /log-level takes a level, debug, info, warn, error, default, not "loud"/,
    );
    await refused(["harness", "debug"], /log-level harness takes --rig/);
    await refused(["harness"], /log-level harness takes a level/);
    await refused(
      ["control", "debug", "--rig", "rig-a"],
      /log-level control takes no --rig or --ttl/,
    );
  } finally {
    server.close();
  }
});
