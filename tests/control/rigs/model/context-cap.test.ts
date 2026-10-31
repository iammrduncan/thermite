import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cappedWindow,
  capWords,
  contextCapRefusal,
} from "../../../../src/control/providers/models.ts";
import { SecretBox } from "../../../../src/control/secrets.ts";
import {
  ADMIN,
  controlOnly,
  mcpClient,
  RIG_TOKEN,
  signIn,
} from "../../../helpers/control-stack.ts";
import { ingestReport } from "../../../helpers/control-store.ts";

/**
 * A cap on the context window of a rig's model (goal 070): REST's POST /v1/rigs/<rig>/model and
 * MCP's set_rig_model take it, control keeps it with the rig's model, and the rig's model route
 * carries the lower of the cap and the provider's window.
 */

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  rigs: { "rig-a": RIG_TOKEN },
};

/**
 * Control with rig-a reporting that it runs wide-model from "lab". The provider lists wide-model
 * at 204,800 tokens, narrow-model at 131,072, and open-model with no window. The owner is signed
 * in on the dashboard.
 */
async function stack() {
  const secrets = SecretBox.ephemeral();
  const { store, control, api, rigConfig } = controlOnly({
    tokens: TOKENS,
    options: { staleAfterMs: 600_000, secrets },
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
    { id: "open-model" },
  ]);
  const give = (body: Record<string, unknown>) => api("POST", "/v1/rigs/rig-a/model", body);
  const route = async () =>
    (
      (await rigConfig("model-route")) as unknown as {
        route: { context_window: number; revision: string };
      }
    ).route;
  const { page, post } = await signIn(control);
  return { store, control, give, route, page, post, rigConfig };
}

const text = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]?.text ?? "{}") as Record<
    string,
    unknown
  >;

