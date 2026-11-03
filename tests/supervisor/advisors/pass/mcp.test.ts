import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { McpGateway } from "../../../../src/agents/mcp/gateway.ts";
import { McpServers } from "../../../../src/control/mcp-servers/index.ts";
import { SecretBox } from "../../../../src/control/secrets.ts";
import type { McpUse } from "../../../../src/core/mcp.ts";
import { AdvisorsConfig } from "../../../../src/supervisor/advisors/index.ts";
import {
  type AdviseConfig,
  adviseOnce,
  emptyAdviseState,
} from "../../../../src/supervisor/advisors/pass/index.ts";
import { serveAdvisorTools } from "../../../../src/supervisor/advisors/tools/mcp.ts";
import { handMcpServers } from "../../../../src/supervisor/mcp-sync.ts";
import { assigned } from "../../../helpers/assignments.ts";
import { controlStack, SUPERVISOR_TOKEN } from "../../../helpers/control-stack.ts";
import { startFakeMcp } from "../../../helpers/fake-mcp.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

/** A made-up key: it reaches the fake server's headers only, never a model or the harness's disk. */
const KEY = "Bearer advisorkeyforthetestsonly";
const RUN = "js-1";
const USES: McpUse[] = [
  { name: "gbrain", agents: ["workers", "advisors"] },
  { name: "papers", agents: ["advisors"], tools: { advisors: ["search"] } },
];

async function world(t: TestContext) {
  const fake = await startFakeMcp({ kind: "bearer", token: KEY.slice(7) });
  t.after(() => fake.close());
  const secrets = SecretBox.ephemeral();
  const { env, store, harness, fetchImpl, rigConfig } = controlStack({
    env: makeJudgeEnv({ kitMcpServers: USES, assign: { mcp_servers: USES } }),
    tokens: { rigs: { "rig-a": "rig-token-aaaaaa" } },
    options: (store) => {
      const servers = new McpServers(store, secrets);
      servers.put({ name: "gbrain", url: fake.url, auth: "key", secret: KEY }, "owner:test");
      servers.put({ name: "papers", url: fake.url, auth: "key", secret: KEY }, "owner:test");
      return { secrets, mcpServers: servers };
    },
  });
  assigned(store, "rig-a", RUN, "js", { mcp_servers: USES });
  await env.service.applyCommand(env.assign);
  return { fake, env, harness, fetchImpl, rigConfig };
}

