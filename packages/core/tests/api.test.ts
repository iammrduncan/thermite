import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  actionToJsonSchema,
  assertPluginCapability,
  CORE_ACTIONS,
  type CoreActionHandlers,
  type CoreActionName,
  cliCommandPath,
  compileMcpTools,
  createDoorExecutor,
  type DoorAuditEntry,
  defineAction,
  definePluginAction,
  mcpToolName,
  PLUGIN_SLUG_RE,
} from "../src/api/index.ts";
import { createThermiteClient } from "../src/client.ts";
import { isThermiteError, ThermiteError } from "../src/errors.ts";
import {
  CORE_CAPABILITIES,
  createGrantFromProfile,
  type PolicyGrant,
} from "../src/policy/index.ts";

const NOW = Date.parse("2026-11-28T12:00:00Z");

const ownerGrant = createGrantFromProfile({
  id: "g-owner",
  label: "Owner",
  profile: "owner",
  grantedBy: "owner-1",
});

const delegateGrant = createGrantFromProfile({
  id: "g-delegate",
  label: "Delegate",
  profile: "autonomous_delegate",
  grantedBy: "owner-1",
});

const operatorGrant = createGrantFromProfile({
  id: "g-operator",
  label: "Operator",
  profile: "operator",
  grantedBy: "owner-1",
});

const viewerGrant = createGrantFromProfile({
  id: "g-viewer",
  label: "Viewer",
  profile: "viewer",
  grantedBy: "owner-1",
});