describe("a cap on a rig's model context window", () => {
  test("the window a route carries, and the words for it", () => {
    assert.equal(cappedWindow(204_800, 131_072), 131_072);
    assert.equal(cappedWindow(204_800, undefined), 204_800);
    assert.equal(cappedWindow(204_800, 204_800), 204_800);
    // A provider's list can shrink after the cap was set: the lower one wins.
    assert.equal(cappedWindow(100_000, 131_072), 100_000);
    assert.equal(cappedWindow(0, 65_536), 65_536, "no provider window: the cap as given");
    assert.equal(cappedWindow(0, undefined), 0);
    assert.equal(contextCapRefusal("m", 204_800, 131_072), undefined);
    assert.equal(contextCapRefusal("m", 204_800, 204_801), "m takes at most 204,800 tokens.");
    assert.equal(contextCapRefusal("m", 0, 1_000_000), undefined);
    for (const bad of [4095, 0, -1, 1.5, 100_000_001])
      assert.match(String(contextCapRefusal("m", 0, bad)), /from 4,096 to 100,000,000/);
    assert.equal(
      capWords(204_800, 131_072),
      "131,072 tokens (capped; the provider allows 204,800)",
    );
    assert.equal(capWords(0, 65_536), "65,536 tokens (capped; the provider lists no window)");
    assert.equal(
      capWords(204_800, 204_800),
      undefined,
      "a cap at the provider's window caps nothing",
    );
    assert.equal(capWords(204_800, undefined), undefined);
  });

  test("the route's reply limit is the model's maximum output from the provider's list; none listed, none sent (goal 079)", async () => {
    const s = await stack();
    await s.give({ provider: "lab", model: "wide-model" });
    const plain = (await s.route()) as { max_tokens?: number; revision: string };
    assert.equal(plain.max_tokens, 0, "none listed: 0, and the rig sends none");
    s.store.modelProviders.setModels("lab", [
      { id: "wide-model", context_window: 204_800, max_output: 64_000 },
    ]);
    const listed = (await s.route()) as { max_tokens?: number; revision: string };
    assert.equal(listed.max_tokens, 64_000);
    assert.notEqual(listed.revision, plain.revision, "the rig takes the new limit");
  });

  test("REST: a cap below the provider's window goes into the route; above it is refused; none means the provider's", async () => {
    const s = await stack();
    const capped = await s.give({ provider: "lab", model: "wide-model", context_window: 131_072 });
    assert.equal(capped.status, 200);
    const body = (await capped.json()) as Record<string, unknown>;
    assert.equal(body.context_window, 131_072);
    assert.match(
      String(body.said),
      /rig-a takes wide-model from "lab" under Pi within a minute, and checks it\. Its context window: 131,072 tokens \(capped; the provider allows 204,800\)\./,
    );
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.contextCap, 131_072);
    const first = await s.route();
    assert.equal(first.context_window, 131_072);

    const over = await s.give({ provider: "lab", model: "wide-model", context_window: 300_000 });
    assert.equal(over.status, 400);
    assert.deepEqual(await over.json(), { error: "wide-model takes at most 204,800 tokens." });
    const low = await s.give({ provider: "lab", model: "wide-model", context_window: 1024 });
    assert.equal(low.status, 400);
    assert.match(JSON.stringify(await low.json()), /from 4,096 to 100,000,000/);
    assert.equal(
      s.store.agentModels.byRig()["rig-a"]?.contextCap,
      131_072,
      "a refusal changes nothing",
    );

    // Given again without a cap: the cap goes, and the route carries the provider's window anew.
    const plain = await s.give({ provider: "lab", model: "wide-model" });
    assert.equal(((await plain.json()) as { context_window: number }).context_window, 204_800);
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.contextCap, undefined);
    const uncapped = await s.route();
    assert.equal(uncapped.context_window, 204_800);
    assert.notEqual(uncapped.revision, first.revision, "the rig takes the new window");

    // A provider that lists no window: the cap as given.
    await s.give({ provider: "lab", model: "open-model", context_window: 65_536 });
    assert.equal((await s.route()).context_window, 65_536);

    assert.equal((await s.give({ provider: "lab", model: "no-such" })).status, 400);
    const strange = await s.give({ provider: "lab", model: "wide-model", context_window: "big" });
    assert.equal(strange.status, 400);
    assert.match(JSON.stringify(await strange.json()), /bad request: context_window/);
    const noRig = await s.control.request("/v1/rigs/rig-z/model", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.admin}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "lab", model: "wide-model" }),
    });
    assert.equal(noRig.status, 404);
    const operator = await s.control.request("/v1/rigs/rig-a/model", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.operator}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "lab", model: "wide-model" }),
    });
    assert.ok(operator.status === 401 || operator.status === 403, "REST takes the owner's token");
    const given = s.store.auditLog
      .list(50, { action: "rig_model_given" })
      .map((e) => (e.body as { context_cap: number | null }).context_cap);
    assert.deepEqual(given.reverse(), [131_072, null, 65_536]);
  });

  test("MCP: set_rig_model takes context_window, refuses one above the provider's, and drops the cap when left out", async () => {
    const s = await stack();
    const mcp = await mcpClient(s.control, TOKENS.operator);
    const r = text(
      await mcp.callTool({
        name: "set_rig_model",
        arguments: { rig: "rig-a", provider: "lab", model: "wide-model", context_window: 131_072 },
      }),
    );
    assert.equal(r.context_window, 131_072);
    assert.match(String(r.said), /131,072 tokens \(capped; the provider allows 204,800\)/);
    assert.equal((await s.route()).context_window, 131_072);
    const over = await mcp.callTool({
      name: "set_rig_model",
      arguments: { rig: "rig-a", provider: "lab", model: "narrow-model", context_window: 204_800 },
    });
    assert.equal(over.isError, true);
    assert.match(JSON.stringify(over), /narrow-model takes at most 131,072 tokens\./);
    assert.equal(
      s.store.agentModels.byRig()["rig-a"]?.model,
      "wide-model",
      "the refused call changed nothing",
    );
    const plain = text(
      await mcp.callTool({
        name: "set_rig_model",
        arguments: { rig: "rig-a", provider: "lab", model: "wide-model" },
      }),
    );
    assert.equal(plain.context_window, 204_800);
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.contextCap, undefined);
    await mcp.close();
  });

  test("the dashboard shows the cap, and its forms keep it while the rig keeps the same model", async () => {
    const s = await stack();
    await s.give({ provider: "lab", model: "wide-model", context_window: 131_072 });
    const settings = await s.page("/ui/settings");
    assert.match(
      settings,
      /Its agents run under Pi with wide-model from lab\. Its context window: 131,072 tokens \(capped; the provider allows 204,800\)\./,
    );
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(settings)?.[1] ?? "";
    // Providers' Use with the same model: its form has no field for the cap.
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      harness: "opencode",
      choice: "lab|wide-model",
    });
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.harness, "opencode");
    assert.equal(
      s.store.agentModels.byRig()["rig-a"]?.contextCap,
      131_072,
      "kept with the same model",
    );
    // Another model: the cap was for the one before.
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      harness: "pi",
      choice: "lab|narrow-model",
    });
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.contextCap, undefined);
    assert.equal((await s.route()).context_window, 131_072);
    assert.doesNotMatch(await s.page("/ui/settings"), /capped/);
  });
});

