import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { CampaignDraft } from "../../../src/control/campaigns/builder.ts";
import { startCampaign } from "../../../src/control/campaigns/new.ts";
import { KitRepos } from "../../../src/control/kits/repos.ts";
import { KB_WRITES_DEFAULT, kbWritesOf } from "../../../src/core/kb.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";

/**
 * Which kinds each role may write in a campaign's collection (goal 175): the contract's
 * kb_writes, set on the campaign's page, over REST and MCP; a new version each time, and the
 * default when the contract sets none.
 */

const TOKENS = { admin: ADMIN, operator: "operator-token-abcdef", rigs: {} };

const draft: CampaignDraft = {
  mode: "hill_climb",
  campaign: "matmul-speed",
  title: "Make the matrix multiply faster",
  target: { type: "x", class: "x" },
  project: {
    url: "https://git.example.com/team/fastmat.git",
    commit: "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7",
    repo: "fastmat",
    editable_paths: ["src/kernels/**"],
  },
  kit: {
    source: "here",
    build: "make bench",
    outputs: ["bench"],
    cases: [{ name: "small", params: { n: 64 }, work: 524288 }],
    run: "{build}/bench --n {n} --out {out}/result.txt",
    check: "test -s {out}/result.txt",
  },
  score: { name: "throughput", unit: "FLOP/s" },
};

async function stack() {
  const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
  const { keys, store, control, api } = controlOnly({
    tokens: TOKENS,
    options: { staleAfterMs: 600_000, kits },
  });
  const saved = await startCampaign(
    { store, kits, privateKeyPem: keys.privateKeyPem },
    {
      draft,
      rig: "rig-a",
      target: { type: "cpu", class: "generic-cpu" },
      start: false,
      by: "owner:ui",
    },
  );
  assert.ok(saved.ok, JSON.stringify(saved));
  const newest = () =>
    store.campaigns.versions("matmul-speed")[0]?.contract as Record<string, unknown>;
  /** POST /v1/campaigns/matmul-speed/kb-writes: its status and its answer. */
  const set = async (body: unknown) => {
    const r = await api("POST", "/v1/campaigns/matmul-speed/kb-writes", body);
    return { status: r.status, body: (await r.json()) as { said?: string; error?: string } };
  };
  return { store, control, set, newest };
}

describe("who writes what in a campaign's collection", () => {
  test("the default holds until the owner sets one: REST saves a new version, and an empty body puts the default back", async () => {
    const s = await stack();
    assert.equal(s.newest().kb_writes, undefined);
    assert.deepEqual(kbWritesOf(s.newest()), KB_WRITES_DEFAULT);
    const set = await s.set({
      kb_writes: { worker: ["finding"], planner: [] },
    });
    assert.equal(set.status, 201);
    assert.match(String(set.body.said), /^Version 2 of matmul-speed is saved/);
    assert.deepEqual(s.newest().kb_writes, { worker: ["finding"], planner: [] });
    const same = await s.set({
      kb_writes: { planner: [], worker: ["finding"] },
    });
    assert.equal(same.status, 200, "the same setting is no new version");
    const bad = await s.set({
      kb_writes: { judge: ["note"] },
    });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /^bad request: kb_writes/);
    const back = await s.set({});
    assert.equal(back.status, 201);
    assert.equal(s.newest().kb_writes, undefined);
  });

  test("MCP's set_campaign_kb_writes and the campaign's page set it too", async () => {
    const s = await stack();
    const c = await mcpClient(s.control, TOKENS.operator);
    const r = await c.callTool({
      name: "set_campaign_kb_writes",
      arguments: { campaign: "matmul-speed", kb_writes: { auditor: ["review"] } },
    });
    assert.equal(r.isError, undefined, JSON.stringify(r.content));
    assert.deepEqual(s.newest().kb_writes, { auditor: ["review"] });
    const { page, csrfOf, post } = await signIn(s.control);
    const html = await page("/ui/campaigns/matmul-speed");
    assert.match(html, /Who writes in its collection/);
    assert.match(html, /name="w_auditor_review" value="1"[^>]* checked/);
    const csrf = csrfOf(html);
    assert.ok(csrf);
    const saved = await post("/ui/campaigns/matmul-speed/kb-writes", [
      ["csrf", csrf],
      ["w_worker_note", "1"],
      ["w_worker_finding", "1"],
    ]);
    assert.equal(saved.status, 303);
    assert.deepEqual(s.newest().kb_writes, { worker: ["note", "finding"] });
  });
});