function buildAllCoreHandlers(): CoreActionHandlers {
  const sampleRun = {
    runId: "run-1",
    campaignId: "camp-1",
    mode: "hill_climb" as const,
    status: "running" as const,
    live: false,
    createdAt: "2026-11-28T00:00:00Z",
  };
  const sampleMachine = {
    machineId: "m-1",
    name: "workstation-1",
    status: "online" as const,
    wallPlugin: "wall-tools",
    wallVersion: "1.0.0",
    wallPassed: true,
    devices: [{ id: "cpu-0", kind: "cpu", name: "Host CPU", capabilities: ["avx2"] }],
  };
  const sampleCollection = {
    collectionId: "col-1",
    name: "Shared notes",
    kind: "shared" as const,
    description: "Cross-campaign notes",
  };
  const sampleGrantSummary = {
    id: "g-1",
    label: "CI",
    principalKind: "ci_token" as const,
    capabilities: ["runs:read"],
    grantedBy: "owner-1",
  };

  return {
    "campaigns.validate": () => ({ valid: true, errors: [], warnings: [] }),
    "campaigns.dry_run": () => ({
      valid: true,
      mode: "hill_climb",
      planSummary: "1 lane on cpu-0",
      matchedMachines: ["m-1"],
      warnings: [],
    }),
    "campaigns.create": (i) => ({
      campaignId: "camp-1",
      name: i.name,
      mode: "hill_climb",
      createdAt: "2026-11-28T00:00:00Z",
    }),
    "runs.list": () => ({ runs: [sampleRun] }),
    "runs.get": (i) => ({ ...sampleRun, runId: i.runId, config: { live: false } }),
    "runs.start": (i) => ({ runId: "run-1", campaignId: i.campaignId, status: "running" }),
    "runs.pause": (i) => ({ runId: i.runId, status: "paused" }),
    "runs.resume": (i) => ({ runId: i.runId, status: "running" }),
    "runs.close": (i) => ({ runId: i.runId, status: "closed" }),
    "runs.update_config": (i) => ({ runId: i.runId, config: i.patch }),
    "attempts.list": (i) => ({
      attempts: [
        {
          attemptId: "att-1",
          runId: i.runId,
          laneId: "lane-1",
          commitRef: "abc1234",
          summary: "vectorize inner loop",
          status: "judged",
          promoted: false,
        },
      ],
    }),
    "attempts.rejudge": (i) => ({ runId: i.runId, attemptId: i.attemptId, jobId: "job-9" }),
    "attempts.invalidate": (i) => ({ runId: i.runId, attemptId: i.attemptId, invalidated: true }),
    "promotions.approve": (i) => ({ runId: i.runId, attemptId: i.attemptId, promoted: true }),
    "needs.list": () => ({
      needs: [
        {
          needId: "need-1",
          runId: "run-1",
          kind: "build_loop",
          summary: "5 identical build failures",
          status: "open",
        },
      ],
    }),
    "needs.resolve": (i) => ({
      needId: i.needId,
      resolution: i.resolution,
      resolvedAt: "2026-11-28T12:00:00Z",
    }),
    "machines.list": () => ({ machines: [sampleMachine] }),
    "machines.get": (i) => ({ ...sampleMachine, machineId: i.machineId }),
    "machines.token_create": () => ({
      tokenId: "mtok-1",
      token: "join-token-value",
      expiresAt: "2026-11-28T13:00:00Z",
    }),
    "machines.enroll": () => ({
      machineId: "m-2",
      natsUrl: "tls://control.example:4222",
      status: "online",
    }),
    "machines.drain": (i) => ({ machineId: i.machineId, status: "draining" }),
    "machines.retire": (i) => ({ machineId: i.machineId, status: "retired" }),
    "kb.collections_list": () => ({ collections: [sampleCollection] }),
    "kb.collection_create": (i) => ({
      collectionId: "col-2",
      name: i.name,
      kind: i.kind,
      ...(i.campaignId ? { campaignId: i.campaignId } : {}),
      ...(i.description ? { description: i.description } : {}),
    }),
    "kb.search": (i) => ({
      hits: [
        {
          itemId: "item-1",
          collectionId: "col-1",
          title: i.include_transcripts ? "With transcripts" : "Default search",
          snippet: i.query,
          score: 0.95,
          kind: "finding",
        },
      ],
    }),
    "kb.item_write": (i) => ({
      itemId: "item-1",
      versionId: "ver-1",
      collectionId: i.collectionId,
    }),
    "settings.get": () => ({ settings: { theme: "thermite" } }),
    "settings.update": (i) => ({ settings: i.patch }),
    "tokens.list": () => ({ grants: [sampleGrantSummary] }),
    "tokens.create": (i) => ({
      grant: { ...sampleGrantSummary, label: i.label, principalKind: i.principalKind },
      token: "tok-secret-placeholder",
    }),
    "tokens.revoke": (i) => ({ grantId: i.grantId, revoked: true }),
    "plugins.list": () => ({
      plugins: [{ name: "git-sync", version: "1.0.0", description: "Git sync", enabled: true }],
    }),
    "plugins.install": () => ({ name: "live-publish", version: "1.0.0", installed: true }),
    "plugins.uninstall": (i) => ({ name: i.pluginName, uninstalled: true }),
    "terminal.input": (i) => ({ runId: i.runId, accepted: true }),
  };
}

