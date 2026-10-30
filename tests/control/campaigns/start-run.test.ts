import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { issueCommand } from "../../../src/control/issue/index.ts";
import type { ControlStore } from "../../../src/control/store/index.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { enrollRigs, ingestReport } from "../../helpers/control-store.ts";

/**
 * Start a run's twins (goal 029): REST's POST /v1/campaigns/<name>/runs and MCP's start_run take
 * the panel's fields, go through the dashboard's own code, and refuse in its words.
 */

type Ev = [string, string, string, Record<string, unknown>];

/** A rig's report of `events`, once control applied them from the events stream. */
async function ingest(store: ControlStore, rig: string, events: Ev[], summary: object = {}) {
  await ingestReport(store, {
    rig,
    ledger_id: `ledger-${rig}`,
    cursor: 0,
    next: events.length,
    generated_at: new Date().toISOString(),
    events: events.map(([actor, kind, subject, body], i) => ({
      id: i + 1,
      at: new Date(Date.parse("2026-10-20T01:00:00Z") + i * 60_000).toISOString(),
      actor,
      kind,
      subject,
      body,
    })),
    summary,
  });
}

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  read: "read-token-abcdef",
  rigs: {},
};

/** Hardware as a rig reports it, measuring on `type`. */
const hardware = (type: string) => ({
  collected_at: "2026-10-20T01:00:00Z",
  target: { type, class: `generic-${type}`, id: `${type}-1` },
  device_mode: "none",
  devices: [],
  cpu: { model: "Example CPU", host: 8, usable: 8, quota: null },
  memory: { host_mib: 16_000, limit_mib: null },
  disks: [],
  os: { kernel: "6.8", arch: "x64", node: "v22", image: null },
  toolchain: { cc: "cc 12", nvcc: null },
  errors: [],
});

/**
 * Control with three rigs. rig-a runs gs-3 of gemv-speed, a goal campaign assigned over the API
 * before (measured on cpu), with one experiment tried, one up next and a lane's idea. rig-b runs
 * survey-study (a finding gemv-speed may read) and has no model for its agents. rig-c measures on
 * cuda. The owner is signed in on the dashboard.
 */
