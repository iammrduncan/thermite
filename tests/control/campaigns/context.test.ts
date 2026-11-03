import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { CampaignDraft } from "../../../src/control/campaigns/builder.ts";
import { startCampaign } from "../../../src/control/campaigns/new.ts";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { KitRepos } from "../../../src/control/kits/repos.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { parseContract } from "../../../src/core/contract.ts";
import { ADMIN, controlOnly, mcpClient } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * A campaign's own context settings for all its runs' agents (goal 070): REST's POST
 * /v1/campaigns/<name>/context and MCP's set_campaign_context save a new version of its contract
 * with agents_context; copy_campaign may set them on a copy; Start a run says what applies to each
 * agent (the lower window wins) and refuses a window above what a provider lists.
 */

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  read: "read-token-abcdef",
  rigs: {},
};

const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";
const draft: CampaignDraft = {
  mode: "hill_climb",
  campaign: "matmul-speed",
  title: "Make the matrix multiply faster",
  target: { type: "x", class: "x" },
  project: {
    url: "https://git.example.com/team/fastmat.git",
    commit: C,
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

const CPU = { type: "cpu", class: "generic-cpu" };

/**
 * Control with rig-a (measures on cpu) running wide-model from "lab" for its workers. The
 * provider lists wide-model at 204,800 tokens and narrow-model at 131,072. matmul-speed is saved
 * once on the New campaign page; gemv-speed is known only by an assignment (its contract's version
 * 3).
 */
async function stack() {
  const secrets = SecretBox.ephemeral();
  const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
  const { keys, store, control, api } = controlOnly({
    tokens: TOKENS,
    options: { staleAfterMs: 600_000, kits, secrets },
  });
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "ledger-rig-a",
    cursor: 0,
    next: 0,
    generated_at: new Date().toISOString(),
    events: [],
    summary: {
      model: { source: "control", name: "lab", version: 1, model: "wide-model", harness: "pi" },
      hardware: {
        collected_at: "2026-10-21T01:00:00Z",
        target: { ...CPU, id: "cpu-1" },
        device_mode: "none",
        devices: [],
        cpu: { model: "Example CPU", host: 8, usable: 8, quota: null },
        memory: { host_mib: 16_000, limit_mib: null },
        disks: [],
        os: { kernel: "6.8", arch: "x64", node: "v22", image: null },
        toolchain: { cc: "cc 12", nvcc: null },
        errors: [],
      },
    },
  });
  store.modelProviders.put({
    name: "lab",
    type: "openai",
    base_url: "https://models.example.com/v1",
    key: { sealed: secrets.seal("lab-key-for-tests"), hint: "…ests" },
  });
  store.modelProviders.setModels("lab", [
    { id: "wide-model", context_window: 204_800 },
    { id: "narrow-model", context_window: 131_072 },
  ]);
  const saved = await startCampaign(
    { store, kits, privateKeyPem: keys.privateKeyPem },
    { draft, rig: "rig-a", target: CPU, start: false, by: "owner:ui" },
  );
  assert.ok(saved.ok && saved.version === 1);
  const goal = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../examples/contracts/goal-example.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const gemv = parseContract({ ...goal, campaign: "gemv-speed", version: 3 });
  assert.ok(gemv.ok);
  issueCommand(store, keys.privateKeyPem, {
    rig: "rig-a",
    kind: "assign_campaign",
    payload: {
      run: "gs-3",
      contract: gemv.contract,
      contract_sha: gemv.sha,
      seed: { repo: "my-project", commit: C },
      imports: [],
    },
    issuedBy: "owner:api",
  });
  const post = (path: string, body: unknown, token?: string) => api("POST", path, body, token);
  const setContext = (campaign: string, body: unknown) =>
    post(`/v1/campaigns/${campaign}/context`, body);
  const give = (body: Record<string, unknown>) => post("/v1/rigs/rig-a/model", body);
  /** Every assign_campaign control signed, oldest first. */
  const assigned = () =>
    (
      store.db
        .prepare("select signed from command where kind = 'assign_campaign' order by rowid")
        .all() as { signed: string }[]
    ).map(
      (x) =>
        (JSON.parse(x.signed) as { envelope: { payload: Record<string, unknown> } }).envelope
          .payload,
    );
  return { store, control, keys, post, setContext, give, assigned, gemv };
}

const text = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]?.text ?? "{}") as Record<
    string,
    unknown
  >;

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