const SAMPLE_INPUTS: Record<CoreActionName, unknown> = {
  "campaigns.validate": { yaml: "name: matmul\nmode: hill_climb\n" },
  "campaigns.dry_run": { yaml: "name: matmul\nmode: hill_climb\n", machineIds: ["m-1"] },
  "campaigns.create": { name: "matmul", yaml: "name: matmul\nmode: hill_climb\n" },
  "runs.list": { campaignId: "camp-1", status: "running", limit: 10 },
  "runs.get": { runId: "run-1" },
  "runs.start": { campaignId: "camp-1", live: true },
  "runs.pause": { runId: "run-1", reason: "maintenance" },
  "runs.resume": { runId: "run-1" },
  "runs.close": { runId: "run-1", reason: "target reached" },
  "runs.update_config": { runId: "run-1", patch: { live: true } },
  "attempts.list": { runId: "run-1", limit: 20 },
  "attempts.rejudge": { runId: "run-1", attemptId: "att-1", reason: "verify thermal drift" },
  "attempts.invalidate": { runId: "run-1", attemptId: "att-1", reason: "stale harness" },
  "promotions.approve": { runId: "run-1", attemptId: "att-1", note: "verified" },
  "needs.list": { runId: "run-1", status: "open" },
  "needs.resolve": { needId: "need-1", runId: "run-1", resolution: "approve" },
  "machines.list": { status: "online" },
  "machines.get": { machineId: "m-1" },
  "machines.token_create": { label: "gpu-box", ttlSeconds: 600 },
  "machines.enroll": {
    token: "join-token-value",
    publicKey: "UDUMMYPUBLICKEY",
    name: "gpu-box",
    wallPlugin: "wall-container",
    wallVersion: "1.0.0",
    devices: [{ id: "gpu-0", kind: "cuda", name: "GPU 0", capabilities: ["fp16"] }],
  },
  "machines.drain": { machineId: "m-1", reason: "reboot" },
  "machines.retire": { machineId: "m-1", reason: "retired" },
  "kb.collections_list": { kind: "shared" },
  "kb.collection_create": { name: "Bench notes", kind: "campaign", campaignId: "camp-1" },
  "kb.search": { query: "cache blocking" },
  "kb.item_write": { collectionId: "col-1", title: "Note", content: "Details" },
  "settings.get": { section: "providers" },
  "settings.update": { patch: { defaultWall: "wall-tools" } },
  "tokens.list": { includeRevoked: false },
  "tokens.create": {
    label: "Agent",
    principalKind: "delegated_agent",
    profile: "autonomous_delegate",
  },
  "tokens.revoke": { grantId: "g-1" },
  "plugins.list": {},
  "plugins.install": { source: "@thermite/plugin-live-publish" },
  "plugins.uninstall": { pluginName: "live-publish" },
  "terminal.input": { runId: "run-1", laneId: "lane-1", data: "status\n" },
};

describe("CORE_ACTIONS registry & JSON Schema compilation", () => {
  it("every core action has unique name, route, MCP tool, valid capability, and valid JSON Schema", () => {
    assert.equal(CORE_ACTIONS.length, 35);

    const names = new Set<string>();
    const routes = new Set<string>();
    const mcpNames = new Set<string>();
    const cliPaths = new Set<string>();
    const validCaps = new Set<string>(CORE_CAPABILITIES.filter((c) => c !== "*"));

    for (const def of CORE_ACTIONS) {
      assert.equal(names.has(def.name), false, `duplicate action name: ${def.name}`);
      names.add(def.name);

      const route = `${def.http.method} ${def.http.path}`;
      assert.equal(routes.has(route), false, `duplicate route: ${route}`);
      routes.add(route);

      const mcp = mcpToolName(def);
      assert.equal(mcpNames.has(mcp), false, `duplicate mcp tool: ${mcp}`);
      mcpNames.add(mcp);

      const cli = cliCommandPath(def);
      assert.equal(cliPaths.has(cli), false, `duplicate cli path: ${cli}`);
      cliPaths.add(cli);

      assert.equal(validCaps.has(def.capability), true, `invalid capability on ${def.name}`);

      const schema = actionToJsonSchema(def);
      assert.equal(schema.type, "object", `schema for ${def.name} must be an object`);
      assert.ok(JSON.stringify(schema).length > 2);

      const props = (schema.properties ?? {}) as Record<string, unknown>;
      for (const match of def.http.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const param = match[1];
        assert.ok(
          param && Object.hasOwn(props, param),
          `${def.name} path param :${param} missing from input schema`,
        );
      }
    }
  });

  it("enforces Decision #13 KB defaults (include_transcripts=false, campaign|shared kinds)", () => {
    const searchDef = CORE_ACTIONS.find((a) => a.name === "kb.search");
    assert.ok(searchDef);
    const parsed = searchDef.input.parse({ query: "matmul" }) as {
      query: string;
      include_transcripts: boolean;
      limit: number;
    };
    assert.equal(parsed.include_transcripts, false);
    assert.equal(parsed.limit, 10);

    const createDef = CORE_ACTIONS.find((a) => a.name === "kb.collection_create");
    assert.ok(createDef);
    assert.equal(createDef.input.safeParse({ name: "A", kind: "campaign" }).success, true);
    assert.equal(createDef.input.safeParse({ name: "B", kind: "shared" }).success, true);
    assert.equal(createDef.input.safeParse({ name: "C", kind: "private" }).success, false);
  });
});

