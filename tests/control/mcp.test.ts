import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Credential } from "../../src/control/credential.ts";
import { ADMIN, controlOnly, controlStack, mcpClient } from "../helpers/control-stack.ts";

const text = (r: unknown) =>
  JSON.parse(((r as { content: { text: string }[] }).content[0] as { text: string }).text);

describe("control over MCP", () => {
  test("an agent lists rigs and pauses a run; a reader can only read", async () => {
    const { env, store, control, relay } = controlStack({ tokens: { read: "read-token-abcdef" } });
    await env.service.applyCommand(env.assign);
    await relay();

    const agent = await mcpClient(control, ADMIN);
    const tools = (await agent.listTools()).tools.map((t) => t.name).sort();
    assert.ok(tools.includes("issue_command"));
    const rigs = text(await agent.callTool({ name: "list_rigs", arguments: {} }));
    assert.equal(rigs[0].rig, "rig-a");
    assert.equal(rigs[0].runs[0].run, "js-1");
    const issued = text(
      await agent.callTool({
        name: "issue_command",
        arguments: {
          rig: "rig-a",
          kind: "pause_run",
          payload: { run: "js-1", reason: "an agent paused it" },
        },
      }),
    );
    await relay();
    assert.equal(env.ledger.runs.get("js-1")?.status, "paused");
    const status = text(
      await agent.callTool({ name: "command_status", arguments: { id: issued.id } }),
    );
    assert.equal(status.status, "delivered");

    const reader = await mcpClient(control, "read-token-abcdef");
    const readerTools = (await reader.listTools()).tools.map((t) => t.name);
    assert.ok(!readerTools.includes("issue_command"));
    assert.ok(readerTools.includes("list_rigs"));
    assert.ok(readerTools.includes("rig_setup") && readerTools.includes("trial_session"));
    // A reader sees a run's queue, its rules, hand-outs and messages (goal 064).
    const queue = text(await reader.callTool({ name: "run_queue", arguments: { run: "js-1" } }));
    assert.equal(queue.run, "js-1");
    assert.deepEqual(queue.up_next, []);
    assert.ok(Array.isArray(queue.rules));
    // A copied experiment's author comes from the rig's events, never from the caller.
    text(
      await agent.callTool({
        name: "issue_command",
        arguments: {
          rig: "rig-a",
          kind: "queue_add",
          payload: { run: "js-1", title: "unroll the loop" },
        },
      }),
    );
    await relay(); // the command to the harness
    await relay(); // its event back to control
    const known = env.service.queue.all("js-1")[0];
    assert.ok(known);
    const from = (id: string) => ({
      title: "words of the caller's own",
      by: "planner",
      state: "queued",
      from: { run: "js-1", id },
    });
    text(
      await agent.callTool({
        name: "issue_command",
        arguments: {
          rig: "rig-a",
          kind: "assign_campaign",
          payload: {
            ...(env.assign.envelope.payload as Record<string, unknown>),
            run: "js-2",
            queue: [from(known.id), from("x-000000000000")],
          },
        },
      }),
    );
    const signed = store.db
      .prepare("select signed from command where kind = 'assign_campaign'")
      .get() as { signed: string };
    const copied = (
      JSON.parse(signed.signed) as {
        envelope: { payload: { queue: { by: string; title: string }[] } };
      }
    ).envelope.payload.queue;
    // The known one's author and words are control's record; the unknown one is "copied".
    assert.deepEqual(
      copied.map((x) => [x.by, x.title]),
      [
        ["owner", "unroll the loop"],
        ["copied", "words of the caller's own"],
      ],
    );
    const audit = store.auditLog.list(100).map((a) => a.action);
    assert.ok(audit.includes("mcp:issue_command"));
    // A tool the token lacks, and inputs that don't match a tool, are refusals in the log too.
    for (const call of [
      { name: "issue_command", arguments: { rig: "rig-a", kind: "pause_run", payload: {} } },
      { name: "issue_command", arguments: { rig: "rig-a", kind: "pause_run", payload: {} } },
      { name: "control_log", arguments: { limit: "all" } },
    ])
      assert.equal((await reader.callTool(call)).isError, true);
    const refused = store.auditLog
      .list(100, { action: "refused" })
      .filter((a) => a.actor === "reader:mcp")
      .map((a) => [(a.body as { tool: string }).tool, a.count]);
    assert.deepEqual(refused, [
      ["mcp:control_log", 1],
      ["mcp:issue_command", 2],
    ]);
    const denied = await control.request("/mcp", { method: "POST", body: "{}" });
    assert.equal(denied.status, 401);
    await agent.close();
    await reader.close();
  });

  test("an operator messages a run's agents for the owner, never approves; an agent never messages", async () => {
    const { env, store, control, relay } = controlStack({
      tokens: {
        // Deployed as a hash: control holds nothing that signs in as the owner.
        admin: Credential.ofHash(createHash("sha256").update("admin-token-abcdef").digest("hex")),
        operator: "operator-token-abcdef",
        agent: "agent-token-abcdef",
      },
    });
    await env.service.applyCommand(env.assign);
    await relay();
    const issue = async (client: Client, kind: string, payload: Record<string, unknown>) => {
      try {
        const r = (await client.callTool({
          name: "issue_command",
          arguments: { rig: "rig-a", kind, payload },
        })) as { isError?: boolean };
        return r.isError ? undefined : text(r);
      } catch {
        return undefined;
      }
    };
    const operator = await mcpClient(control, "operator-token-abcdef");
    const sent = await issue(operator, "message_agent", {
      run: "js-1",
      to: "planner",
      text: "work on the unmet goals first",
    });
    assert.ok(sent?.id, "the operator may message agents");
    await relay();
    assert.deepEqual(env.service.takePlannerMessages("js-1"), ["work on the unmet goals first"]);
    assert.equal(
      text(await operator.callTool({ name: "command_status", arguments: { id: sent.id } })).status,
      "delivered",
    );
    // A message nothing would read, or with no words, is refused in plain words, as Live greys it.
    await control.request("/v1/rigs/rig-a/supervisor", {
      method: "POST",
      headers: { authorization: "Bearer rig-token-abcdef", "content-type": "application/json" },
      body: JSON.stringify({
        at: new Date().toISOString(),
        advisors: {
          ...{ teacher_runs: 0, directive_sets: 0, directives: 0, audits: 0, reviews: 0 },
          ...{ errors: 0, tokens_in: 0, tokens_out: 0, usd: 0 },
          roles: { teachers: 2, merged_by: true, auditor: false, review_panel: 0 },
        },
      }),
    });
    const refusal = async (payload: Record<string, unknown>) =>
      text(
        await operator.callTool({
          name: "issue_command",
          arguments: { rig: "rig-a", kind: "message_agent", payload: { run: "js-1", ...payload } },
        }),
      ).error;
    assert.equal(
      await refusal({ to: "auditor", text: "check the timer" }),
      "This rig's supervisor has no auditor set up, so nothing would read it.",
    );
    // The review panel by its name (goal 074), and by panel, the name every rig takes.
    for (const to of ["review_panel", "review_panel"])
      assert.equal(
        await refusal({ to, text: "be strict" }),
        "This rig's supervisor has no review panel set up, so nothing would read it.",
        to,
      );
    assert.equal(await refusal({ to: "planner", text: "  \n " }), "Write a message first.");
    assert.ok(
      await issue(operator, "message_agent", { run: "js-1", to: "teachers", text: "cite it" }),
      "the teachers are set up: that one goes",
    );
    assert.equal(
      await issue(operator, "approve_promotion", { run: "js-1", attempt: "a-1" }),
      undefined,
      "approvals stay the owner's",
    );
    const agent = await mcpClient(control, "agent-token-abcdef");
    // A campaign's agents don't read control itself: no log, providers or rig setup details.
    const agentTools = (await agent.listTools()).tools.map((t) => t.name);
    for (const t of ["rig_setup", "control_log", "providers"])
      assert.ok(!agentTools.includes(t), t);
    assert.equal(
      await issue(agent, "message_agent", { run: "js-1", to: "planner", text: "x" }),
      undefined,
      "an agent may not speak for the owner",
    );
    // The queue and the removal of rules are the owner's: an operator changes them for the
    // owner; an agent may add rules, but never changes the queue or removes a rule.
    const queued = () =>
      store.commands
        .list(100)
        .filter((c) => c.kind.startsWith("queue_") || c.kind === "drop_directive").length;
    assert.ok(
      await issue(operator, "queue_add", { run: "js-1", title: "unroll the loop" }),
      "the operator may add an experiment",
    );
    assert.equal(queued(), 1);
    const id = "x-000000000000";
    for (const [kind, payload] of [
      ["queue_add", { run: "js-1", title: "tile the loop" }],
      ["queue_move", { run: "js-1", id, position: "top" }],
      ["queue_edit", { run: "js-1", id, why: "fewer branches" }],
      ["queue_drop", { run: "js-1", id, why: "slower twice" }],
      ["queue_accept", { run: "js-1", id }],
      ["drop_directive", { run: "js-1", id: 1 }],
    ] as const)
      assert.equal(await issue(agent, kind, payload), undefined, `an agent may not ${kind}`);
    assert.equal(queued(), 1, "nothing the agent sent was signed");
    assert.ok(
      await issue(agent, "redirect", {
        run: "js-1",
        directives: [{ kind: "avoid", family: "loop-tiling", rationale: "slower twice" }],
        replace: false,
      }),
      "an agent may add a rule",
    );
    // The owner signs in with the token whose hash control holds.
    const owner = await mcpClient(control, "admin-token-abcdef");
    assert.ok((await owner.listTools()).tools.some((t) => t.name === "issue_command"));
    const wrong = await control.request("/v1/rigs", {
      headers: {
        authorization: `Bearer ${createHash("sha256").update("admin-token-abcdef").digest("hex")}`,
      },
    });
    assert.equal(wrong.status, 401, "the hash itself is not a credential");
    await Promise.all([operator.close(), agent.close(), owner.close()]);
  });

  test("metrics are bounded series with the admin token", async () => {
    const { control } = controlOnly({ tokens: { rigs: {} } });
    assert.equal((await control.request("/metrics")).status, 401);
    const r = await control.request("/metrics", {
      headers: { authorization: "Bearer admin-token-abcdef" },
    });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /# TYPE thermite_rig_up gauge/);
  });

  test("whoever runs control reads its log and its providers over MCP; no key in either; agents don't", async () => {
    const { store, control } = controlOnly({
      tokens: {
        operator: "operator-token-abcdef",
        agent: "agent-token-abcdef",
        read: "read-token-abcdef",
        rigs: {},
      },
    });
    store.gpuClouds.add({
      name: "runpod",
      kind: "runpod",
      key_sealed: "sealed-cloud-key-000",
      key_hint: "…9z9z",
      by: "owner:ui",
    });
    store.gpuClouds.setFacts("runpod", {
      facts: { gpus: [{ id: "a4000", name: "RTX A4000", price_secure: 0.25 }], pods: [] },
    });
    store.auditLog.add("owner:ui", "refused", {
      path: "/ui/settings/add",
      why: "a name is lowercase",
    });
    store.auditLog.add("control", "failed", {
      method: "GET",
      path: "/ui/x",
      status: 500,
      error: "boom",
    });

    const operator = await mcpClient(control, "operator-token-abcdef");
    const providers = text(await operator.callTool({ name: "providers", arguments: {} }));
    assert.equal(providers.gpu_clouds[0].name, "runpod");
    assert.equal(providers.gpu_clouds[0].facts.gpus[0].price_secure, 0.25);
    type Page = {
      entries: { id: number; action: string }[];
      older: number | null;
      newer: number | null;
    };
    const log: Page = text(await operator.callTool({ name: "control_log", arguments: {} }));
    assert.deepEqual(
      log.entries.map((e) => e.action),
      ["failed", "refused", "gpu_cloud_added"],
      "MCP calls are left out unless asked for",
    );
    assert.deepEqual([log.older, log.newer], [null, null], "one page holds them all");
    const refused = text(
      await operator.callTool({ name: "control_log", arguments: { action: "refused" } }),
    );
    assert.equal(refused.entries[0].body.why, "a name is lowercase");
    const all: Page = text(
      await operator.callTool({ name: "control_log", arguments: { include_mcp: true } }),
    );
    assert.ok(all.entries.some((e) => e.action === "mcp:providers"));
    // Paging (goal 015): a page at a time, older then newer, every entry once, filters kept.
    for (let i = 0; i < 5; i++) store.auditLog.add("owner:ui", `step_${i}`, { i });
    const call = async (args: Record<string, unknown>): Promise<Page> =>
      text(await operator.callTool({ name: "control_log", arguments: { limit: 3, ...args } }));
    const newest = await call({});
    assert.deepEqual(
      newest.entries.map((e) => e.action),
      ["step_4", "step_3", "step_2"],
    );
    assert.equal(newest.newer, null);
    const older = await call({ before: newest.older });
    assert.deepEqual(
      older.entries.map((e) => e.action),
      ["step_1", "step_0", "failed"],
      "MCP calls stay out of every page",
    );
    const oldest = await call({ before: older.older });
    assert.deepEqual(
      oldest.entries.map((e) => e.action),
      ["refused", "gpu_cloud_added"],
    );
    assert.equal(oldest.older, null);
    const back = await call({ after: oldest.newer });
    assert.deepEqual(back.entries, older.entries, "newer goes back to the same page");
    const refusedPaging = await operator.callTool({
      name: "control_log",
      arguments: { before: 5, after: 1 },
    });
    assert.equal(refusedPaging.isError, true);
    assert.equal(text(refusedPaging).error, "give before or after, not both");
    const seen = JSON.stringify([providers, all]);
    // Only a key's last characters (its hint, as the dashboard shows it), never the key.
    assert.ok(!seen.includes("sealed-cloud-key"), "never a key");

    const reader = await mcpClient(control, "read-token-abcdef");
    assert.ok((await reader.listTools()).tools.some((t) => t.name === "control_log"));
    const agent = await mcpClient(control, "agent-token-abcdef");
    const agentTools = (await agent.listTools()).tools.map((t) => t.name);
    assert.ok(!["control_log", "providers", "trial_session"].some((t) => agentTools.includes(t)));
    await Promise.all([operator.close(), reader.close(), agent.close()]);
  });

  test("an operator gives a rig's agents a model over MCP, as Edit rig does; a wrong model is refused", async () => {
    const { store, control } = controlOnly({
      tokens: { operator: "operator-token-abcdef", rigs: {} },
    });
    store.db
      .prepare(
        "insert into rig (id, first_seen, last_seen, ledger_id, summary, report_at) values (?, ?, ?, null, '{}', ?)",
      )
      .run("cpu-1", new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    store.modelProviders.put({
      name: "zen",
      type: "opencode",
      base_url: "https://opencode.ai/zen/v1",
    });
    store.modelProviders.setModels("zen", [{ id: "deepseek-v4.1-flash-free" }]);
    const operator = await mcpClient(control, "operator-token-abcdef");
    const r = text(
      await operator.callTool({
        name: "set_rig_model",
        arguments: { rig: "cpu-1", provider: "zen", model: "deepseek-v4.1-flash-free" },
      }),
    );
    assert.equal(r.model, "deepseek-v4.1-flash-free");
    assert.deepEqual(store.agentModels.byRig()["cpu-1"], {
      provider: "zen",
      model: "deepseek-v4.1-flash-free",
      harness: "opencode",
    });
    const wrong = (await operator.callTool({
      name: "set_rig_model",
      arguments: { rig: "cpu-1", provider: "zen", model: "no-such-model" },
    })) as { isError?: boolean };
    assert.ok(wrong.isError);
    // The Codex CLI, for a provider OpenAI's Responses API reaches; never for OpenCode's own.
    store.modelProviders.put({
      name: "openai",
      type: "openai",
      base_url: "https://api.openai.com/v1",
      key: { sealed: "s1:not-opened-here", hint: "…abcd" },
    });
    store.modelProviders.setModels("openai", [{ id: "gpt-test" }]);
    const codex = text(
      await operator.callTool({
        name: "set_rig_model",
        arguments: { rig: "cpu-1", provider: "openai", model: "gpt-test", harness: "codex" },
      }),
    );
    assert.match(String(codex.said), /cpu-1 takes gpt-test from "openai" under Codex/);
    assert.equal(store.agentModels.byRig()["cpu-1"]?.harness, "codex");
    const notCodex = await operator.callTool({
      name: "set_rig_model",
      arguments: {
        rig: "cpu-1",
        provider: "zen",
        model: "deepseek-v4.1-flash-free",
        harness: "codex",
      },
    });
    assert.equal(notCodex.isError, true);
    assert.match(JSON.stringify(notCodex), /Codex runs only with a ChatGPT subscription/);
    assert.equal(
      store.agentModels.byRig()["cpu-1"]?.harness,
      "codex",
      "the refused call changed nothing",
    );
    await operator.close();
  });
});