describe("the compaction point of a rig's model (goal 070)", () => {
  const routeOf = async (s: Awaited<ReturnType<typeof stack>>) =>
    (await s.route()) as unknown as { compact_at?: number; revision: string };

  test("REST: compact_at is kept with the model, carried in the route, shown, and refused out of range in words", async () => {
    const s = await stack();
    const plain = await s.give({ provider: "lab", model: "wide-model" });
    assert.equal(((await plain.json()) as { compact_at: unknown }).compact_at, null);
    const before = await routeOf(s);
    assert.equal(before.compact_at, undefined, "no point set: the harness's default");

    const set = await s.give({ provider: "lab", model: "wide-model", compact_at: 70 });
    assert.equal(set.status, 200);
    const body = (await set.json()) as Record<string, unknown>;
    assert.equal(body.compact_at, 70);
    assert.match(String(body.said), /Its conversations are compacted at 70% of the window\./);
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.compactAt, 70);
    const route = await routeOf(s);
    assert.equal(route.compact_at, 70);
    assert.notEqual(route.revision, before.revision, "the rig takes the new point");
    const read = (await (
      await s.control.request("/v1/rigs/rig-a/model", {
        headers: { authorization: `Bearer ${TOKENS.admin}` },
      })
    ).json()) as { agents: { workers: { compact_at: number | null } } };
    assert.equal(read.agents.workers.compact_at, 70);

    for (const bad of [49, 96, 80.5, 0]) {
      const r = await s.give({ provider: "lab", model: "wide-model", compact_at: bad });
      assert.equal(r.status, 400, String(bad));
      assert.deepEqual(await r.json(), {
        error: "The compaction point is a whole percent of the context window, from 50 to 95.",
      });
    }
    // The planner with its own model takes its own point (goal 070), out of range refused alike.
    const badPlanner = await s.give({
      agent: "planner",
      provider: "lab",
      model: "wide-model",
      compact_at: 99,
    });
    assert.equal(badPlanner.status, 400);
    assert.match(JSON.stringify(await badPlanner.json()), /from 50 to 95/);
    const cleared = await s.give({ clear: true, compact_at: 70 });
    assert.equal(cleared.status, 400);
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.compactAt, 70, "a refusal changes nothing");

    // Given again without it: back to the default, and the route as it was.
    await s.give({ provider: "lab", model: "wide-model" });
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.compactAt, undefined);
    const again = await routeOf(s);
    assert.equal(again.compact_at, undefined);
    assert.equal(again.revision, before.revision, "a route without a point keeps its revision");
    const given = s.store.auditLog
      .list(50, { action: "rig_model_given" })
      .map((e) => (e.body as { compact_at: number | null }).compact_at);
    assert.deepEqual(given.reverse(), [null, 70, null]);
  });

  test("MCP: set_rig_model takes compact_at, and rig_models shows it", async () => {
    const s = await stack();
    const mcp = await mcpClient(s.control, TOKENS.operator);
    const r = text(
      await mcp.callTool({
        name: "set_rig_model",
        arguments: {
          rig: "rig-a",
          provider: "lab",
          model: "wide-model",
          context_window: 131_072,
          compact_at: 85,
        },
      }),
    );
    assert.equal(r.compact_at, 85);
    assert.equal(r.context_window, 131_072);
    assert.equal((await routeOf(s)).compact_at, 85);
    const read = text(await mcp.callTool({ name: "rig_models", arguments: { rig: "rig-a" } }));
    assert.equal((read.agents as { workers: { compact_at: number } }).workers.compact_at, 85);
    const bad = await mcp.callTool({
      name: "set_rig_model",
      arguments: { rig: "rig-a", provider: "lab", model: "wide-model", compact_at: 99 },
    });
    assert.equal(bad.isError, true);
    assert.match(JSON.stringify(bad), /from 50 to 95/);
    const tools = await mcp.listTools();
    assert.match(
      String(tools.tools.find((t) => t.name === "set_rig_model")?.description),
      /compact_at is the share of the window, in percent \(50 to 95; default 80\)/,
    );
    await mcp.close();
  });

  test("Settings › Providers shows the point with the model, and its forms keep it with the same model", async () => {
    const s = await stack();
    await s.give({ provider: "lab", model: "wide-model" });
    assert.match(
      await s.page("/ui/settings"),
      /Its agents run under Pi with wide-model from lab\. Its conversations are compacted at 80% of the window \(the default\)\./,
    );
    await s.give({ provider: "lab", model: "wide-model", compact_at: 75 });
    const settings = await s.page("/ui/settings");
    assert.match(settings, /Its conversations are compacted at 75% of the window\./);
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(settings)?.[1] ?? "";
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      harness: "opencode",
      choice: "lab|wide-model",
    });
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.compactAt, 75, "kept with the same model");
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      harness: "pi",
      choice: "lab|narrow-model",
    });
    assert.equal(
      s.store.agentModels.byRig()["rig-a"]?.compactAt,
      undefined,
      "set for the model before",
    );
  });
});

