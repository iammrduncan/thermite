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
import { enrollRigs, ingestReport } from "../../helpers/control-store.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");
/** Control's tokens: the owner's, as the token files below hold it, and no rigs. */
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

describe("thermite campaign copy (goal 069)", () => {
  test("copies a campaign through control, and says its refusals", async () => {
    const { keys, store, control: api } = controlOnly({ tokens: TOKENS });
    // sort-speed was assigned over the API before, with a real contract, and the rig ran it.
    enrollRigs(store, ["rig-a"]);
    const goal = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../../examples/contracts/goal-example.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const contract = parseContract({ ...goal, campaign: "sort-speed" });
    assert.ok(contract.ok);
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
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "ledger-rig-a",
      cursor: 0,
      next: 1,
      generated_at: new Date().toISOString(),
      events: [
        {
          id: 1,
          at: "2026-10-21T01:00:00Z",
          actor: "harness",
          kind: "run_created",
          subject: "sort-speed-1",
          body: { campaign: "sort-speed", mode: "goal" },
        },
      ],
      summary: {},
    });
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), "thermite-campaign-copy-"));
      const owner = join(dir, "owner-token");
      writeFileSync(owner, "owner-token-abcdef\n", { mode: 0o600 });
      const at = ["--control", `${control}/`, "--token-file", owner];

      const copied = await cli("campaign", "copy", "sort-speed", "sort-speed-b", ...at);
      assert.equal(copied.code, 0, copied.stderr);
      const [saved] = store.campaigns.versions("sort-speed-b");
      assert.ok(saved);
      assert.deepEqual(JSON.parse(copied.stdout), {
        campaign: "sort-speed-b",
        version: 1,
        contract_sha: saved.sha,
        from: { campaign: "sort-speed", rig: "rig-a", run: "sort-speed-1" },
      });
      assert.equal((saved.contract as { campaign: string }).campaign, "sort-speed-b");
      assert.equal(saved.created_by, "owner:api");
      assert.equal(copied.stderr, "");

      // Control's refusals, in its words.
      const taken = await cli("campaign", "copy", "sort-speed", "sort-speed-b", ...at);
      assert.equal(taken.code, 2);
      assert.match(
        taken.stderr,
        /\/v1\/campaigns\/sort-speed\/copy -> 409 \{"error":"There is a campaign named sort-speed-b already\. Choose another name\."\}/,
      );
      const bad = await cli("campaign", "copy", "sort-speed", "Sort_B", ...at);
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /-> 400 .*A campaign's name is lowercase letters/);
      const unknown = await cli("campaign", "copy", "nope", "nope-b", ...at);
      assert.equal(unknown.code, 2);
      assert.match(
        unknown.stderr,
        /-> 404 .*Control has no saved version or earlier assignment of nope/,
      );
      // --mcp-servers-json: the list goes to control, which keeps a goal campaign's in its kit.
      const list = join(dir, "servers.json");
      writeFileSync(list, JSON.stringify([{ name: "web-search", agents: ["workers"] }]));
      const kit = await cli(
        "campaign",
        "copy",
        "sort-speed",
        "sort-speed-m",
        "--mcp-servers-json",
        list,
        ...at,
      );
      assert.equal(kit.code, 2);
      assert.match(
        kit.stderr,
        /-> 400 \{"error":"This campaign's MCP servers are in its kit's kit\.json: change them on the New campaign page\."\}/,
      );
      writeFileSync(list, "[{");
      const notJson = await cli(
        "campaign",
        "copy",
        "sort-speed",
        "sort-speed-m",
        "--mcp-servers-json",
        list,
        ...at,
      );
      assert.equal(notJson.code, 2);
      assert.match(notJson.stderr, /^--mcp-servers-json: .*servers\.json is not a JSON list: /);
      // The command line's own: before anything is sent.
      const noControl = await cli("campaign", "copy", "sort-speed", "sort-speed-c");
      assert.deepEqual(
        [noControl.code, noControl.stderr.trim()],
        [2, "give --control and --token-file: control copies the campaign"],
      );
      for (const args of [
        ["campaign", "copy", "sort-speed"],
        ["campaign", "copy", "sort-speed", "--control", control],
        ["campaign", "move", "sort-speed", "sort-speed-c"],
      ]) {
        const usage = await cli(...args, ...at);
        assert.equal(usage.code, 2, args.join(" "));
        assert.match(usage.stderr, /^usage: thermite/);
      }
      const extra = await cli(
        "campaign",
        "copy",
        "sort-speed",
        "sort-speed-c",
        "--rig",
        "rig-a",
        ...at,
      );
      assert.equal(extra.code, 2);
      assert.equal(store.campaigns.versions().length, 1, "only the one copy was saved");
    } finally {
      server.close();
    }
  });
});

