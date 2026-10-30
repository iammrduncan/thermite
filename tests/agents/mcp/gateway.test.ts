import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, type TestContext, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpGateway } from "../../../src/agents/mcp/gateway.ts";
import { claudeMcpConfig } from "../../../src/agents/mcp/tools.ts";
import { claudeArgs } from "../../../src/agents/programs/claude-code/index.ts";
import { codexConfig, codexEnv } from "../../../src/agents/programs/codex/index.ts";
import { opencodeConfig } from "../../../src/agents/programs/opencode/index.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { startFakeMcp } from "../../helpers/fake-mcp.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/** A made-up key: it must reach the fake server's headers only, never an agent. */
const KEY = "Bearer gatewaykeyforthetestsonly";
const RUN = "js-1";
const tokens = { supervisor: "sup-token-abcdef" };
const USES = [
  { name: "gbrain", agents: ["workers", "planner"], tools: { planner: ["search"] } },
  { name: "elsewhere", agents: ["workers"] },
];

async function setup(t: TestContext) {
  const fake = await startFakeMcp({ kind: "bearer", token: KEY.slice(7) });
  t.after(() => fake.close());
  const env = makeJudgeEnv({ kitMcpServers: USES, assign: { mcp_servers: USES } });
  const out = (await env.service.applyCommand(env.assign)) as { accepted?: boolean };
  assert.equal(out.accepted, true);
  const api = createHarnessApi(env.service, tokens);
  const sup = { authorization: `Bearer ${tokens.supervisor}`, "content-type": "application/json" };
  const handed = await api.request("/v1/mcp-servers", {
    method: "PUT",
    headers: sup,
    body: JSON.stringify({
      servers: [
        {
          name: "gbrain",
          url: fake.url,
          headers: { Authorization: KEY },
          revision: "r1",
          agents: ["workers", "planner"],
        },
      ],
      unavailable: [{ name: "elsewhere", why: "control can't sign in to it: its sign-in ended" }],
    }),
  });
  assert.equal(handed.status, 200);
  const token = randomBytes(16).toString("hex");
  new Registry(env.service.ledger).startTrial({
    id: "t-0001",
    run: RUN,
    lane: "lane-1",
    epoch: 1,
    family: "f",
    parent: env.seed,
    token,
  });
  return { fake, env, api, sup, worker: { authorization: `Bearer trial.${token}` } };
}

const events = (env: ReturnType<typeof makeJudgeEnv>, kind: string) =>
  (
    env.service.ledger.db
      .prepare("select body from event where kind = ? and subject = ?")
      .all(kind, RUN) as { body: string }[]
  ).map((r) => JSON.parse(r.body));

describe("a run's kit names its MCP servers", () => {
  test("the assignment must name the same servers; the run records them", async () => {
    const env = makeJudgeEnv({ kitMcpServers: USES });
    const refused = (await env.service.applyCommand(env.assign)) as {
      accepted?: boolean;
      result?: { error?: string };
    };
    assert.equal(refused.accepted, false);
    assert.match(
      refused.result?.error ?? "",
      /the kit names the MCP servers elsewhere \(workers\), gbrain \(workers; planner: search\), and the assignment names none/,
    );
    const ok = makeJudgeEnv({ kitMcpServers: USES, assign: { mcp_servers: USES } });
    assert.equal(
      ((await ok.service.applyCommand(ok.assign)) as { accepted?: boolean }).accepted,
      true,
    );
    assert.deepEqual(
      ok.service.mcpUses(RUN).map((u) => [u.name, u.agents]),
      [
        ["elsewhere", ["workers"]],
        ["gbrain", ["workers", "planner"]],
      ],
    );
    assert.equal(events(ok, "mcp_servers").length, 1);
  });
});