describe("compileMcpTools policy filtering", () => {
  const pluginAction = defineAction({
    name: "live.toggle",
    summary: "Toggle public live streaming.",
    capability: "live-publish:toggle",
    http: { method: "POST", path: "/v1/plugins/live-publish/toggle" },
    input: z.object({ runId: z.string().min(1), enabled: z.boolean() }),
    output: z.object({ runId: z.string(), enabled: z.boolean() }),
  });
  const allActions = [...CORE_ACTIONS, pluginAction];

  it("filters MCP tools strictly to permitted capabilities per profile", () => {
    const ownerTools = compileMcpTools(allActions, ownerGrant, NOW);
    assert.equal(ownerTools.length, allActions.length);

    const delegateTools = compileMcpTools(allActions, delegateGrant, NOW);
    const delegateNames = new Set(delegateTools.map((t) => t.name));
    assert.equal(delegateNames.has("live_toggle"), true);
    assert.equal(delegateNames.has("promotions_approve"), true);
    assert.equal(delegateNames.has("runs_close"), true);
    assert.equal(delegateNames.has("terminal_input"), true);
    assert.equal(delegateNames.has("plugins_list"), true);
    // Excluded by default from autonomous_delegate:
    for (const excluded of [
      "tokens_list",
      "tokens_create",
      "tokens_revoke",
      "plugins_install",
      "plugins_uninstall",
    ]) {
      assert.equal(delegateNames.has(excluded), false, `delegate must not see ${excluded}`);
    }

    const viewerTools = compileMcpTools(allActions, viewerGrant, NOW);
    const viewerNames = new Set(viewerTools.map((t) => t.name));
    assert.equal(viewerNames.has("runs_list"), true);
    assert.equal(viewerNames.has("kb_search"), true);
    assert.equal(viewerNames.has("machines_list"), true);
    assert.equal(viewerNames.has("runs_start"), false);
    assert.equal(viewerNames.has("attempts_rejudge"), false);
    assert.equal(viewerNames.has("live_toggle"), false);

    const operatorTools = compileMcpTools(allActions, operatorGrant, NOW);
    const opNames = new Set(operatorTools.map((t) => t.name));
    assert.equal(opNames.has("runs_start"), true);
    assert.equal(opNames.has("attempts_rejudge"), true);
    assert.equal(opNames.has("promotions_approve"), false);
    assert.equal(opNames.has("runs_close"), false);

    // Internal principals, forged internal grants, and null/revoked grants get zero tools
    assert.deepEqual(compileMcpTools(allActions, null, NOW), []);
    assert.deepEqual(
      compileMcpTools(allActions, ownerGrant, NOW, { callerKind: "run_worker" }),
      [],
    );
    const forgedGrant = { ...ownerGrant, principalKind: "run_advisor" } as unknown as PolicyGrant;
    assert.deepEqual(compileMcpTools(allActions, forgedGrant, NOW), []);

    // Shared plugin capability validator exported for plugin host reuse
    assert.equal(PLUGIN_SLUG_RE.test("live-publish"), true);
    assert.doesNotThrow(() => assertPluginCapability("live-publish", "live-publish:toggle"));
    assert.throws(() => assertPluginCapability("live-publish", "plugins:manage"));
  });
});