describe("every agent's own cap and compaction point (goal 070)", () => {
  /** The rig's routes: its workers' and planner's, and its advisors'. */
  const routes = async (s: Awaited<ReturnType<typeof stack>>) => {
    const get = async (key: "model-route" | "advisor-routes") =>
      (await s.rigConfig(key)) as unknown as Record<
        string,
        { context_window: number; compact_at?: number } | null
      >;
    return { model: await get("model-route"), advisors: await get("advisor-routes") };
  };

  test("REST: the planner and each advisor keep their own, their routes carry them, and the cap is checked", async () => {
    const s = await stack();
    await s.give({ provider: "lab", model: "wide-model", context_window: 131_072, compact_at: 85 });
    const planner = await s.give({
      agent: "planner",
      provider: "lab",
      model: "wide-model",
      context_window: 65_536,
      compact_at: 70,
    });
    assert.equal(planner.status, 200);
    const said = (await planner.json()) as Record<string, unknown>;
    assert.equal(said.context_window, 65_536);
    assert.equal(said.compact_at, 70);
    assert.match(
      String(said.said),
      /^Control sent a model for the planner to rig-a\. The rig takes the change in less than one minute\. Its context window: 65,536 tokens \(capped; the provider allows 204,800\)\. Its conversations are compacted at 70% of the window\.$/,
    );
    for (const [agent, model, cap, at] of [
      ["teachers", "narrow-model", 32_768, 60],
      ["auditor", "open-model", 16_384, undefined],
      ["review_panel", "wide-model", undefined, 90],
    ] as const) {
      const r = await s.give({
        agent,
        provider: "lab",
        model,
        ...(cap ? { context_window: cap } : {}),
        ...(at ? { compact_at: at } : {}),
      });
      assert.equal(r.status, 200, agent);
    }
    const r = await routes(s);
    // The workers' and the planner's own, each in its route.
    assert.equal(r.model.route?.context_window, 131_072);
    assert.equal(r.model.route?.compact_at, 85);
    assert.equal(r.model.planner?.context_window, 65_536);
    assert.equal(r.model.planner?.compact_at, 70);
    // Each advisor's: a cap below the provider's, a cap with no provider window, a point alone.
    const [teacher] = r.advisors.teacher_models as unknown as {
      context_window: number;
      compact_at?: number;
    }[];
    assert.equal(teacher?.context_window, 32_768);
    assert.equal(teacher?.compact_at, 60);
    assert.equal(r.advisors.auditor?.context_window, 16_384);
    assert.equal(r.advisors.auditor?.compact_at, undefined);
    assert.equal(r.advisors.review_panel?.context_window, 204_800);
    assert.equal(r.advisors.review_panel?.compact_at, 90);
    assert.equal(r.advisors.merged_by, null);
    const read = (await (
      await s.control.request("/v1/rigs/rig-a/model", {
        headers: { authorization: `Bearer ${TOKENS.admin}` },
      })
    ).json()) as {
      agents: Record<string, { context_cap: number | null; compact_at: number | null } | null> & {
        teachers: {
          models: { context_cap: number | null; compact_at: number | null }[];
          merged_by: unknown;
        };
      };
    };
    const { teachers, ...others } = read.agents;
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(others).map(([k, v]) => [k, v && [v.context_cap, v.compact_at]]),
      ),
      {
        workers: [131_072, 85],
        planner: [65_536, 70],
        auditor: [16_384, null],
        review_panel: [null, 90],
        synthesizer: null,
        final_writer: null,
      },
    );
    assert.deepEqual(
      teachers.models.map((m) => [m.context_cap, m.compact_at]),
      [[32_768, 60]],
    );
    assert.equal(teachers.merged_by, null);

    // Refused as the workers' are: above the provider's window, out of range; nothing changes.
    const over = await s.give({
      agent: "teachers",
      provider: "lab",
      model: "narrow-model",
      context_window: 200_000,
    });
    assert.equal(over.status, 400);
    assert.deepEqual(await over.json(), { error: "narrow-model takes at most 131,072 tokens." });
    const low = await s.give({
      agent: "auditor",
      provider: "lab",
      model: "open-model",
      context_window: 100,
    });
    assert.equal(low.status, 400);
    assert.match(JSON.stringify(await low.json()), /from 4,096 to 100,000,000/);
    assert.equal(s.store.agentModels.byRole("rig-a").teachers?.contextCap, 32_768);

    // Given again without them: none, as for the workers.
    await s.give({ agent: "teachers", provider: "lab", model: "narrow-model" });
    const again = await routes(s);
    const [first] = again.advisors.teacher_models as unknown as { context_window: number }[];
    assert.equal(first?.context_window, 131_072);
    assert.equal((first as { compact_at?: number })?.compact_at, undefined);
    const audit = s.store.auditLog
      .list(50, { action: "agent_model_given" })
      .map((e) => e.body as { role: string; context_cap: number | null; compact_at: number | null })
      .reverse();
    assert.deepEqual(
      audit.map((a) => [a.role, a.context_cap, a.compact_at]),
      [
        ["planner", 65_536, 70],
        ["teachers", 32_768, 60],
        ["auditor", 16_384, null],
        ["review_panel", null, 90],
        ["teachers", null, null],
      ],
    );
  });

  test("MCP: set_rig_model sets an advisor's own, and rig_models shows it", async () => {
    const s = await stack();
    const mcp = await mcpClient(s.control, TOKENS.operator);
    const r = text(
      await mcp.callTool({
        name: "set_rig_model",
        arguments: {
          rig: "rig-a",
          agent: "auditor",
          provider: "lab",
          model: "wide-model",
          context_window: 131_072,
          compact_at: 75,
        },
      }),
    );
    assert.equal(r.context_window, 131_072);
    assert.equal(r.compact_at, 75);
    const read = text(await mcp.callTool({ name: "rig_models", arguments: { rig: "rig-a" } }));
    assert.deepEqual((read.agents as Record<string, unknown>).auditor, {
      provider: "lab",
      model: "wide-model",
      effort: null,
      harness: "pi",
      context_cap: 131_072,
      compact_at: 75,
    });
    assert.equal((await routes(s)).advisors.auditor?.context_window, 131_072);
    const description = String(
      (await mcp.listTools()).tools.find((t) => t.name === "set_rig_model")?.description,
    );
    assert.match(description, /Every agent takes context_window and compact_at/);
    await mcp.close();
  });

  test("Edit rig's form keeps an agent's own while it keeps the same model, and drops it with another", async () => {
    const s = await stack();
    await s.give({
      agent: "auditor",
      provider: "lab",
      model: "wide-model",
      effort: "low",
      context_window: 131_072,
      compact_at: 70,
    });
    const edit = await s.page("/ui/rigs/rig-a/edit");
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(edit)?.[1] ?? "";
    assert.ok(csrf);
    // Another effort for the same model, from a form without the line's Context fields.
    await s.post("/ui/rigs/rig-a/edit", {
      csrf,
      choice: "",
      harness: "pi",
      role_auditor: "lab|wide-model",
      effort_auditor: "high",
    });
    const kept = s.store.agentModels.byRole("rig-a").auditor;
    assert.deepEqual([kept?.effort, kept?.contextCap, kept?.compactAt], ["high", 131_072, 70]);
    await s.post("/ui/rigs/rig-a/edit", {
      csrf,
      choice: "",
      harness: "pi",
      role_auditor: "lab|narrow-model",
      effort_auditor: "high",
    });
    const other = s.store.agentModels.byRole("rig-a").auditor;
    assert.deepEqual(
      [other?.model, other?.contextCap, other?.compactAt],
      ["narrow-model", undefined, undefined],
    );
  });
});