describe("the harness's MCP gateway", () => {
  test("a worker lists and calls its tools with its trial's token; the sign-in never reaches it", async (t) => {
    const { fake, api, sup, worker } = await setup(t);
    // The supervisor reads back revisions only.
    const info = await (await api.request("/v1/mcp-servers", { headers: sup })).text();
    assert.ok(info.includes("r1") && !info.includes("gatewaykey"));
    const listed = await api.request("/v1/mcp-tools", { headers: worker });
    const body = await listed.text();
    assert.ok(!body.includes("gatewaykey"));
    const tools = JSON.parse(body) as {
      tools: { server: string; name: string; reads: boolean }[];
      unavailable: { server: string; why: string }[];
    };
    assert.deepEqual(
      tools.tools.map((x) => [x.server, x.name, x.reads]),
      [
        ["gbrain", "search", true],
        ["gbrain", "get_page", true],
        ["gbrain", "put_page", false],
      ],
    );
    assert.deepEqual(tools.unavailable, [
      { server: "elsewhere", why: "control can't sign in to it: its sign-in ended" },
    ]);
    const called = await api.request("/v1/mcp-call", {
      method: "POST",
      headers: { ...worker, "content-type": "application/json" },
      body: JSON.stringify({
        server: "gbrain",
        tool: "put_page",
        arguments: { slug: "a", content: "b" },
      }),
    });
    assert.equal(called.status, 200);
    assert.equal(fake.pages.get("a"), "b");
    // The key went to the server, in its header, from the harness alone.
    assert.ok(fake.requests.every((r) => r.headers.authorization === KEY));
    // No token, or an ended trial's: nothing.
    assert.equal((await api.request("/v1/mcp-tools")).status, 401);
    assert.equal(
      (await api.request("/v1/mcp-tools", { headers: { authorization: "Bearer trial.nope" } }))
        .status,
      401,
    );
  });

  test("OpenCode, Claude Code and Codex reach a server as an MCP endpoint at the gateway", async (t) => {
    const { fake, api, worker } = await setup(t);
    const client = new Client({ name: "agent", version: "1.0.0" });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      headers.set("authorization", worker.authorization);
      return api.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
    };
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://harness/v1/mcp/gbrain"), {
        fetch: fetchImpl,
      }),
    );
    assert.deepEqual(
      (await client.listTools()).tools.map((x) => x.name),
      ["search", "get_page", "put_page"],
    );
    const r = (await client.callTool({ name: "search", arguments: { query: "first" } })) as {
      content: { text: string }[];
    };
    assert.match(r.content[0]?.text ?? "", /notes\/start/);
    assert.equal(fake.calls.at(-1)?.tool, "search");
    await client.close();
    // Their configuration points at the gateway with the trial's token: never the server's key.
    const access = { apiUrl: "http://127.0.0.1:8700", auth: "trial.abc", servers: ["gbrain"] };
    const oc = JSON.stringify(
      opencodeConfig(
        { api: "openai", baseUrl: "x", model: "m", apiKey: "", contextWindow: 0, maxTokens: 0 },
        "p",
        access,
      ),
    );
    assert.match(oc, /"url":"http:\/\/127.0.0.1:8700\/v1\/mcp\/gbrain"/);
    assert.match(oc, /"Authorization":"Bearer trial.abc"/);
    assert.match(oc, /"oauth":false/);
    assert.match(
      claudeMcpConfig(access) ?? "",
      /"type":"http","url":"http:\/\/127.0.0.1:8700\/v1\/mcp\/gbrain"/,
    );
    const args = claudeArgs(
      { api: "claude", baseUrl: "x", model: "m", apiKey: "", contextWindow: 0, maxTokens: 0 },
      { mcpConfig: "/area/claude-home/mcp.json" },
    );
    assert.deepEqual(
      args.slice(args.indexOf("--strict-mcp-config"), args.indexOf("--strict-mcp-config") + 3),
      ["--strict-mcp-config", "--mcp-config", "/area/claude-home/mcp.json"],
    );
    // Codex: each server at the gateway, its token from the environment, none required to start.
    const cx = codexConfig(
      { api: "openai", baseUrl: "x", model: "m", apiKey: "", contextWindow: 0, maxTokens: 0 },
      "http://127.0.0.1:8700/v1/model-proxy",
      { apiUrl: "http://127.0.0.1:8700", servers: ["gbrain"] },
    );
    assert.match(
      cx,
      /\[mcp_servers\.gbrain\]\nurl = "http:\/\/127\.0\.0\.1:8700\/v1\/mcp\/gbrain"\nbearer_token_env_var = "THERMITE_MCP_AUTH"\nrequired = false/,
    );
    assert.ok(!cx.includes("trial."));
    const env = codexEnv({
      home: "/h",
      apiUrl: "a",
      auth: "trial.abc",
      proxyAuth: "trial.abc",
      mcpAuth: "trial.abc",
      tmp: "/t",
    });
    assert.equal(env.THERMITE_MCP_AUTH, "trial.abc");
    assert.equal(
      codexEnv({ home: "/h", apiUrl: "a", auth: "", proxyAuth: "p", tmp: "/t" }).THERMITE_MCP_AUTH,
      undefined,
    );
  });

  test("the planner gets only the tools its kit gives it", async (t) => {
    const { env, api } = await setup(t);
    const planner = {
      authorization: `Bearer ${env.service.mintMcpToken({ run: RUN, kind: "planner", source: "planner" })}`,
    };
    const listed = (await (await api.request("/v1/mcp-tools", { headers: planner })).json()) as {
      tools: { name: string }[];
    };
    assert.deepEqual(
      listed.tools.map((x) => x.name),
      ["search"],
    );
    const refused = (await (
      await api.request("/v1/mcp-call", {
        method: "POST",
        headers: { ...planner, "content-type": "application/json" },
        body: JSON.stringify({
          server: "gbrain",
          tool: "put_page",
          arguments: { slug: "x", content: "y" },
        }),
      })
    ).json()) as { isError?: boolean; content: { text: string }[] };
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]?.text ?? "", /does not give the planner the tool put_page/);
  });

  test("a server that fails: the agent goes on, and the history says so once, and when it is back", async (t) => {
    const { fake, env, api, worker } = await setup(t);
    const call = async () =>
      (await (
        await api.request("/v1/mcp-call", {
          method: "POST",
          headers: { ...worker, "content-type": "application/json" },
          body: JSON.stringify({ server: "gbrain", tool: "search", arguments: { query: "x" } }),
        })
      ).json()) as { isError?: boolean; content: { text: string }[] };
    fake.down = true;
    const failed = await call();
    assert.equal(failed.isError, true);
    assert.match(failed.content[0]?.text ?? "", /The MCP server gbrain failed: .*Go on without it/);
    assert.ok(!JSON.stringify(failed).includes("gatewaykey"));
    await call();
    // Listing records the server the rig did not get: once.
    await api.request("/v1/mcp-tools", { headers: worker });
    await api.request("/v1/mcp-tools", { headers: worker });
    const down = events(env, "mcp_server_failed");
    assert.deepEqual(
      down.map((e) => [e.server, e.agents]),
      [
        ["gbrain", "workers"],
        ["elsewhere", "workers"],
      ],
    );
    assert.ok(!JSON.stringify(down).includes("gatewaykey"));
    fake.down = false;
    assert.equal((await call()).isError, undefined);
    assert.deepEqual(events(env, "mcp_server_back"), [{ server: "gbrain", agents: "workers" }]);
    // The supervisor reports the advisors' failures the same way.
    const sup = {
      authorization: `Bearer ${tokens.supervisor}`,
      "content-type": "application/json",
    };
    await api.request("/v1/mcp-events", {
      method: "POST",
      headers: sup,
      body: JSON.stringify({ run: RUN, server: "gbrain", ok: false, error: "HTTP 503" }),
    });
    assert.deepEqual(events(env, "mcp_server_failed").at(-1), {
      server: "gbrain",
      agents: "advisors",
      error: "HTTP 503",
    });
    // Live says each failure once: the workers' here, the advisors' in the supervisor's own Live.
    const said = env.service.live.since(0).entries.map((e) => e.text);
    assert.equal(
      said.filter((x) => /^the MCP server gbrain failed: .*The workers go on without it\.$/.test(x))
        .length,
      1,
    );
    assert.deepEqual(
      said.filter((x) => /HTTP 503/.test(x)),
      [],
    );
  });

  test("a list is kept a few minutes; fresh asks the servers now (the Pi view's /mcp reconnect)", async (t) => {
    const { fake, api, worker } = await setup(t);
    const list = async (query = "") => {
      const before = fake.requests.length;
      const r = await api.request(`/v1/mcp-tools${query}`, { headers: worker });
      const body = (await r.json()) as { tools: { server: string; name: string }[] };
      return { asked: fake.requests.length > before, tools: body.tools.map((x) => x.name) };
    };
    const first = await list();
    assert.ok(first.asked);
    assert.ok(first.tools.includes("search"));
    assert.equal((await list()).asked, false, "kept");
    assert.equal((await list("?fresh=all")).asked, true, "every server, now");
    assert.equal((await list("?fresh=gbrain")).asked, true, "that server, now");
    assert.equal((await list("?fresh=elsewhere")).asked, false, "another server's: gbrain's kept");
  });

  test("a failure in words: once, with the verb for its kind of agent", async () => {
    const said: string[] = [];
    const recorded: string[] = [];
    const gw = new McpGateway({
      uses: () => [{ name: "gbrain", agents: ["planner"] }],
      record: (_run, kind) => recorded.push(kind),
      say: (_source, _run, text) => said.push(text),
    });
    const planner = { run: RUN, kind: "planner" as const, source: "planner" };
    // The planner's server, which control has not handed the rig: in Live once.
    assert.equal(
      await gw.serverTools(planner, "gbrain"),
      "control has not given it to this rig yet",
    );
    await gw.serverTools(planner, "gbrain");
    assert.deepEqual(said, [
      "the MCP server gbrain failed: control has not given it to this rig yet. The planner goes on without it.",
    ]);
    assert.equal(
      await gw.serverTools(planner, "papers"),
      "the planner of this run does not get papers",
    );
    // The supervisor's report of an advisor's failure: in the history, not again in Live.
    gw.report({ run: RUN, kind: "advisors", source: "supervisor" }, "papers", false, "HTTP 500");
    gw.report({ run: RUN, kind: "advisors", source: "supervisor" }, "papers", true);
    assert.equal(said.length, 1);
    assert.deepEqual(recorded, ["mcp_server_failed", "mcp_server_failed", "mcp_server_back"]);
  });
});
