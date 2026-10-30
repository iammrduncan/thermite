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
const EXAMPLES = join(import.meta.dirname, "../../../examples/contracts");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
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

const INFO = "## Background\nThe kernel is in `src/kernel`.\n\n- Tiling: no gain.\n";

describe("a campaign's brief on the command line (goal 078)", () => {
  test("assign takes the brief over the contract file's: the additional information from a file, ideas and hypotheses one per option", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-brief-"));
    const info = join(dir, "info.md");
    writeFileSync(info, INFO);
    const contract = join(EXAMPLES, "smoke-cpu.json");
    const out = await cli(
      "assign",
      "--contract",
      contract,
      "--run",
      "smoke-1",
      "--seed-commit",
      COMMIT,
      "--info-file",
      info,
      "--idea",
      "Fuse the loops.",
      "--idea",
      "Unroll by 4.",
      "--hypothesis",
      "It is memory bound.",
      "--link",
      "https://git.example.com/team/x/issues/1",
      "--print",
    );
    assert.equal(out.code, 0, out.stderr);
    const payload = JSON.parse(out.stdout) as {
      contract: Record<string, unknown>;
      contract_sha: string;
    };
    assert.equal(payload.contract.notes, INFO);
    assert.deepEqual(payload.contract.ideas, ["Fuse the loops.", "Unroll by 4."]);
    assert.deepEqual(payload.contract.hypotheses, ["It is memory bound."]);
    assert.deepEqual(payload.contract.links, ["https://git.example.com/team/x/issues/1"]);
    // The hash is the sent contract's: it changes with the brief.
    const sent = parseContract(payload.contract);
    const file = parseContract(JSON.parse(readFileSync(contract, "utf8")));
    assert.ok(sent.ok && file.ok);
    assert.equal(payload.contract_sha, sent.sha);
    assert.notEqual(payload.contract_sha, file.sha);
    // Without the options, the file's contract as it is.
    const plain = await cli(
      "assign",
      "--contract",
      contract,
      "--run",
      "smoke-1",
      "--seed-commit",
      COMMIT,
      "--print",
    );
    assert.equal((JSON.parse(plain.stdout) as { contract_sha: string }).contract_sha, file.sha);
    // A research campaign has questions, not ideas; a missing file is said in words.
    const research = await cli(
      "assign",
      "--contract",
      join(EXAMPLES, "research-example.json"),
      "--run",
      "r-1",
      "--idea",
      "x",
      "--print",
    );
    assert.deepEqual(
      [research.code, research.stderr.trim()],
      [2, "--idea is for hill-climb and goal campaigns: a research campaign has questions"],
    );
    const missing = await cli(
      "assign",
      "--contract",
      contract,
      "--run",
      "smoke-1",
      "--seed-commit",
      COMMIT,
      "--info-file",
      join(dir, "nope.md"),
      "--print",
    );
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /^--info-file: .*nope\.md/);
  });

  test("campaign copy keeps the brief, or gives the copy its own", async () => {
    const { keys, store, control: api } = controlOnly({ tokens: TOKENS });
    const goal = JSON.parse(readFileSync(join(EXAMPLES, "goal-example.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const contract = parseContract({
      ...goal,
      campaign: "sort-speed",
      notes: "The old brief.",
      ideas: ["An old idea."],
      hypotheses: ["An old hypothesis."],
    });
    assert.ok(contract.ok, contract.ok ? "" : contract.errors.join("; "));
    // The assignment that started sort-speed-1, before the rig reported it.
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
      const dir = mkdtempSync(join(tmpdir(), "thermite-brief-copy-"));
      const owner = join(dir, "owner-token");
      writeFileSync(owner, "owner-token-abcdef\n", { mode: 0o600 });
      const info = join(dir, "info.md");
      writeFileSync(info, INFO);
      const at = ["--control", control, "--token-file", owner];
      const kept = await cli("campaign", "copy", "sort-speed", "sort-speed-b", ...at);
      assert.equal(kept.code, 0, kept.stderr);
      const b = store.campaigns.versions("sort-speed-b")[0]?.contract as Record<string, unknown>;
      assert.deepEqual(
        [b.notes, b.ideas, b.hypotheses],
        ["The old brief.", ["An old idea."], ["An old hypothesis."]],
      );
      const own = await cli(
        "campaign",
        "copy",
        "sort-speed",
        "sort-speed-c",
        "--info-file",
        info,
        "--hypothesis",
        "A new hypothesis.",
        "--hypothesis",
        "Another.",
        ...at,
      );
      assert.equal(own.code, 0, own.stderr);
      const c = store.campaigns.versions("sort-speed-c")[0]?.contract as Record<string, unknown>;
      assert.deepEqual(
        [c.notes, c.ideas, c.hypotheses],
        [INFO, ["An old idea."], ["A new hypothesis.", "Another."]],
      );
    } finally {
      server.close();
    }
  });
});