describe("the supervisor and the MCP servers control gives the rig", () => {
  test("the harness gets its workers' share; the advisors' stays with the supervisor", async (t) => {
    const { harness, fetchImpl, rigConfig } = await world(t);
    // What the rig's config on the bus gives, handed to the harness.
    const sync = async () =>
      handMcpServers(
        { harnessUrl: "http://harness", harnessToken: SUPERVISOR_TOKEN, fetchImpl },
        (await rigConfig("mcp-servers")) as never,
      );
    const r = await sync();
    assert.equal(r.handed, "set");
    assert.deepEqual(
      r.servers.map((s) => [s.name, s.agents]),
      [
        ["gbrain", ["workers", "advisors"]],
        ["papers", ["advisors"]],
      ],
    );
    const held = await (
      await harness.request("/v1/mcp-servers", {
        headers: { authorization: `Bearer ${SUPERVISOR_TOKEN}` },
      })
    ).text();
    assert.deepEqual(
      (JSON.parse(held) as { servers: { name: string }[] }).servers.map((s) => s.name),
      ["gbrain"],
    );
    assert.ok(!held.includes("advisorkey"));
    assert.equal((await sync()).handed, "unchanged");
  });

  test("an advisor calls the tools its kit gives it, through the supervisor; an open fetch gets none", async (t) => {
    const { fake, harness } = await world(t);
    const gateway = new McpGateway({
      uses: (run) => uses.get(run) ?? [],
      record: () => undefined,
    });
    const uses = new Map<string, McpUse[]>();
    gateway.set(
      [
        {
          name: "gbrain",
          url: fake.url,
          headers: { Authorization: KEY },
          revision: "r1",
          agents: ["advisors"],
        },
        {
          name: "papers",
          url: fake.url,
          headers: { Authorization: KEY },
          revision: "r2",
          agents: ["advisors"],
        },
      ],
      [],
    );
    const offered: string[][] = [];
    const seen: string[] = [];
    const model = await startFakeModel(({ messages, tools }) => {
      const names = tools.map((x) => x.function.name);
      offered.push(names);
      seen.push(JSON.stringify(messages));
      if (names.includes("mcp__gbrain__search") && messages.at(-1)?.role !== "tool")
        return { toolCalls: [{ name: "mcp__gbrain__search", args: { query: "first" } }] };
      return { toolCalls: [{ name: "answer", args: { summary: "fine", recommendations: [] } }] };
    });
    t.after(() => model.close());
    const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
    writeFileSync(join(dir, "key"), "test-key\n");
    const config = (fetch_domains: string[]): AdviseConfig => ({
      harnessUrl: "http://harness",
      harnessToken: SUPERVISOR_TOKEN,
      home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
      advisors: AdvisorsConfig.parse({
        teachers: [
          {
            name: "teacher-a",
            runtime: "openai",
            base_url: model.url,
            model: "m",
            api_key_file: join(dir, "key"),
          },
        ],
        fetch_domains,
      }),
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        return harness.request(`${url.pathname}${url.search}`, init as RequestInit);
      },
      mcp: { gateway, uses },
    });
    const s = await adviseOnce(config([]), emptyAdviseState());
    assert.equal(s.stats.teacher_runs, 1);
    // Both servers' tools, papers narrowed to search; the call reached the server with its key.
    assert.deepEqual(offered[0]?.filter((n) => n.startsWith("mcp__")).sort(), [
      "mcp__gbrain__get_page",
      "mcp__gbrain__put_page",
      "mcp__gbrain__search",
      "mcp__papers__search",
    ]);
    assert.equal(fake.calls.at(-1)?.tool, "search");
    assert.ok(fake.requests.every((r) => r.headers.authorization === KEY));
    assert.ok(seen.join("\n").includes("notes/start"), "the tool's answer reached the model");
    assert.ok(!seen.join("\n").includes("advisorkey"), "the key never did");
    // Advisors that may fetch any page get no MCP server, and the run's live view says so once.
    offered.length = 0;
    const lines: string[] = [];
    const open = await adviseOnce(
      { ...config(["*"]), live: (l) => lines.push(l.text) },
      emptyAdviseState(),
    );
    assert.equal(open.stats.teacher_runs, 1);
    assert.ok(!offered.flat().some((n) => n.startsWith("mcp__")));
    assert.ok(lines.some((l) => /get no MCP server: gbrain, papers/.test(l)));
  });

  test("Claude Code advisors get each server on localhost, and permission for its tools only", async () => {
    const local = await serveAdvisorTools({
      mcp: {
        servers: ["gbrain"],
        serverFor: () => {
          throw new Error("not called here");
        },
      },
    });
    try {
      const config = JSON.parse(local.args[1] ?? "{}") as {
        mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
      };
      assert.deepEqual(Object.keys(config.mcpServers), ["gbrain"]);
      assert.match(config.mcpServers.gbrain?.url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/mcp\/gbrain$/);
      assert.ok(!JSON.stringify(config).includes("advisorkey"));
      assert.deepEqual(local.args.slice(2), ["--allowedTools", "mcp__gbrain"]);
      // A request without the call's own token, or with another, reaches nothing.
      assert.equal(
        (await fetch(config.mcpServers.gbrain?.url ?? "", { method: "POST" })).status,
        401,
      );
      for (const other of [`Bearer ${local.token.slice(1)}x`, `Bearer ${local.token}x`])
        assert.equal(
          (
            await fetch(config.mcpServers.gbrain?.url ?? "", {
              method: "POST",
              headers: { authorization: other },
            })
          ).status,
          401,
        );
    } finally {
      await local.close();
    }
  });
});