describe("createDoorExecutor", () => {
  it("round-trips every core action with audit emission", async () => {
    const audits: DoorAuditEntry[] = [];
    const door = createDoorExecutor({
      handlers: buildAllCoreHandlers(),
      onAudit: (entry) => {
        audits.push(entry);
      },
    });

    for (const def of CORE_ACTIONS) {
      const output = await door.execute(def.name, SAMPLE_INPUTS[def.name], {
        principalId: "owner-1",
        grant: ownerGrant,
        nowMs: NOW,
      });
      assert.ok(output !== undefined, `output missing for ${def.name}`);
    }

    assert.equal(audits.length, CORE_ACTIONS.length);
    assert.deepEqual(audits[0], {
      principalId: "owner-1",
      principalKind: "owner_session",
      grantId: "g-owner",
      capability: "runs:read",
      action: "campaigns.validate",
      at: NOW,
    });

    // Verify kb.search default include_transcripts=false flowed into handler
    const searchResult = await door.execute(
      "kb.search",
      { query: "vectorize" },
      { principalId: "owner-1", grant: ownerGrant, nowMs: NOW },
    );
    assert.equal(searchResult.hits[0]?.title, "Default search");
  });

  it("supports plugin action registration with strict namespace & collision enforcement", async () => {
    const door = createDoorExecutor({ handlers: buildAllCoreHandlers() });

    const liveToggleDef = defineAction({
      name: "live.toggle",
      summary: "Toggle live streaming on a run.",
      capability: "live-publish:toggle",
      http: { method: "POST", path: "/v1/plugins/live-publish/runs/:runId/toggle" },
      input: z.object({ runId: z.string().min(1), enabled: z.boolean() }),
      output: z.object({ runId: z.string(), enabled: z.boolean() }),
      extractScope: (i) => ({ runId: i.runId }),
    });

    door.registerPluginActions("live-publish", [
      definePluginAction(liveToggleDef, (i) => ({ runId: i.runId, enabled: i.enabled })),
    ]);

    const res = await door.execute(
      "live.toggle",
      { runId: "run-1", enabled: true },
      { principalId: "agent-1", grant: delegateGrant, nowMs: NOW },
    );
    assert.deepEqual(res, { runId: "run-1", enabled: true });

    await assert.rejects(
      () =>
        door.execute(
          "live.toggle",
          { runId: "run-1", enabled: true },
          { principalId: "viewer-1", grant: viewerGrant, nowMs: NOW },
        ),
      (err) => isThermiteError(err) && err.code === "FORBIDDEN",
    );

    // Reject core capability spoofing
    assert.throws(
      () =>
        door.registerPluginActions("bad-plugin", [
          definePluginAction(
            defineAction({
              name: "bad.op",
              summary: "Bad",
              capability: "plugins:manage",
              http: { method: "POST", path: "/v1/plugins/bad/op" },
              input: z.object({}),
              output: z.object({}),
            }),
            () => ({}),
          ),
        ]),
      (err) => isThermiteError(err) && err.code === "VALIDATION_ERROR",
    );

    // Reject cross-plugin namespace spoofing
    assert.throws(
      () =>
        door.registerPluginActions("bad-plugin", [
          definePluginAction(
            defineAction({
              name: "bad.cross",
              summary: "Cross",
              capability: "live-publish:toggle",
              http: { method: "POST", path: "/v1/plugins/bad/cross" },
              input: z.object({}),
              output: z.object({}),
            }),
            () => ({}),
          ),
        ]),
      (err) => isThermiteError(err) && err.code === "VALIDATION_ERROR",
    );

    // Reject core action name collision
    assert.throws(
      () =>
        door.registerPluginActions("collider", [
          definePluginAction(
            defineAction({
              name: "runs.get",
              summary: "Collide",
              capability: "collider:get",
              http: { method: "GET", path: "/v1/plugins/collider/runs" },
              input: z.object({}),
              output: z.object({}),
            }),
            () => ({}),
          ),
        ]),
      (err) => isThermiteError(err) && err.code === "CONFLICT",
    );

    // Unregister removes plugin cleanly
    door.unregisterPluginActions("live-publish");
    assert.equal(door.getAction("live.toggle"), undefined);
  });

  it("enforces auth, internal-principal isolation, scope, and input/output validation", async () => {
    const handlers = buildAllCoreHandlers();
    const door = createDoorExecutor({
      handlers: {
        ...handlers,
        "settings.get": () => ({ settings: "not-an-object" }) as never,
      },
    });

    await assert.rejects(
      () => door.execute("no.such.action", {}, { principalId: "o", grant: ownerGrant, nowMs: NOW }),
      (err) => isThermiteError(err) && err.code === "NOT_FOUND",
    );

    await assert.rejects(
      () =>
        door.execute("runs.get", { runId: "r1" }, { principalId: "anon", grant: null, nowMs: NOW }),
      (err) => isThermiteError(err) && err.code === "UNAUTHORIZED",
    );

    await assert.rejects(
      () =>
        door.execute(
          "runs.close",
          {},
          {
            principalId: "worker-1",
            grant: ownerGrant,
            callerKind: "run_worker",
            nowMs: NOW,
          },
        ),
      (err) => isThermiteError(err) && err.code === "FORBIDDEN",
    );

    await assert.rejects(
      () =>
        door.execute(
          "runs.get",
          { runId: "" },
          {
            principalId: "owner-1",
            grant: ownerGrant,
            nowMs: NOW,
          },
        ),
      (err) => isThermiteError(err) && err.code === "VALIDATION_ERROR",
    );

    const scopedGrant = createGrantFromProfile({
      id: "g-scoped",
      label: "Run 1 only",
      profile: "autonomous_delegate",
      grantedBy: "owner-1",
      scope: { runIds: ["run-1"] },
    });
    await assert.rejects(
      () =>
        door.execute(
          "runs.close",
          { runId: "run-2" },
          {
            principalId: "agent-1",
            grant: scopedGrant,
            nowMs: NOW,
          },
        ),
      (err) => isThermiteError(err) && err.code === "FORBIDDEN",
    );

    // Output schema validation catches malformed handler output
    await assert.rejects(
      () =>
        door.execute(
          "settings.get",
          {},
          {
            principalId: "owner-1",
            grant: ownerGrant,
            nowMs: NOW,
          },
        ),
      (err) => isThermiteError(err) && err.code === "INTERNAL",
    );
  });
});