describe("thermite campaign context, and campaign copy's context options (goal 070)", () => {
  test("sets a campaign's own context settings through control, removes them, and gives a copy its own", async () => {
    const { keys, store, control: api } = controlOnly({ tokens: TOKENS });
    const goal = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../../examples/contracts/goal-example.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const contract = parseContract({ ...goal, campaign: "sort-speed" });
    assert.ok(contract.ok);
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "ledger-rig-a",
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary: {},
    });
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
      const dir = mkdtempSync(join(tmpdir(), "thermite-campaign-context-"));
      const owner = join(dir, "owner-token");
      writeFileSync(owner, "owner-token-abcdef\n", { mode: 0o600 });
      const at = ["--control", control, "--token-file", owner];

      const set = await cli(
        "campaign",
        "context",
        "sort-speed",
        "--context-window",
        "131072",
        "--compact-at",
        "70",
        ...at,
      );
      assert.equal(set.code, 0, set.stderr);
      const out = JSON.parse(set.stdout) as Record<string, unknown>;
      // Its first saved version, newer than the one assigned (version 1).
      assert.equal(out.version, 2);
      assert.deepEqual(out.agents_context, { context_window: 131_072, compact_at: 70 });
      assert.match(
        set.stderr,
        /^Version 2 of sort-speed is saved\. Its runs' agents: a context window of 131,072 tokens, compaction at 70% of the window\./,
      );
      const [v2] = store.campaigns.versions("sort-speed");
      assert.ok(v2);
      assert.deepEqual((v2.contract as Record<string, unknown>).agents_context, {
        context_window: 131_072,
        compact_at: 70,
      });

      // Without either option: removed, in a new version.
      const none = await cli("campaign", "context", "sort-speed", ...at);
      assert.equal(none.code, 0, none.stderr);
      assert.equal((JSON.parse(none.stdout) as { agents_context: unknown }).agents_context, null);
      const v3 = store.campaigns.versions("sort-speed")[0];
      assert.ok(v3);
      assert.equal("agents_context" in (v3.contract as object), false);
      // Refused in words before anything is sent, or by control.
      const bad = await cli("campaign", "context", "sort-speed", "--compact-at", "99", ...at);
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /^--context-window and --compact-at: .*from 50 to 95/);
      const unknown = await cli("campaign", "context", "nope", ...at);
      assert.equal(unknown.code, 2);
      assert.match(unknown.stderr, /-> 404 .*no saved version or earlier assignment of nope/);
      const noControl = await cli("campaign", "context", "sort-speed");
      assert.deepEqual(
        [noControl.code, noControl.stderr.trim()],
        [2, "give --control and --token-file: control keeps the campaign"],
      );
      assert.equal((await cli("campaign", "context", ...at)).code, 2);

      // A copy with its own settings, in place of its source's.
      const copied = await cli(
        "campaign",
        "copy",
        "sort-speed",
        "sort-speed-b",
        "--context-window",
        "65536",
        ...at,
      );
      assert.equal(copied.code, 0, copied.stderr);
      assert.deepEqual((JSON.parse(copied.stdout) as { agents_context: unknown }).agents_context, {
        context_window: 65_536,
      });
      const copy = store.campaigns.versions("sort-speed-b")[0];
      assert.ok(copy);
      assert.deepEqual((copy.contract as Record<string, unknown>).agents_context, {
        context_window: 65_536,
      });
    } finally {
      server.close();
    }
  });
});