async function stack() {
  const {
    keys,
    store,
    control: api,
  } = controlOnly({
    tokens: TOKENS,
    options: { staleAfterMs: 600_000 },
  });
  // The assignment that started gs-3, before the rig reported it.
  enrollRigs(store, ["rig-a"]);
  issueCommand(store, keys.privateKeyPem, {
    rig: "rig-a",
    kind: "assign_campaign",
    payload: {
      run: "gs-3",
      contract: { campaign: "gemv-speed", mode: "goal", target: { type: "cpu" } },
      contract_sha: "a".repeat(64),
      imports: [],
    },
    issuedBy: "owner:api",
  });
  await ingest(store, "rig-a", [
    ["harness", "run_created", "gs-3", { campaign: "gemv-speed", mode: "goal", agents: true }],
    [
      "supervisor",
      "experiment_added",
      "gs-3",
      {
        id: "x-1",
        title: "Load int4 weights with vector loads",
        details: "128-bit loads of the packed weights",
        family: "memory-layout",
        by: "teacher",
      },
    ],
    [
      "planner",
      "experiment_added",
      "gs-3",
      { id: "x-3", title: "Unroll the dot product by 4", why: "fewer branches", by: "planner" },
    ],
    [
      "lane-2",
      "experiment_added",
      "gs-3",
      { id: "x-2", title: "Tile the vector in shared memory", by: "lane-2", state: "proposed" },
    ],
    [
      "harness",
      "attempt_recorded",
      "a-1",
      { run: "gs-3", lane: "lane-1", hypothesis: "vector loads for the weights" },
    ],
    ["judge", "verdict", "a-1", { verdict: "win_confirmed", delta: 0.061 }],
    ["planner", "experiment_assigned", "gs-3", { id: "x-1", lane: "lane-1", trial: "t-1" }],
    [
      "harness",
      "experiment_finished",
      "gs-3",
      { id: "x-1", lane: "lane-1", trial: "t-1", attempt: "a-1", result: "submitted" },
    ],
  ]);
  await ingest(
    store,
    "rig-b",
    [
      ["harness", "run_created", "sv-2", { campaign: "survey-study", mode: "research" }],
      [
        "lane-2",
        "finding_added",
        "sv-2",
        {
          finding: "f-1",
          claims: 6,
          statement: "Self-training helps only where a verifier exists",
        },
      ],
    ],
    { model: { source: "none", harness: "pi" } },
  );
  await ingest(
    store,
    "rig-c",
    [["harness", "run_created", "other-1", { campaign: "other", mode: "hill_climb" }]],
    { hardware: hardware("cuda") },
  );
  store.kb().grant("gemv-speed", "survey-study", "owner:ui");
  const kb = store.kb();
  const exp = kb.search("vector loads", ["gemv-speed"], { kinds: ["experiment"] })[0];
  const finding = kb.search("verifier", ["survey-study"], { kinds: ["finding"] })[0];
  assert.ok(exp && finding);

  const rest = (campaign: string, body: unknown, token = TOKENS.admin) =>
    api.request(`/v1/campaigns/${campaign}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const { page, csrfOf, post } = await signIn(api);
  const csrf = csrfOf(await page("/ui/campaigns/gemv-speed"));
  assert.ok(csrf);
  /** A dashboard form, sent as the browser sends it: to a path, with the page's token. */
  const send = (path: string, fields: [string, string][]) =>
    post(path, [["csrf", csrf], ...fields]);
  const form = (campaign: string, fields: [string, string][]) =>
    send(`/ui/campaigns/${campaign}/runs`, fields);
  /** Every assign_campaign control signed, oldest first: who issued it, and its payload. */
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
  return { store, api, rest, send, form, assigned, exp, finding };
}

const text = (r: unknown) =>
  ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

const json = async <T>(r: Response) => (await r.json()) as T;

describe("Start a run over REST (goal 029)", () => {
  test("the same assignment as the panel, from the same fields; the answer names the run and its command", async () => {
    const s = await stack();
    // On the dashboard: copy gs-3's untried experiments, and pick a past experiment and a finding.
    const fromPanel = await s.form("gemv-speed", [
      ["rig", "rig-a"],
      ["agents", "on"],
      ["promotion", "owner_approval"],
      ["ask_above_gain", "15"],
      ["ask_declared_flaws", "1"],
      ["copy_queue", "1"],
      ["copy_from", "gs-3"],
      ["past", String(s.exp.id)],
      ["past", String(s.finding.id)],
    ]);
    assert.equal(fromPanel.status, 303);
    // The new run's page, under its campaign (goal 170).
    assert.equal(fromPanel.headers.get("location"), "/ui/campaigns/gemv-speed/runs/gemv-speed-1");
    // Over REST: the same fields.
    const r = await s.rest("gemv-speed", {
      rig: "rig-a",
      promotion: "owner_approval",
      ask_owner: { above_gain: 0.15, declared_flaws: true },
      queue_from: "gs-3",
      past: [s.exp.id, s.finding.id],
    });
    assert.equal(r.status, 201);
    const out = await json<Record<string, unknown>>(r);
    const [panel, api] = s.assigned().slice(-2);
    assert.ok(panel && api);
    assert.deepEqual(out, {
      started: true,
      campaign: "gemv-speed",
      rig: "rig-a",
      run: "gemv-speed-2",
      command: api.id,
      status: "pending",
      notes: [
        "gs-3 is at work on rig-a, and pauses when this run starts (a rig runs one run at a time).",
      ],
      // What its agents search, fixed as it starts: the whole collection and every grant.
      knowledge: { collection: "continue", granted: ["survey-study"] },
    });
    assert.deepEqual([panel.issued_by, api.issued_by], ["owner:ui", "owner:api"]);
    // The same assignment, but for the run's name.
    const { run: _a, ...fromUi } = panel.payload;
    const { run: _b, ...fromApi } = api.payload;
    assert.deepEqual(fromApi, fromUi);
    // Up next in its order, then the lane's idea, then the past experiment; the tried one stays.
    assert.deepEqual(
      (fromApi.queue as { title: string; by: string }[]).map((x) => [x.title, x.by]),
      [
        ["Unroll the dot product by 4", "planner"],
        ["Tile the vector in shared memory", "lane-2"],
        ["Load int4 weights with vector loads", "teacher"],
      ],
    );
    assert.deepEqual(fromApi.briefing, [
      {
        text: "Self-training helps only where a verifier exists\n6 supporting claims",
        from: { campaign: "survey-study", rig: "rig-b", run: "sv-2", kind: "finding", ref: "f-1" },
      },
    ]);
    assert.equal(fromApi.promotion, "owner_approval");
    // Ask me first (goal 079): the same switches from the panel and over REST.
    assert.deepEqual(fromApi.ask_owner, { above_gain: 0.15, declared_flaws: true });
    // A percent that is not one is refused in words, and nothing is sent.
    const sent = s.assigned().length;
    const bad = await s.form("gemv-speed", [
      ["rig", "rig-a"],
      ["ask_above_gain", "lots"],
    ]);
    assert.match(
      decodeURIComponent(String(bad.headers.get("location"))),
      /Ask me first: "lots" is not a percent/,
    );
    assert.equal(s.assigned().length, sent);
    // A try: no agents, nothing copied, the run named as a try.
    const tried = await s.rest("gemv-speed", { rig: "rig-a", agents: false });
    assert.equal(tried.status, 201);
    assert.match(String((await json<{ run: string }>(tried)).run), /^gemv-speed-try-\d+$/);
    assert.equal(s.assigned().at(-1)?.payload.agents, false);
    assert.equal(s.assigned().at(-1)?.payload.queue, undefined);
    // Nothing asked: no ask_owner is sent (hands-off by default).
    assert.equal(s.assigned().at(-1)?.payload.ask_owner, undefined);
  });

  test("what its agents search, fixed as it starts: continue or fresh, and the granted collections it includes; the panel too, and the run's page shows it", async () => {
    const s = await stack();
    // Over REST: fresh, with no granted collection.
    const fresh = await s.rest("gemv-speed", { rig: "rig-a", collection: "fresh", granted: [] });
    assert.equal(fresh.status, 201);
    const out = await json<{ run: string; knowledge: unknown }>(fresh);
    assert.deepEqual(out.knowledge, { collection: "fresh", granted: [] });
    assert.deepEqual(s.store.kb().scope("gemv-speed", out.run), { fresh: true, granted: [] });
    // A collection the campaign is not granted is refused, and nothing is sent.
    const before = s.assigned().length;
    const refused = await s.rest("gemv-speed", { rig: "rig-a", granted: ["secret-study"] });
    assert.equal(refused.status, 400);
    assert.match(
      (await json<{ error: string }>(refused)).error,
      /gemv-speed may not read secret-study: grant it on the campaign's page under Can read from, or leave it out\./,
    );
    assert.equal(s.assigned().length, before);
    // On the panel: Start fresh, with the granted collection left unticked.
    const page = await s.form("gemv-speed", [
      ["rig", "rig-a"],
      ["agents", "on"],
      ["collection", "fresh"],
      ["granted_shown", "1"],
    ]);
    assert.equal(page.status, 303);
    const run = String(page.headers.get("location")).split("/").pop()?.split("?")[0] ?? "";
    assert.deepEqual(s.store.kb().scope("gemv-speed", run), { fresh: true, granted: [] });
    // Left as it is: the whole collection, and every collection granted now.
    const plain = await json<{ run: string; knowledge: unknown }>(
      await s.rest("gemv-speed", { rig: "rig-a" }),
    );
    assert.deepEqual(plain.knowledge, { collection: "continue", granted: ["survey-study"] });
  });

  test("refusals in words, as Start a run gives them; nothing is sent", async () => {
    const s = await stack();
    const before = s.assigned().length;
    const refused = async (campaign: string, body: unknown, status: number, error: string) => {
      const r = await s.rest(campaign, body);
      assert.deepEqual([r.status, await json(r)], [status, { error }], JSON.stringify(body));
    };
    await refused(
      "nope",
      { rig: "rig-a" },
      404,
      "Control has no saved version or earlier assignment of this campaign.",
    );
    await refused("gemv-speed", { rig: "nope" }, 404, "No rig is called nope. Choose a rig.");
    await refused(
      "gemv-speed",
      { rig: "rig-b" },
      409,
      `rig-b has no model for its agents, so they could not work: choose one under "The agents' model", or give it one on its Edit rig page.`,
    );
    await refused(
      "gemv-speed",
      { rig: "rig-c", agents: false },
      409,
      "rig-c measures on cuda, and this campaign's kit measures on cpu: choose a rig with that hardware",
    );
    await refused(
      "gemv-speed",
      { rig: "rig-a", agents: false, queue_from: "gs-3" },
      400,
      "A try (agents off) takes no model, no experiments and no background: leave them out, or start the run with agents.",
    );
    await refused(
      "gemv-speed",
      { rig: "rig-a", queue_from: "sv-2" },
      404,
      "gemv-speed has no run sv-2: copy from a run of this campaign.",
    );
    await refused(
      "gemv-speed",
      { rig: "rig-a", judge_gpus: 1 },
      400,
      "rig-a has no GPU set to split: its GPUs are set where it is deployed.",
    );
    await refused(
      "gemv-speed",
      { rig: "rig-a", agents_model: { provider: "nope", model: "m" } },
      400,
      "That provider does not list that model.",
    );
    s.store.kb().revoke("gemv-speed", "survey-study");
    await refused(
      "gemv-speed",
      { rig: "rig-a", past: [s.finding.id] },
      400,
      "An item from past research is not one this campaign may read and start from: search again.",
    );
    // A body that is not the panel's fields.
    await refused(
      "gemv-speed",
      {},
      400,
      "bad request: rig: Invalid input: expected string, received undefined",
    );
    const extra = await s.rest("gemv-speed", { rig: "rig-a", lanes: 3 });
    assert.equal(extra.status, 400);
    assert.match((await json<{ error: string }>(extra)).error, /^bad request: .*lanes/);
    // The owner's alone: other tokens get 401.
    for (const token of [TOKENS.operator, TOKENS.agent, TOKENS.read])
      assert.equal((await s.rest("gemv-speed", { rig: "rig-a" }, token)).status, 401);
    assert.equal(s.assigned().length, before, "nothing was signed");
    const audit = s.store.auditLog.list(100).filter((a) => a.action === "refused");
    assert.ok(
      audit.some(
        (a) =>
          a.actor === "owner:api" &&
          (a.body as { path?: string }).path === "/v1/campaigns/gemv-speed/runs" &&
          /no model for its agents/.test(String((a.body as { why?: string }).why)),
      ),
    );
  });

  test("a model given first, as the panel does: not started, then started once the rig has it", async () => {
    const s = await stack();
    s.store.modelProviders.put({
      name: "zen",
      type: "opencode",
      base_url: "https://opencode.ai/zen/v1",
    });
    s.store.modelProviders.setModels("zen", [{ id: "glm-5.3-flash-free" }]);
    const given = await s.rest("gemv-speed", {
      rig: "rig-b",
      agents_model: { provider: "zen", model: "glm-5.3-flash-free" },
    });
    assert.equal(given.status, 202);
    assert.deepEqual(await json(given), {
      started: false,
      said: "rig-b takes glm-5.3-flash-free within a minute; Settings › Providers shows it taking the model until then. Then start the run again.",
    });
    assert.deepEqual(s.store.agentModels.byRig()["rig-b"], {
      provider: "zen",
      model: "glm-5.3-flash-free",
      harness: "opencode",
    });
    assert.ok(
      s.store.auditLog
        .list(50)
        .some((a) => a.action === "rig_model_given" && a.actor === "owner:api"),
    );
    assert.equal(s.assigned().length, 1, "no run yet");
    // Too early: the rig has not taken it.
    const early = await s.rest("gemv-speed", { rig: "rig-b" });
    assert.equal(early.status, 409);
    assert.match(
      (await json<{ error: string }>(early)).error,
      /^rig-b has not taken glm-5\.3-flash-free yet \(it does within a minute/,
    );
    // The rig reports it runs the model: the run starts.
    s.store.db
      .prepare("update rig set summary = json_set(summary, '$.model', json(?)) where id = 'rig-b'")
      .run(JSON.stringify({ source: "control", model: "glm-5.3-flash-free", harness: "opencode" }));
    const started = await s.rest("gemv-speed", { rig: "rig-b" });
    assert.equal(started.status, 201);
    assert.equal((await json<{ run: string }>(started)).run, "gemv-speed-1");
  });

  test("a Claude subscription's model counts as taken under Claude Code's own name for it", async () => {
    const s = await stack();
    s.store.modelProviders.put({
      name: "claude-sub",
      type: "claude",
      base_url: "https://api.anthropic.com",
      key: { sealed: "sealed-for-the-tests", hint: "…test" },
    });
    s.store.agentModels.assignRig("rig-b", {
      provider: "claude-sub",
      model: "sonnet-5.5",
      harness: "claude-code",
    });
    // Claude Code reports the model by its own name, not the subscription's id for it.
    s.store.db
      .prepare("update rig set summary = json_set(summary, '$.model', json(?)) where id = 'rig-b'")
      .run(
        JSON.stringify({
          source: "control",
          name: "claude-sub",
          model: "claude-sonnet-5-5",
          harness: "claude-code",
        }),
      );
    const started = await s.rest("gemv-speed", { rig: "rig-b" });
    assert.equal(started.status, 201, await started.clone().text());
  });

  test("the model the rig has already keeps its harness; another model gets what it needs", async () => {
    const s = await stack();
    s.store.modelProviders.put({
      name: "oai",
      type: "openai",
      base_url: "https://models.example.com/v1",
      key: { sealed: "sealed-for-the-tests", hint: "…test" },
    });
    s.store.modelProviders.setModels("oai", [{ id: "gpt-x" }, { id: "gpt-y" }]);
    // rig-a runs its agents in Codex with gpt-x, and reports so.
    s.store.agentModels.assignRig("rig-a", { provider: "oai", model: "gpt-x", harness: "codex" });
    s.store.db
      .prepare("update rig set summary = json_set(summary, '$.model', json(?)) where id = 'rig-a'")
      .run(JSON.stringify({ source: "control", model: "gpt-x", harness: "codex" }));
    // Start a run naming the same model, over REST and on the dashboard's panel: Codex stays.
    const rest = await s.rest("gemv-speed", {
      rig: "rig-a",
      agents_model: { provider: "oai", model: "gpt-x" },
    });
    assert.equal(rest.status, 201);
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.harness, "codex");
    const panel = await s.form("gemv-speed", [
      ["rig", "rig-a"],
      ["agents", "on"],
      ["agents_model", "oai|gpt-x"],
    ]);
    assert.equal(panel.status, 303);
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.harness, "codex");
    // Another model: the harness it needs (Pi for an OpenAI-compatible key).
    const other = await s.rest("gemv-speed", {
      rig: "rig-a",
      agents_model: { provider: "oai", model: "gpt-y" },
    });
    assert.equal(other.status, 202);
    assert.deepEqual(s.store.agentModels.byRig()["rig-a"], {
      provider: "oai",
      model: "gpt-y",
      harness: "pi",
    });
    // Claude Code with another provider is refused, naming the harnesses that work with it.
    const refused = async (choice: string) =>
      decodeURIComponent(
        String(
          (
            await s.send("/ui/settings/rigs", [
              ["rig", "rig-a"],
              ["harness", "claude-code"],
              ["choice", choice],
            ])
          ).headers.get("location"),
        ),
      );
    assert.match(
      await refused("oai|gpt-x"),
      /error=Claude Code runs only with a Claude subscription here: choose Pi, OpenCode v2 or Codex for this provider\./,
    );
    s.store.modelProviders.put({
      name: "keyed",
      type: "anthropic",
      base_url: "https://api.anthropic.com",
      key: { sealed: "sealed-for-the-tests", hint: "…test" },
    });
    s.store.modelProviders.setModels("keyed", [{ id: "claude-test" }]);
    assert.match(
      await refused("keyed|claude-test"),
      /error=Claude Code runs only with a Claude subscription here: choose Pi or OpenCode v2 for this provider\./,
    );
  });
});

describe("Start a run over MCP (goal 029)", () => {
  test("start_run for the owner and an operator, never an agent or a reader; an operator's GPU split is refused", async () => {
    const s = await stack();
    const tools = async (token: string) =>
      (await (await mcpClient(s.api, token)).listTools()).tools.map((t) => t.name);
    assert.ok((await tools(TOKENS.admin)).includes("start_run"));
    assert.ok((await tools(TOKENS.operator)).includes("start_run"));
    assert.ok(!(await tools(TOKENS.agent)).includes("start_run"));
    assert.ok(!(await tools(TOKENS.read)).includes("start_run"));
    const operator = await mcpClient(s.api, TOKENS.operator);
    const out = JSON.parse(
      text(
        await operator.callTool({
          name: "start_run",
          arguments: {
            campaign: "gemv-speed",
            rig: "rig-a",
            queue_from: "gs-3",
          },
        }),
      ),
    ) as { started: boolean; run: string; command: string; notes: string[] };
    assert.deepEqual([out.started, out.run], [true, "gemv-speed-1"]);
    const sent = s.assigned().at(-1);
    assert.ok(sent);
    assert.equal(sent.id, out.command);
    assert.equal(sent.issued_by, "owner:operator");
    assert.deepEqual(
      (sent.payload.queue as { title: string }[]).map((x) => x.title),
      ["Unroll the dot product by 4", "Tile the vector in shared memory"],
    );
    // A new GPU split restarts the rig's harness: the owner's alone.
    const split = await operator.callTool({
      name: "start_run",
      arguments: { campaign: "gemv-speed", rig: "rig-a", judge_gpus: 1 },
    });
    assert.equal(split.isError, true);
    assert.deepEqual(JSON.parse(text(split)), {
      error: "Only the owner's token changes a rig's GPU split: leave out judge_gpus.",
    });
    // The owner's call is refused in the panel's words, and in the audit log.
    const owner = await mcpClient(s.api, TOKENS.admin);
    const refused = await owner.callTool({
      name: "start_run",
      arguments: { campaign: "gemv-speed", rig: "rig-b" },
    });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /rig-b has no model for its agents, so they could not work/);
    assert.equal(s.assigned().length, 2, "only the operator's run was signed");
    const audit = s.store.auditLog.list(100);
    assert.ok(audit.some((a) => a.action === "mcp:start_run" && a.actor === "owner:operator"));
    assert.ok(
      audit.some(
        (a) =>
          a.action === "refused" &&
          a.actor === "owner:mcp" &&
          (a.body as { tool?: string }).tool === "mcp:start_run",
      ),
    );
  });
});