const newest = (s: Awaited<ReturnType<typeof stack>>, campaign: string) =>
  s.store.campaigns.versions(campaign)[0] as NonNullable<
    ReturnType<typeof s.store.campaigns.versions>[number]
  >;

describe("a campaign's own context settings (goal 070)", () => {
  test("REST and MCP save a new version with them; the same again changes nothing; none removes them; refusals in words", async () => {
    const s = await stack();
    const first = newest(s, "matmul-speed");
    const r = await s.setContext("matmul-speed", { context_window: 131_072, compact_at: 70 });
    assert.equal(r.status, 201);
    const out = await json(r);
    const v2 = newest(s, "matmul-speed");
    assert.deepEqual(out, {
      campaign: "matmul-speed",
      version: 2,
      contract_sha: v2.sha,
      agents_context: { context_window: 131_072, compact_at: 70 },
      said: "Version 2 of matmul-speed is saved. Its runs' agents: a context window of 131,072 tokens, compaction at 70% of the window. Runs started from now take it.",
    });
    // The contract with the settings, its sources as before, and nothing else changed.
    const { agents_context, version, ...rest } = v2.contract as Record<string, unknown>;
    const { version: _v1, ...before } = first.contract as Record<string, unknown>;
    assert.deepEqual(agents_context, { context_window: 131_072, compact_at: 70 });
    assert.equal(version, 2);
    assert.deepEqual(rest, before);
    assert.deepEqual(v2.sources, first.sources);
    const again = parseContract(v2.contract);
    assert.ok(again.ok);
    assert.equal(again.sha, v2.sha);

    const same = await s.setContext("matmul-speed", { context_window: 131_072, compact_at: 70 });
    assert.equal(same.status, 200);
    assert.match(
      String((await json(same)).said),
      /^Version 2 of matmul-speed has these settings already/,
    );
    assert.equal(newest(s, "matmul-speed").version, 2);

    // MCP: each call sets them anew, so a point alone drops the window.
    const client = await mcpClient(s.control, TOKENS.operator);
    const point = text(
      await client.callTool({
        name: "set_campaign_context",
        arguments: { campaign: "matmul-speed", compact_at: 85 },
      }),
    );
    assert.equal(point.version, 3);
    assert.deepEqual(point.agents_context, { compact_at: 85 });
    assert.deepEqual(
      (newest(s, "matmul-speed").contract as Record<string, unknown>).agents_context,
      {
        compact_at: 85,
      },
    );
    // Refusals, in words, and nothing saved.
    for (const [args, error] of [
      [{ campaign: "matmul-speed", context_window: 1000 }, /from 4,096 to 100,000,000/],
      [{ campaign: "matmul-speed", compact_at: 99 }, /from 50 to 95/],
      [{ campaign: "no-such" }, /no saved version or earlier assignment of no-such/],
      [{ campaign: "rig-check-smoke-cpu-1" }, /a rig check's campaign/],
    ] as const) {
      const bad = await client.callTool({ name: "set_campaign_context", arguments: args });
      assert.equal(bad.isError, true, JSON.stringify(args));
      assert.match(JSON.stringify(bad), error);
    }
    assert.equal(newest(s, "matmul-speed").version, 3);
    await client.close();
    const reader = await mcpClient(s.control, TOKENS.read);
    assert.ok(!(await reader.listTools()).tools.some((t) => t.name === "set_campaign_context"));
    await reader.close();

    // An empty body removes them: the contract as it was, under a new version.
    const none = await s.setContext("matmul-speed", {});
    assert.equal(none.status, 201);
    assert.equal((await json(none)).agents_context, null);
    const v4 = newest(s, "matmul-speed").contract as Record<string, unknown>;
    assert.equal(v4.version, 4);
    assert.equal("agents_context" in v4, false);
    for (const [body, status] of [
      [{ context_window: "big" }, 400],
      [{ window: 1 }, 400],
      [{ compact_at: 40 }, 400],
    ] as const) {
      const bad = await s.setContext("matmul-speed", body);
      assert.equal(bad.status, status, JSON.stringify(body));
    }
    assert.equal((await s.setContext("no-such", {})).status, 404);
    const operator = await s.post("/v1/campaigns/matmul-speed/context", {}, TOKENS.operator);
    assert.ok(operator.status === 401 || operator.status === 403, "REST takes the owner's token");
    assert.deepEqual(
      s.store.auditLog
        .list(50, { action: "campaign_context_set" })
        .map((e) => (e.body as { version: number }).version)
        .reverse(),
      [2, 3, 4],
    );
  });

  test("a campaign known only by an assignment gets a saved version newer than the assignment's", async () => {
    const s = await stack();
    const r = await s.setContext("gemv-speed", { context_window: 65_536 });
    assert.equal(r.status, 201);
    const v = newest(s, "gemv-speed");
    // The rig's harness refuses a version that is not newer than one it holds.
    assert.equal(v.version, 4);
    assert.equal((v.contract as { version: number }).version, 4);
    // Its starting point and imports come from the assignment, as a copy's do.
    assert.deepEqual(v.sources.assignment?.seed, { repo: "my-project", commit: C });
    assert.equal(v.sources.assignment?.run, undefined);
  });

  test("Start a run says what applies to each agent: the lower window wins, and the campaign's point replaces the rig's", async () => {
    const s = await stack();
    // The rig: the workers on wide-model (204,800) at 80%; the planner on wide-model capped at
    // 65,536; the auditor on narrow-model (131,072); the other advisors from its advisors file.
    assert.equal(
      (await s.give({ provider: "lab", model: "wide-model", compact_at: 80 })).status,
      200,
    );
    await s.give({
      agent: "planner",
      provider: "lab",
      model: "wide-model",
      context_window: 65_536,
    });
    await s.give({ agent: "auditor", provider: "lab", model: "narrow-model" });
    await s.setContext("matmul-speed", { context_window: 100_000, compact_at: 70 });
    const r = await s.post("/v1/campaigns/matmul-speed/runs", { rig: "rig-a" });
    assert.equal(r.status, 201);
    const out = await json(r);
    assert.deepEqual(out.agents_context, {
      campaign: { context_window: 100_000, compact_at: 70 },
      agents: {
        workers: { model: "wide-model", context_window: 100_000, compact_at: 70 },
        planner: { model: "wide-model", context_window: 65_536, compact_at: 70 },
        teachers: { model: null, context_window: 100_000, compact_at: 70 },
        merged_by: { model: null, context_window: 100_000, compact_at: 70 },
        auditor: { model: "narrow-model", context_window: 100_000, compact_at: 70 },
        review_panel: { model: null, context_window: 100_000, compact_at: 70 },
      },
    });
    const words = (out.notes as string[]).join(" ");
    assert.match(
      words,
      /^This campaign sets a context window of 100,000 tokens, compaction at 70% of the window\. The lower window wins on each agent\. Workers: 100,000 tokens \(wide-model\), compacted at 70% of the window\. Planner: 65,536 tokens \(wide-model\), compacted at 70% of the window\. Teachers: at most 100,000 tokens \(the rig's advisors file\), compacted at 70% of the window\. Teachers \(merged by\): at most 100,000 tokens \(the rig's advisors file\), compacted at 70% of the window\./,
    );
    // Two teachers with their own models: the second one shows too.
    await s.give({
      agent: "teachers",
      provider: "lab",
      model: "wide-model",
      second_model: { provider: "lab", model: "narrow-model" },
    });
    const two = await json(await s.post("/v1/campaigns/matmul-speed/runs", { rig: "rig-a" }));
    const twoAgents = (two.agents_context as { agents: Record<string, { model: string | null }> })
      .agents;
    assert.deepEqual(
      [twoAgents.teachers?.model, twoAgents.second_teacher?.model, twoAgents.merged_by?.model],
      ["wide-model", "narrow-model", null],
    );
    assert.match(
      (two.notes as string[]).join(" "),
      /Teachers \(second model\): 100,000 tokens \(narrow-model\), compacted at 70% of the window\./,
    );
    await s.give({ agent: "teachers", clear: true });
    // The run's contract carries them to the rig, signed.
    const sent = s.assigned().at(-1) as { contract: { agents_context?: unknown } };
    assert.deepEqual(sent.contract.agents_context, { context_window: 100_000, compact_at: 70 });

    // MCP's start_run gives the same; a try (no agents) says nothing of it.
    const client = await mcpClient(s.control, TOKENS.operator);
    const viaMcp = text(
      await client.callTool({
        name: "start_run",
        arguments: { campaign: "matmul-speed", rig: "rig-a" },
      }),
    );
    assert.deepEqual(viaMcp.agents_context, out.agents_context);
    const tried = text(
      await client.callTool({
        name: "start_run",
        arguments: { campaign: "matmul-speed", rig: "rig-a", agents: false },
      }),
    );
    assert.equal(tried.agents_context, undefined);
    await client.close();

    // A campaign without its own settings: Start a run says nothing more than before.
    await s.setContext("matmul-speed", {});
    const plain = await json(await s.post("/v1/campaigns/matmul-speed/runs", { rig: "rig-a" }));
    assert.equal(plain.agents_context, undefined);
    assert.equal(plain.notes, undefined);
  });

  test("a campaign window above what a provider lists for one of the rig's agents is refused before signing, on every path", async () => {
    const s = await stack();
    await s.give({ provider: "lab", model: "wide-model" });
    await s.give({ agent: "teachers", provider: "lab", model: "narrow-model" });
    await s.setContext("matmul-speed", { context_window: 150_000 });
    const before = s.assigned().length;
    const r = await s.post("/v1/campaigns/matmul-speed/runs", { rig: "rig-a" });
    assert.equal(r.status, 409);
    assert.equal(
      (await json(r)).error,
      "This campaign sets a context window of 150,000 tokens. narrow-model, the model of the teachers on rig-a, takes at most 131,072 tokens. Set the campaign's window to 131,072 or less, or give that agent another model.",
    );
    // The same over issue_command, with the campaign's contract: nothing signed.
    const v = newest(s, "matmul-speed");
    const client = await mcpClient(s.control, TOKENS.operator);
    const issued = await client.callTool({
      name: "issue_command",
      arguments: {
        rig: "rig-a",
        kind: "assign_campaign",
        payload: { run: "by-hand-1", contract: v.contract, contract_sha: v.sha, imports: [] },
      },
    });
    assert.equal(issued.isError, true);
    assert.match(JSON.stringify(issued), /takes at most 131,072 tokens/);
    assert.equal(s.assigned().length, before);
    // A try has no agents: it starts.
    const tried = await client.callTool({
      name: "start_run",
      arguments: { campaign: "matmul-speed", rig: "rig-a", agents: false },
    });
    assert.equal(tried.isError, undefined, JSON.stringify(tried));
    await client.close();
    // A window the providers allow starts; above the rig's own cap, the lower wins.
    await s.give({ provider: "lab", model: "wide-model", context_window: 32_768 });
    await s.setContext("matmul-speed", { context_window: 131_072 });
    const ok = await s.post("/v1/campaigns/matmul-speed/runs", { rig: "rig-a" });
    assert.equal(ok.status, 201);
    const agents = ((await json(ok)).agents_context as { agents: Record<string, unknown> }).agents;
    assert.deepEqual(agents.workers, {
      model: "wide-model",
      context_window: 32_768,
      compact_at: 80,
    });
    assert.deepEqual(agents.teachers, {
      model: "narrow-model",
      context_window: 131_072,
      compact_at: 80,
    });
  });

  test("copy_campaign and its REST twin take agents_context in place of the source's", async () => {
    const s = await stack();
    await s.setContext("matmul-speed", { context_window: 131_072, compact_at: 70 });
    // Left out: the source's, as they are.
    const kept = await s.post("/v1/campaigns/matmul-speed/copy", { name: "matmul-speed-b" });
    assert.equal(kept.status, 201);
    assert.deepEqual((await json(kept)).agents_context, {
      context_window: 131_072,
      compact_at: 70,
    });
    // Its own, in place of the source's.
    const client = await mcpClient(s.control, TOKENS.operator);
    const own = text(
      await client.callTool({
        name: "copy_campaign",
        arguments: {
          from: "matmul-speed",
          name: "matmul-speed-c",
          agents_context: { context_window: 65_536 },
        },
      }),
    );
    assert.deepEqual(own.agents_context, { context_window: 65_536 });
    assert.deepEqual(
      (newest(s, "matmul-speed-c").contract as Record<string, unknown>).agents_context,
      { context_window: 65_536 },
    );
    const bad = await client.callTool({
      name: "copy_campaign",
      arguments: {
        from: "matmul-speed",
        name: "matmul-speed-d",
        agents_context: { compact_at: 40 },
      },
    });
    assert.equal(bad.isError, true);
    assert.match(JSON.stringify(bad), /from 50 to 95/);
    assert.equal(s.store.campaigns.versions("matmul-speed-d").length, 0);
    await client.close();
    // null: none.
    const none = await s.post("/v1/campaigns/matmul-speed/copy", {
      name: "matmul-speed-e",
      agents_context: null,
    });
    assert.equal(none.status, 201);
    const body = await json(none);
    assert.equal(body.agents_context, undefined);
    assert.equal("agents_context" in (newest(s, "matmul-speed-e").contract as object), false);
    const audit = s.store.auditLog.list(50, { action: "campaign_copied" })[0];
    assert.equal((audit?.body as { agents_context?: unknown } | undefined)?.agents_context, null);
  });
});