describe("createThermiteClient", () => {
  it("round-trips GET, POST, PATCH, DELETE with :param interpolation and query/body encoding", async () => {
    const calls: { url: string; init: RequestInit }[] = [];

    const mockFetch: typeof globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });

      if (init.method === "GET" && url.includes("/v1/runs?")) {
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      if (init.method === "GET" && url.includes("/v1/runs/")) {
        return new Response(
          JSON.stringify({
            runId: "run/a b",
            campaignId: "camp-1",
            mode: "goal",
            status: "running",
            live: false,
            createdAt: "2026-11-28T00:00:00Z",
            config: {},
          }),
          { status: 200 },
        );
      }
      if (init.method === "POST" && url.endsWith("/rejudge")) {
        return new Response(JSON.stringify({ runId: "r1", attemptId: "a/2", jobId: "job-7" }), {
          status: 200,
        });
      }
      if (init.method === "PATCH" && url.endsWith("/config")) {
        return new Response(JSON.stringify({ runId: "r1", config: { live: true } }), {
          status: 200,
        });
      }
      if (init.method === "DELETE" && url.includes("/v1/machines/")) {
        return new Response(JSON.stringify({ machineId: "m-1", status: "retired" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const client = createThermiteClient({
      baseUrl: "https://control.example/",
      token: "tok-123",
      fetch: mockFetch,
    });

    // GET with query params
    const list = await client.call("runs.list", {
      campaignId: "camp-1",
      status: "running",
      limit: 25,
    });
    assert.deepEqual(list, { runs: [] });
    assert.equal(
      calls[0]?.url,
      "https://control.example/v1/runs?campaignId=camp-1&status=running&limit=25",
    );
    assert.equal(calls[0]?.init.body, undefined);
    const firstHeaders = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    assert.equal(firstHeaders.authorization, "Bearer tok-123");

    // GET with URL-encoded :param and AbortSignal passthrough
    const ac = new AbortController();
    const run = await client.call("runs.get", { runId: "run/a b" }, { signal: ac.signal });
    assert.equal(run.runId, "run/a b");
    assert.equal(calls[1]?.url, "https://control.example/v1/runs/run%2Fa%20b");
    assert.equal(calls[1]?.init.signal, ac.signal);

    // POST with :param interpolation and remaining JSON body
    const rejudge = await client.call("attempts.rejudge", {
      runId: "r1",
      attemptId: "a/2",
      reason: "check variance",
    });
    assert.equal(rejudge.jobId, "job-7");
    assert.equal(calls[2]?.url, "https://control.example/v1/runs/r1/attempts/a%2F2/rejudge");
    assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), { reason: "check variance" });

    // PATCH with :param and JSON body
    const patched = await client.call("runs.update_config", {
      runId: "r1",
      patch: { live: true },
    });
    assert.deepEqual(patched, { runId: "r1", config: { live: true } });
    assert.equal(calls[3]?.init.method, "PATCH");
    assert.equal(calls[3]?.url, "https://control.example/v1/runs/r1/config");
    assert.deepEqual(JSON.parse(String(calls[3]?.init.body)), { patch: { live: true } });

    // DELETE with :param and query string
    const retired = await client.call("machines.retire", {
      machineId: "m-1",
      reason: "retired",
    });
    assert.deepEqual(retired, { machineId: "m-1", status: "retired" });
    assert.equal(calls[4]?.init.method, "DELETE");
    assert.equal(calls[4]?.url, "https://control.example/v1/machines/m-1?reason=retired");
    assert.equal(calls[4]?.init.body, undefined);

    // Custom plugin action via callAction
    const pluginDef = defineAction({
      name: "distill.preview",
      summary: "Preview distillation.",
      capability: "distill:preview",
      http: { method: "POST", path: "/v1/plugins/distill/preview" },
      input: z.object({ runId: z.string().min(1) }),
      output: z.object({ ok: z.boolean() }),
    });
    const pluginRes = await client.callAction(pluginDef, { runId: "r1" });
    assert.deepEqual(pluginRes, { ok: true });
  });

  it("maps HTTP error payloads into ThermiteError and validates inputs/outputs", async () => {
    let responseQueue: Response[] = [
      new Response(
        JSON.stringify(new ThermiteError("FORBIDDEN", "denied", { cap: "runs:close" }).toJSON()),
        { status: 403 },
      ),
      new Response(JSON.stringify({ error: { code: "CONFLICT", message: "already closed" } }), {
        status: 409,
      }),
      new Response("too many requests", { status: 429 }),
      new Response(JSON.stringify({ bad: "shape" }), { status: 200 }),
    ];

    let fetchCount = 0;
    const client = createThermiteClient({
      baseUrl: "https://control.example",
      fetch: async () => {
        fetchCount += 1;
        const next = responseQueue.shift();
        assert.ok(next);
        return next;
      },
    });

    await assert.rejects(
      () => client.call("runs.close", { runId: "r1" }),
      (err) =>
        isThermiteError(err) &&
        err.code === "FORBIDDEN" &&
        err.status === 403 &&
        err.message === "denied" &&
        (err.details as { cap?: string })?.cap === "runs:close",
    );

    await assert.rejects(
      () => client.call("runs.close", { runId: "r1" }),
      (err) => isThermiteError(err) && err.code === "CONFLICT" && err.message === "already closed",
    );

    await assert.rejects(
      () => client.call("runs.close", { runId: "r1" }),
      (err) => isThermiteError(err) && err.code === "RATE_LIMITED" && err.status === 429,
    );

    await assert.rejects(
      () => client.call("runs.close", { runId: "r1" }),
      (err) => isThermiteError(err) && err.code === "INTERNAL",
    );

    const beforeInvalid = fetchCount;
    await assert.rejects(
      () => client.call("runs.close", { runId: "" }),
      (err) => isThermiteError(err) && err.code === "VALIDATION_ERROR",
    );
    assert.equal(fetchCount, beforeInvalid, "invalid input must fail before fetch");
    responseQueue = [];
  });
});
