import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { parseContract } from "../../../src/core/contract.ts";
import { controlOnly } from "../../helpers/control-stack.ts";
import { enrollRigs } from "../../helpers/control-store.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");
const TOKENS = { admin: "owner-token-abcdef", rigs: {} };

/** Runs the command line; a refusal comes back with its exit code instead of throwing. */
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

describe("thermite campaign additions (goal 166)", () => {
  test("sets the owner's additions to a campaign's roles from files, removes them, and says its refusals", async () => {
    const { keys, store, control: api } = controlOnly({ tokens: TOKENS });
    const goal = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../../examples/contracts/goal-example.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const contract = parseContract({ ...goal, campaign: "sort-speed" });
    assert.ok(contract.ok);
    enrollRigs(store, ["rig-a"]);
    issueCommand(store, keys.privateKeyPem, {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: {
        run: "sort-speed-1",
        contract: contract.contract,
        contract_sha: contract.sha,
        imports: [],
      },
      issuedBy: "owner:api",
    });
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), "thermite-campaign-additions-"));
      const owner = join(dir, "owner-token");
      writeFileSync(owner, "owner-token-abcdef\n", { mode: 0o600 });
      const worker = join(dir, "worker.md");
      writeFileSync(worker, "Keep each change small.\n");
      const at = ["--control", control, "--token-file", owner];
      const set = await cli(
        "campaign",
        "additions",
        "sort-speed",
        "--add",
        `worker=${worker}`,
        ...at,
      );
      assert.equal(set.code, 0, set.stderr);
      const out = JSON.parse(set.stdout) as { version: number; role_additions: unknown };
      assert.equal(out.version, 2);
      assert.deepEqual(out.role_additions, { worker: "Keep each change small." });
      assert.match(set.stderr, /^Version 2 of sort-speed is saved, with additions for worker\./);
      // Without --add: removed.
      const none = await cli("campaign", "additions", "sort-speed", ...at);
      assert.equal(none.code, 0, none.stderr);
      assert.equal((JSON.parse(none.stdout) as { role_additions: unknown }).role_additions, null);
      // Refusals: a role the mode never runs (control), a word without =, a file that is not there.
      const wrong = await cli(
        "campaign",
        "additions",
        "sort-speed",
        "--add",
        `synthesizer=${worker}`,
        ...at,
      );
      assert.equal(wrong.code, 2);
      assert.match(wrong.stderr, /-> 400 .*it runs no synthesizer/);
      const shape = await cli("campaign", "additions", "sort-speed", "--add", "worker", ...at);
      assert.equal(shape.code, 2);
      assert.match(shape.stderr, /--add takes ROLE=FILE/);
      const missing = await cli(
        "campaign",
        "additions",
        "sort-speed",
        "--add",
        `worker=${join(dir, "nope.md")}`,
        ...at,
      );
      assert.equal(missing.code, 2);
      assert.match(missing.stderr, /--add worker: .*nope\.md can't be read/);
      const noControl = await cli("campaign", "additions", "sort-speed");
      assert.equal(noControl.code, 2);
      assert.match(noControl.stderr, /give --control and --token-file: control keeps the campaign/);
    } finally {
      server.close();
    }
  });
});
