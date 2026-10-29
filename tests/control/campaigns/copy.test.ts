import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { CampaignDraft } from "../../../src/control/campaigns/builder.ts";
import { startCampaign } from "../../../src/control/campaigns/new.ts";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { KitRepos } from "../../../src/control/kits/repos.ts";
import { McpServers } from "../../../src/control/mcp-servers/index.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { parseContract } from "../../../src/core/contract.ts";
import { usesFor } from "../../../src/core/mcp.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Copy a campaign (goal 069): REST's POST /v1/campaigns/<name>/copy, MCP's copy_campaign. The copy
 * has the source's contract and kit under its own name, its own empty folder and no grants, and
 * Start a run starts it like any campaign.
 */

type Ev = [string, string, string, Record<string, unknown>];

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
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
 * Control with kits. matmul-speed is saved twice on the New campaign page; its first version ran
 * as matmul-speed-1 on rig-a, which recorded an experiment, and it reads survey-study's folder.
 * gemv-speed is known only by an assignment over the API (gs-3 on rig-a). rig-b ran a rig check.
 */
async function stack() {
  const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
  const { keys, store, control, api } = controlOnly({
    tokens: TOKENS,
    options: { staleAfterMs: 600_000, kits },
  });
  const next = new Map<string, number>();
  /**
   * A rig's report of these events, after the ones it reported before, once control applied them
   * from the events stream.
   */
  const ingest = async (rig: string, events: Ev[]) => {
    const from = next.get(rig) ?? 0;
    next.set(rig, from + events.length);
    await ingestReport(store, {
      rig,
      ledger_id: `ledger-${rig}`,
      cursor: from,
      next: from + events.length,
      generated_at: new Date().toISOString(),
      events: events.map(([actor, kind, subject, body], i) => ({
        id: from + i + 1,
        at: new Date(Date.parse("2026-10-21T01:00:00Z") + (from + i) * 60_000).toISOString(),
        actor,
        kind,
        subject,
        body,
      })),
      summary: {
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
  };
  const deps = { store, kits, privateKeyPem: keys.privateKeyPem };
  await ingest("rig-a", []);
  const first = await startCampaign(deps, {
    draft,
    rig: "rig-a",
    target: CPU,
    start: true,
    by: "owner:ui",
  });
  assert.ok(first.ok && first.run === "matmul-speed-1");
  await ingest("rig-a", [
    ["harness", "run_created", "matmul-speed-1", { campaign: "matmul-speed", mode: "hill_climb" }],
    [
      "planner",
      "experiment_added",
      "matmul-speed-1",
      { id: "x-1", title: "Tile the loops by 32", by: "planner" },
    ],
  ]);
  const second = await startCampaign(deps, {
    draft,
    rig: "rig-a",
    target: CPU,
    start: false,
    by: "owner:ui",
  });
  assert.ok(second.ok && second.version === 2);
  await ingest("rig-b", [
    ["harness", "run_created", "sv-2", { campaign: "survey-study", mode: "research" }],
    [
      "harness",
      "run_created",
      "rc-1",
      { campaign: "rig-check-smoke-cpu-1a2b3c4d", mode: "hill_climb", agents: false },
    ],
  ]);
  store.kb().grant("matmul-speed", "survey-study", "owner:ui");
  // gemv-speed: assigned over the API with a real contract, its project and kit from git.
  const goal = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../examples/contracts/goal-example.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const gemv = parseContract({ ...goal, campaign: "gemv-speed", version: 3 });
  assert.ok(gemv.ok);
  const gemvImports = [
    {
      kind: "repo_bundle",
      path: "repos/my-project.bundle",
      repo: "my-project",
      commit: C,
      source: { git: "https://git.example.com/team/my-project.git" },
    },
  ];
  issueCommand(store, keys.privateKeyPem, {
    rig: "rig-a",
    kind: "assign_campaign",
    payload: {
      run: "gs-3",
      contract: gemv.contract,
      contract_sha: gemv.sha,
      seed: { repo: "my-project", commit: C },
      imports: gemvImports,
      promotion: "owner_approval",
      // A run option: a copy leaves it with gs-3, as it leaves promotion (goal 079).
      ask_owner: { declared_flaws: true },
      queue: [
        { title: "Vector loads", by: "planner", state: "queued", from: { run: "gs-2", id: "x-9" } },
      ],
    },
    issuedBy: "owner:api",
  });

  const rest = (from: string, body: unknown, token?: string) =>
    api("POST", `/v1/campaigns/${from}/copy`, body, token);
  const startRun = (campaign: string, body: unknown) =>
    api("POST", `/v1/campaigns/${campaign}/runs`, body);
  /** Every assign_campaign control signed, oldest first. */
  const assigned = () =>
    (
      store.db
        .prepare("select signed from command where kind = 'assign_campaign' order by rowid")
        .all() as { signed: string }[]
    ).map(
      (x) =>
        (
          JSON.parse(x.signed) as {
            envelope: { id: string; issued_by: string; payload: Record<string, unknown> };
          }
        ).envelope,
    );
  const page = async (path: string) => (await signIn(control)).page(path);
  return { store, control, rest, startRun, assigned, ingest, page, gemv, gemvImports };
}

const text = (r: unknown) =>
  ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

const json = async <T>(r: Response) => (await r.json()) as T;

describe("Copy a campaign over REST (goal 069)", () => {
  test("a saved campaign: its newest version under the new name, an empty folder, no grants, and a run reads only the copy's folder", async () => {
    const s = await stack();
    const [source] = s.store.campaigns.versions("matmul-speed");
    assert.ok(source && source.version === 2);
    const r = await s.rest("matmul-speed", { name: "matmul-speed-b" });
    assert.equal(r.status, 201);
    const [copy] = s.store.campaigns.versions("matmul-speed-b");
    assert.ok(copy);
    assert.deepEqual(await json(r), {
      campaign: "matmul-speed-b",
      version: 1,
      contract_sha: copy.sha,
      from: { campaign: "matmul-speed", version: 2 },
    });
    // The same contract but for its name and version, with a hash of its own; the same sources.
    const { campaign, version, ...rest } = copy.contract as Record<string, unknown>;
    const { campaign: _c, version: _v, ...sourceRest } = source.contract as Record<string, unknown>;
    assert.deepEqual([campaign, version], ["matmul-speed-b", 1]);
    assert.deepEqual(rest, sourceRest);
    const reparsed = parseContract(copy.contract);
    assert.ok(reparsed.ok);
    assert.equal(copy.sha, reparsed.sha);
    assert.notEqual(copy.sha, source.sha);
    assert.deepEqual(copy.sources, source.sources);
    assert.deepEqual(copy.copied_from, { campaign: "matmul-speed", version: 2 });
    assert.equal(copy.created_by, "owner:api");
    // Its own folder, empty, reading nothing else; the source still reads survey-study.
    const kb = s.store.kb();
    const folder = kb.collection("matmul-speed-b");
    assert.deepEqual([folder.items, folder.runs, folder.reads, folder.read_by], [0, 0, [], []]);
    assert.deepEqual(kb.readable("matmul-speed-b"), ["matmul-speed-b"]);
    assert.deepEqual(kb.reads("matmul-speed"), ["survey-study"]);
    // Who copied it, from what: the audit log, and the copy's page.
    const audit = s.store.auditLog.list(50).find((a) => a.action === "campaign_copied");
    assert.equal(audit?.actor, "owner:api");
    assert.deepEqual(audit?.body, {
      campaign: "matmul-speed-b",
      from: { campaign: "matmul-speed", version: 2 },
      sha: copy.sha,
    });
    const html = await s.page("/ui/campaigns/matmul-speed-b");
    assert.match(
      html,
      /Copied from<\/span> <a href="[^"]*matmul-speed">matmul-speed version 2<\/a>/,
    );
    // The dashboard is the owner's: their own copy, over any surface, is "you".
    assert.match(html, /by you, just now\. Its collection in the knowledge base started empty\./);
    assert.match(html, /Saved on control, with no run yet\./);

    // Start a run of the copy: its own contract, the source's project and kit imports.
    const before = s.assigned().find((a) => a.payload.run === "matmul-speed-1");
    assert.ok(before);
    const started = await s.startRun("matmul-speed-b", { rig: "rig-a" });
    assert.equal(started.status, 201);
    const out = await json<{ run: string; command: string }>(started);
    assert.equal(out.run, "matmul-speed-b-1");
    const sent = s.assigned().at(-1);
    assert.ok(sent && sent.id === out.command);
    assert.equal((sent.payload.contract as { campaign: string }).campaign, "matmul-speed-b");
    assert.equal(sent.payload.contract_sha, copy.sha);
    assert.deepEqual(sent.payload.imports, before.payload.imports);
    assert.deepEqual(sent.payload.seed, before.payload.seed);
    // The rig reports the run: control files it in the copy's folder, and syncs it nothing else.
    await s.ingest("rig-a", [
      ["harness", "run_created", "matmul-speed-b-1", { campaign: "matmul-speed-b" }],
    ]);
    const sync = s.store.kb().sync("rig-a", "matmul-speed-b-1", 0);
    assert.deepEqual(
      [sync?.campaign, sync?.collections, sync?.items],
      ["matmul-speed-b", ["matmul-speed-b"], []],
    );
    // The source's run still reads its own folder and survey-study's.
    assert.deepEqual(s.store.kb().sync("rig-a", "matmul-speed-1", 0)?.collections, [
      "matmul-speed",
      "survey-study",
    ]);
  });

  test("refusals in words; nothing is saved", async () => {
    const s = await stack();
    s.store.kb().grant("old-name", "matmul-speed", "owner:ui");
    const before = s.store.campaigns.versions().length;
    const refused = async (from: string, body: unknown, status: number, error: string) => {
      const r = await s.rest(from, body);
      assert.deepEqual([r.status, await json(r)], [status, { error }], JSON.stringify(body));
    };
    for (const taken of ["matmul-speed", "gemv-speed", "survey-study", "old-name"])
      await refused(
        "matmul-speed",
        { name: taken },
        409,
        `There is a campaign named ${taken} already. Choose another name.`,
      );
    for (const bad of ["Matmul", "-b", "", "a b", "x".repeat(65)])
      await refused(
        "matmul-speed",
        { name: bad },
        400,
        "A campaign's name is lowercase letters, digits, dashes and underscores, at most 64, starting with a letter or a digit.",
      );
    await refused(
      "matmul-speed",
      { name: "rig-check-mine" },
      400,
      "A name that starts with rig-check- is for rig checks. Choose another name.",
    );
    await refused(
      "nope",
      { name: "nope-b" },
      404,
      "Control has no saved version or earlier assignment of nope. There is nothing to copy.",
    );
    await refused(
      "rig-check-smoke-cpu-1a2b3c4d",
      { name: "smoke-b" },
      400,
      "rig-check-smoke-cpu-1a2b3c4d is a rig check's campaign. A rig check cannot be copied.",
    );
    await refused(
      "matmul-speed",
      {},
      400,
      "bad request: name: Invalid input: expected string, received undefined",
    );
    const extra = await s.rest("matmul-speed", { name: "matmul-b", lanes: 3 });
    assert.equal(extra.status, 400);
    assert.match((await json<{ error: string }>(extra)).error, /^bad request: .*lanes/);
    // The owner's alone over REST: other tokens get 401.
    for (const token of [TOKENS.operator, TOKENS.agent, TOKENS.read])
      assert.equal((await s.rest("matmul-speed", { name: "matmul-b" }, token)).status, 401);
    assert.equal(s.store.campaigns.versions().length, before, "nothing was saved");
    const audit = s.store.auditLog.list(100);
    assert.ok(!audit.some((a) => a.action === "campaign_copied"));
    assert.ok(
      audit.some(
        (a) =>
          a.action === "refused" &&
          a.actor === "owner:api" &&
          (a.body as { path?: string }).path === "/v1/campaigns/matmul-speed/copy" &&
          /already/.test(String((a.body as { why?: string }).why)),
      ),
    );
  });
});

describe("Copy a campaign over MCP (goal 069)", () => {
  test("copy_campaign for the owner and an operator; a campaign known only by an assignment; start_run on the copy", async () => {
    const s = await stack();
    const tools = async (token: string) =>
      (await (await mcpClient(s.control, token)).listTools()).tools.map((t) => t.name);
    assert.ok((await tools(TOKENS.admin)).includes("copy_campaign"));
    assert.ok((await tools(TOKENS.operator)).includes("copy_campaign"));
    assert.ok(!(await tools(TOKENS.agent)).includes("copy_campaign"));
    assert.ok(!(await tools(TOKENS.read)).includes("copy_campaign"));
    const operator = await mcpClient(s.control, TOKENS.operator);
    const out = JSON.parse(
      text(
        await operator.callTool({
          name: "copy_campaign",
          arguments: { from: "gemv-speed", name: "gemv-speed-b" },
        }),
      ),
    );
    const [copy] = s.store.campaigns.versions("gemv-speed-b");
    assert.ok(copy);
    assert.deepEqual(out, {
      campaign: "gemv-speed-b",
      version: 1,
      contract_sha: copy.sha,
      from: { campaign: "gemv-speed", rig: "rig-a", run: "gs-3" },
    });
    // The assignment's contract under the new name; its starting point and imports, not its run's.
    const { campaign, version, ...rest } = copy.contract as Record<string, unknown>;
    const { campaign: _c, version: _v, ...sourceRest } = s.gemv.contract as Record<string, unknown>;
    assert.deepEqual([campaign, version], ["gemv-speed-b", 1]);
    assert.deepEqual(rest, sourceRest);
    assert.notEqual(copy.sha, s.gemv.sha);
    assert.deepEqual(copy.sources, {
      assignment: { seed: { repo: "my-project", commit: C }, imports: s.gemvImports },
    });
    assert.equal(copy.created_by, "owner:operator");
    assert.deepEqual(s.store.kb().readable("gemv-speed-b"), ["gemv-speed-b"]);
    const audit = s.store.auditLog.list(100);
    assert.ok(audit.some((a) => a.action === "mcp:copy_campaign" && a.actor === "owner:operator"));
    assert.ok(audit.some((a) => a.action === "campaign_copied" && a.actor === "owner:operator"));
    const html = await s.page("/ui/campaigns/gemv-speed-b");
    assert.match(html, /gemv-speed as assigned for gs-3 on rig-a<\/a>/);

    // start_run on the copy: the assignment's imports, the copy's contract, nothing of gs-3's run.
    const started = JSON.parse(
      text(
        await operator.callTool({
          name: "start_run",
          arguments: { campaign: "gemv-speed-b", rig: "rig-a" },
        }),
      ),
    ) as { started: boolean; run: string; command: string };
    assert.deepEqual([started.started, started.run], [true, "gemv-speed-b-1"]);
    const sent = s.assigned().at(-1);
    assert.ok(sent && sent.id === started.command);
    assert.deepEqual(sent.payload, {
      run: "gemv-speed-b-1",
      contract: copy.contract,
      contract_sha: copy.sha,
      seed: { repo: "my-project", commit: C },
      imports: s.gemvImports,
    });

    // Refused in words, and in the audit log.
    const owner = await mcpClient(s.control, TOKENS.admin);
    const refused = await owner.callTool({
      name: "copy_campaign",
      arguments: { from: "gemv-speed", name: "gemv-speed-b" },
    });
    assert.equal(refused.isError, true);
    assert.deepEqual(JSON.parse(text(refused)), {
      error: "There is a campaign named gemv-speed-b already. Choose another name.",
    });
    assert.ok(
      s.store.auditLog
        .list(100)
        .some(
          (a) =>
            a.action === "refused" &&
            a.actor === "owner:mcp" &&
            (a.body as { tool?: string }).tool === "mcp:copy_campaign",
        ),
    );
  });
});

describe("A research copy's MCP servers (goals 069 and 068)", () => {
  /** Settings with two servers whose tools control has read, and a research campaign saved. */
  async function research() {
    const s = await stack();
    const listed: Record<string, string[]> = {
      "web-search": ["search", "extract"],
      "paper-search": ["find"],
    };
    const servers = new McpServers(s.store, SecretBox.ephemeral(), {
      connect: async (url) => ({
        listTools: async () =>
          (listed[new URL(url).hostname.split(".")[0] ?? ""] ?? []).map((name) => ({ name })),
        callTool: async () => ({}),
        close: async () => {},
      }),
    });
    for (const name of Object.keys(listed)) {
      servers.put({ name, url: `https://${name}.example.com/mcp`, auth: "none" }, "owner:test");
      assert.equal(await servers.check(name), null);
    }
    const saved = await startCampaign(
      {
        store: s.store,
        kits: new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-"))),
        privateKeyPem: generateSigningKeys().privateKeyPem,
      },
      {
        draft: {
          mode: "research",
          campaign: "web-survey",
          title: "Survey 2-bit decoding",
          research: {
            topic: "2-bit decoding",
            questions: ["Which papers help?"],
            min_duration: "1h",
            // A floor of verified claims before the answer check (goal 112): a copy keeps it.
            min_verified_claims: 4,
          },
          mcp_servers: [{ name: "web-search", agents: ["workers"] }],
        },
        rig: "rig-a",
        target: CPU,
        start: false,
        by: "owner:ui",
      },
    );
    assert.ok(saved.ok);
    return s;
  }

  test("the copy's contract names the servers given, a run of it gives them to its workers, and [] names none", async () => {
    const s = await research();
    const [source] = s.store.campaigns.versions("web-survey");
    assert.ok(source);
    const uses = [
      { name: "paper-search", agents: ["workers", "advisors"], tools: { workers: ["find"] } },
    ];
    const r = await s.rest("web-survey", { name: "web-survey-b", mcp_servers: uses });
    assert.equal(r.status, 201, await r.clone().text());
    const [copy] = s.store.campaigns.versions("web-survey-b");
    assert.ok(copy);
    assert.deepEqual(await json(r), {
      campaign: "web-survey-b",
      version: 1,
      contract_sha: copy.sha,
      from: { campaign: "web-survey", version: 1, other_mcp_servers: true },
    });
    // The contract carries the new list, in place of the source's, and its hash follows it.
    const { mcp_servers, campaign: _c, ...rest } = copy.contract as Record<string, unknown>;
    const {
      mcp_servers: was,
      campaign: _s,
      ...sourceRest
    } = source.contract as Record<string, unknown>;
    assert.deepEqual([mcp_servers, was], [uses, [{ name: "web-search", agents: ["workers"] }]]);
    assert.deepEqual(rest, sourceRest);
    assert.equal(rest.min_verified_claims, 4, "the copy keeps the floor of verified claims");
    const reparsed = parseContract(copy.contract);
    assert.ok(reparsed.ok && reparsed.sha === copy.sha);
    const audit = s.store.auditLog.list(50).find((a) => a.action === "campaign_copied");
    assert.deepEqual(audit?.body, {
      campaign: "web-survey-b",
      from: { campaign: "web-survey", version: 1, other_mcp_servers: true },
      sha: copy.sha,
      mcp_servers: uses,
    });
    assert.match(
      await s.page("/ui/campaigns/web-survey-b"),
      /started empty\. Its agents use other MCP servers than its source's: paper-search \(workers: find; advisors\)\./,
    );

    // A run of the copy: its assignment names the copy's servers, and its workers get them.
    const started = await s.startRun("web-survey-b", { rig: "rig-a" });
    assert.equal(started.status, 201, await started.clone().text());
    const sent = s.assigned().at(-1);
    assert.ok(sent);
    assert.deepEqual(sent.payload.mcp_servers, uses);
    const given = s.store.commands.assignedMcpServers("rig-a").get(String(sent.payload.run));
    assert.deepEqual(usesFor(given, "workers"), [{ name: "paper-search", tools: ["find"] }]);

    // Over MCP, with an operator's token: [] names none.
    const operator = await mcpClient(s.control, TOKENS.operator);
    const out = JSON.parse(
      text(
        await operator.callTool({
          name: "copy_campaign",
          arguments: { from: "web-survey", name: "web-survey-c", mcp_servers: [] },
        }),
      ),
    );
    assert.deepEqual(out.from, { campaign: "web-survey", version: 1, other_mcp_servers: true });
    const [none] = s.store.campaigns.versions("web-survey-c");
    assert.ok(none && !("mcp_servers" in (none.contract as object)));
    assert.match(
      await s.page("/ui/campaigns/web-survey-c"),
      /Its agents use no MCP server\. Its source's agents use some\./,
    );
    // The source's own list again: no other servers, so nothing to say.
    const same = await s.rest("web-survey", {
      name: "web-survey-d",
      mcp_servers: [{ name: "web-search", agents: ["workers"] }],
    });
    assert.deepEqual((await json<{ from: unknown }>(same)).from, {
      campaign: "web-survey",
      version: 1,
    });
  });

  test("refused in words: a server Settings lacks, a tool it does not list, the planner, a campaign with a kit", async () => {
    const s = await research();
    const before = s.store.campaigns.versions().length;
    const refused = async (from: string, mcpServers: unknown, error: string) => {
      const r = await s.rest(from, { name: `${from}-x`, mcp_servers: mcpServers });
      assert.deepEqual([r.status, await json(r)], [400, { error }], JSON.stringify(mcpServers));
    };
    await refused(
      "web-survey",
      [{ name: "web-research", agents: ["workers"] }],
      "Settings has no MCP server named web-research. Add it in Settings › MCP servers, or take it out of mcp_servers.",
    );
    await refused(
      "web-survey",
      [{ name: "web-search", agents: ["workers"], tools: { workers: ["search", "crawl"] } }],
      "web-search has no tool named crawl. Its tools are search, extract.",
    );
    await refused(
      "web-survey",
      [{ name: "web-search", agents: ["workers", "planner"] }],
      "A research run's planner takes no MCP server: it plans from the run's own records. Give web-search to the workers or the advisors.",
    );
    const kit =
      "This campaign's MCP servers are in its kit's kit.json: change them on the New campaign page.";
    await refused("matmul-speed", [{ name: "web-search", agents: ["workers"] }], kit);
    await refused("matmul-speed", [], kit);
    const bad = await s.rest("web-survey", {
      name: "web-survey-y",
      mcp_servers: [{ name: "Web" }],
    });
    assert.equal(bad.status, 400);
    assert.match((await json<{ error: string }>(bad)).error, /^bad request: mcp_servers\.0\./);
    assert.equal(s.store.campaigns.versions().length, before, "nothing was saved");
  });
});
