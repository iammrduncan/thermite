import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { rigModelShapeRefusal } from "../../../../src/control/rigs/model.ts";
import { stack, TOKENS } from "./stack.ts";

/**
 * Each agent's model over REST: a request's fields, each agent set and cleared with the others
 * kept, the old names refused, and Edit rig's refusals in its words.
 */

describe("each agent's model over REST and MCP", () => {
  test("a request's fields for its agent", () => {
    assert.equal(rigModelShapeRefusal({ provider: "lab", model: "m" }), undefined);
    assert.equal(rigModelShapeRefusal({ agent: "auditor", clear: true }), undefined);
    assert.equal(
      rigModelShapeRefusal({ agent: "auditor" }),
      "Give a provider and a model, or clear: true.",
    );
    assert.equal(
      rigModelShapeRefusal({ clear: true, provider: "lab", model: "m" }),
      "Give clear alone, or a provider and a model.",
    );
    assert.equal(
      rigModelShapeRefusal({ clear: true, effort: "high" }),
      "Give clear alone, or a provider and a model.",
    );
    // Every agent takes a harness (goal 073).
    assert.equal(
      rigModelShapeRefusal({ agent: "planner", provider: "lab", model: "m", harness: "opencode" }),
      undefined,
    );
    assert.equal(
      rigModelShapeRefusal({ clear: true, agent: "auditor", harness: "codex" }),
      "Give clear alone, or a provider and a model.",
    );
    // Every agent takes its own cap and compaction point (goal 070).
    assert.equal(
      rigModelShapeRefusal({
        agent: "review_panel",
        provider: "lab",
        model: "m",
        contextWindow: 8192,
        compactAt: 70,
      }),
      undefined,
    );
    assert.equal(
      rigModelShapeRefusal({ agent: "planner", provider: "lab", model: "m", compactAt: 99 }),
      "The compaction point is a whole percent of the context window, from 50 to 95.",
    );
    assert.equal(
      rigModelShapeRefusal({ provider: "lab", model: "m", harness: "codex", contextWindow: 8192 }),
      undefined,
    );
  });

  test("REST: each agent set and cleared, the others kept, the routes the rig takes", async () => {
    const s = await stack();
    const workers = await s.give({ provider: "lab", model: "wide-model", effort: "low" });
    assert.equal(workers.status, 200);
    assert.equal(workers.body.agent, "workers");
    assert.equal(workers.body.context_window, 204_800);

    const kinds = [
      ["planner", "lab", "strong-model", 400_000],
      ["teachers", "sub", "gpt-sol", 272_000],
      ["auditor", "sub", "gpt-sol", 272_000],
      ["review_panel", "lab", "wide-model", 204_800],
    ] as const;
    for (const [agent, provider, model, window] of kinds) {
      const r = await s.give({ agent, provider, model, effort: "high" });
      assert.equal(r.status, 200, agent);
      assert.deepEqual(
        { agent: r.body.agent, model: r.body.model, context_window: r.body.context_window },
        { agent, model, context_window: window },
      );
      // Edit rig's words for the row.
      assert.equal(
        r.body.said,
        `Control sent a model for the ${agent.replace("_", " ")} to rig-a. The rig takes the change in less than one minute.`,
      );
    }
    // The teachers' merged by model, alone: the first teacher keeps its model.
    const merged = await s.give({
      agent: "teachers",
      merged_by: { provider: "lab", model: "strong-model", effort: "high" },
    });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(
      merged.body.said,
      "Control sent a merged by model for the teachers to rig-a. The rig takes the change in less than one minute.",
    );
    assert.equal(merged.body.model, null, "the call gave the first teacher no model");
    assert.equal(merged.body.context_window, null);
    const read = await s.owner("GET");
    assert.equal(read.status, 200);
    // Each agent's model with its harness, and its own cap and point (none set here: null).
    const roleOf = (provider: string, model: string) => ({
      provider,
      model,
      effort: "high",
      harness: "pi",
      context_cap: null,
      compact_at: null,
    });
    assert.deepEqual(await read.json(), {
      rig: "rig-a",
      agents: {
        workers: {
          provider: "lab",
          model: "wide-model",
          effort: "low",
          harness: "pi",
          context_cap: null,
          compact_at: null,
        },
        planner: roleOf("lab", "strong-model"),
        teachers: {
          models: [roleOf("sub", "gpt-sol")],
          merged_by: roleOf("lab", "strong-model"),
        },
        auditor: roleOf("sub", "gpt-sol"),
        review_panel: roleOf("lab", "wide-model"),
        // Neither has a model of its own: each uses the first teacher's (goal 166).
        synthesizer: null,
        final_writer: null,
      },
      // The rig's supervisor has not reported its advisors file.
      advisors_file: null,
    });

    // The rig takes them: the planner with its model route, the advisors with theirs. The
    // ChatGPT subscription's advisors get its access token, and run in the supervisor.
    const mr = await s.asRig("/v1/rigs/rig-a/model-route");
    assert.equal(mr.route?.model, "wide-model");
    assert.equal(mr.planner?.model, "strong-model");
    assert.equal(mr.planner?.reasoning, "high");
    const adv = (await s.asRig("/v1/rigs/rig-a/advisor-routes")) as Record<string, unknown>;
    const route = (k: string) => adv[k] as Record<string, unknown> | null;
    // One teacher: one model in teacher_models.
    const teachers = adv.teacher_models as Record<string, unknown>[];
    assert.deepEqual(
      teachers.map((t) => [t.type, t.model, t.api_key]),
      [["chatgpt", "gpt-sol", "chatgpt-access-for-tests"]],
    );
    assert.equal(route("auditor")?.type, "chatgpt");
    assert.equal(route("merged_by")?.type, "openai");
    assert.equal(route("review_panel")?.model, "wide-model");
    // Only the public names: the old ones of a supervisor before v0.1.1 are gone.
    assert.deepEqual(
      [route("teachers"), route("combiner"), route("panel")],
      [undefined, undefined, undefined],
    );

    // Cleared one at a time: that agent goes back to its default, the others keep theirs.
    const planner = await s.give({ agent: "planner", clear: true });
    assert.equal(planner.status, 200);
    assert.equal(planner.body.model, null);
    assert.equal(planner.body.context_window, null);
    assert.equal(
      planner.body.said,
      "Control sent the planner back to the workers' model to rig-a. The rig takes the change in less than one minute.",
    );
    assert.equal((planner.body.agents as Record<string, unknown>).planner, null);
    assert.equal((await s.asRig("/v1/rigs/rig-a/model-route")).planner, null);
    const auditor = await s.give({ agent: "auditor", clear: true });
    assert.match(String(auditor.body.said), /the auditor back to the rig's advisors file/);
    const after = auditor.body.agents as {
      auditor: unknown;
      teachers: { models: { model: string }[]; merged_by: { model: string } | null };
      review_panel: { model: string } | null;
      workers: { model: string } | null;
    };
    assert.equal(after.auditor, null);
    assert.equal(after.teachers.models[0]?.model, "gpt-sol");
    assert.equal(after.teachers.merged_by?.model, "strong-model");
    assert.equal(after.review_panel?.model, "wide-model");
    assert.equal(after.workers?.model, "wide-model");
    assert.equal((await s.asRig("/v1/rigs/rig-a/advisor-routes")).auditor, null);

    // The workers back to the rig's own settings, as Providers says it.
    const own = await s.give({ clear: true });
    assert.equal(own.body.said, "rig-a goes back to its own settings within a minute.");
    assert.equal(s.store.agentModels.byRig()["rig-a"], undefined);
    assert.equal(
      s.store.agentModels.byRole("rig-a").teachers?.model,
      "gpt-sol",
      "the advisors keep theirs",
    );

    const audit = s.store.auditLog.list(50, { action: "agent_model_given" }).reverse();
    assert.deepEqual(
      audit.map((e) => [e.actor, (e.body as { role: string }).role]),
      [
        ["owner:api", "planner"],
        ["owner:api", "teachers"],
        ["owner:api", "auditor"],
        ["owner:api", "review_panel"],
        ["owner:api", "merged_by"],
        ["owner:api", "planner"],
        ["owner:api", "auditor"],
      ],
    );
    assert.deepEqual(audit.at(-1)?.body, {
      rig: "rig-a",
      role: "auditor",
      provider: null,
      model: null,
    });
  });

  test("REST: the old names combiner and panel are refused (v0.1.1)", async () => {
    const s = await stack();
    for (const agent of ["combiner", "panel"]) {
      const old = await s.give({ agent, provider: "lab", model: "strong-model" });
      assert.match(`${old.status} ${old.body.error}`, /^400 bad request: agent/);
    }
    assert.deepEqual(s.store.agentModels.byRole("rig-a"), {});
  });

  test("REST: Edit rig's refusals in its words, and a refusal changes nothing", async () => {
    const s = await stack();
    await s.give({ agent: "auditor", provider: "lab", model: "wide-model" });
    const refused = async (body: Record<string, unknown>, error: RegExp | string) => {
      const r = await s.give(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      if (typeof error === "string") assert.equal(r.body.error, error);
      else assert.match(String(r.body.error), error);
    };
    await refused({ agent: "judge", provider: "lab", model: "wide-model" }, /^bad request: agent/);
    await refused(
      { agent: "auditor", provider: "lab", model: "no-such" },
      "That provider does not list that model (auditor).",
    );
    await refused(
      { agent: "auditor", provider: "zen", model: "big-pickle", harness: "pi" },
      "OpenCode's free models run only in OpenCode: choose OpenCode v2 for the auditor, or another model.",
    );
    // An advisor's own cap is checked as the workers' is (goal 070).
    await refused(
      { agent: "auditor", provider: "lab", model: "strong-model", context_window: 500_000 },
      "strong-model takes at most 400,000 tokens.",
    );
    await refused(
      { agent: "planner", provider: "lab", model: "strong-model", harness: "claude-code" },
      "Claude Code runs only with a Claude subscription here: choose Pi, OpenCode v2 or Codex for this provider.",
    );
    await refused(
      { agent: "auditor", clear: true, model: "wide-model" },
      "Give clear alone, or a provider and a model.",
    );
    await refused({ agent: "auditor" }, "Give a provider and a model, or clear: true.");
    assert.equal(s.store.agentModels.byRole("rig-a").auditor?.model, "wide-model");
    // OpenCode's own models suit any agent, which runs in OpenCode then.
    assert.equal(
      (await s.give({ agent: "planner", provider: "zen", model: "big-pickle" })).status,
      200,
    );
    const refusals = s.store.auditLog.list(50, { action: "refused" });
    assert.equal(refusals.length, 7);
    assert.ok(refusals.every((e) => (e.body as { path: string }).path === "/v1/rigs/rig-a/model"));

    const noRig = await s.owner("POST", { agent: "auditor", clear: true }, "rig-z");
    assert.equal(noRig.status, 404);
    assert.equal(((await noRig.json()) as { error: string }).error, "no rig rig-z");
    assert.equal((await s.owner("GET", undefined, "rig-z")).status, 404);
    for (const token of [TOKENS.read, TOKENS.operator]) {
      const post = await s.as(token)("POST", { agent: "auditor", clear: true });
      assert.ok(post.status === 401 || post.status === 403, "REST takes the owner's token");
      const get = await s.as(token)("GET");
      assert.ok(get.status === 401 || get.status === 403, "REST takes the owner's token");
    }
    assert.equal(s.store.agentModels.byRole("rig-a").auditor?.model, "wide-model");
  });
});
