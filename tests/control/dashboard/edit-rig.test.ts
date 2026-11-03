import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stack } from "./stack.ts";

/**
 * Edit rig: each agent's model and effort, the rig's reported settings and what Save sends, and
 * the judge's share of a GPU set.
 */

describe("control dashboard", () => {
  test("Edit rig: a model and an effort for each agent; the planner's route reaches the harness, the advisors' reach the supervisor", async () => {
    const s = await stack("owner_approval", {
      providerFetch: (async () =>
        Response.json({ data: [{ id: "claude-test" }], has_more: false })) as typeof fetch,
    });
    await s.relay();
    const token = "sk-ant-oat01-roles-0001"; // public-check: allow (a made-up token for tests)
    let page = await (await s.get("/ui/settings")).text();
    const csrf = s.csrfFrom(page);
    await s.post("/ui/settings/add", {
      csrf,
      type: "claude",
      name: "claude-max",
      claude_token: token,
    });
    await s.post("/ui/settings/providers", {
      csrf,
      name: "keyed",
      type: "anthropic",
      api_key: "sk-ant-api-roles",
    });
    page = await (await s.get("/ui/rigs/rig-a/edit")).text();
    // Each line by the role it sets (goal 074): the first teacher, the second, the merged by model.
    for (const role of [
      "planner",
      "teachers",
      "second_teacher",
      "merged_by",
      "auditor",
      "review_panel",
    ])
      assert.match(page, new RegExp(`name="role_${role}" data-role="${role}"`));
    assert.match(page, /same as the workers/);
    assert.match(page, /data-kind="claude"[^>]*>claude-code:opus-5\.5/);
    const form: Record<string, string> = { csrf: s.csrfFrom(page), choice: "", harness: "pi" };
    for (const k of ["judge", "workers", "planner", "auditor", "teachers", "review", "exports"])
      form[k] = "1";
    Object.assign(form, {
      lanes: "1",
      trial_minutes: "20",
      max_turns: "",
      promotion: "owner_approval",
      choice: "keyed|claude-test",
      effort: "medium",
      role_planner: "claude-max|opus-5.5",
      effort_planner: "xhigh",
      role_auditor: "claude-max|opus-5.5",
      effort_auditor: "max",
      role_teachers: "keyed|claude-test",
    });
    const saved = await s.post("/ui/rigs/rig-a/edit", form);
    assert.match(
      decodeURIComponent(String(saved.headers.get("location"))),
      /a model for the planner/,
    );
    assert.deepEqual(s.store.agentModels.byRole("rig-a").planner, {
      provider: "claude-max",
      model: "opus-5.5",
      effort: "xhigh",
      harness: "claude-code",
    });
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.effort, "medium");
    // A harness set over MCP or REST (goal 073) stays when Edit rig changes only the row's
    // effort, and the row's Runs in says where the agent runs.
    s.store.agentModels.assignRole("rig-a", "teachers", {
      provider: "keyed",
      model: "claude-test",
      harness: "opencode",
    });
    await s.post("/ui/rigs/rig-a/edit", { ...form, effort_teachers: "high" });
    assert.deepEqual(s.store.agentModels.byRole("rig-a").teachers, {
      provider: "keyed",
      model: "claude-test",
      effort: "high",
      harness: "opencode",
    });
    page = await (await s.get("/ui/rigs/rig-a/edit")).text();
    const runsIn = (role: string) =>
      new RegExp(`data-runs-in="${role}"[^>]*>(?:(?!</select>)[\\s\\S])*`).exec(page)?.[0] ?? "";
    assert.match(runsIn("teachers"), /<option value="opencode" selected>OpenCode v2<\/option>/);
    // The auditor on a Claude subscription: Claude Code. The merged by model, with no model of
    // its own: the advisors file's, which the supervisor has not reported here.
    assert.match(runsIn("auditor"), /<option value="claude-code" selected>Claude Code<\/option>/);
    assert.match(runsIn("merged_by"), /<option value="" selected>rig's file<\/option>/);
    // The Codex CLI speaks only OpenAI's Responses API: not with Anthropic's.
    const noCodex = await s.post("/ui/rigs/rig-a/edit", { ...form, harness: "codex" });
    assert.match(
      decodeURIComponent(String(noCodex.headers.get("location"))),
      /error=Workers: Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider\./,
    );
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.harness, "pi");
    const mr = (await s.rigConfig("model-route")) as unknown as {
      route: { type: string; reasoning: string | null };
      planner: { type: string; harness: string; effort: string; api_key: string };
    };
    assert.equal(mr.route.type, "anthropic");
    assert.equal(mr.route.reasoning, "medium");
    assert.equal(mr.planner.type, "claude");
    assert.equal(mr.planner.harness, "claude-code");
    assert.equal(mr.planner.effort, "xhigh");
    assert.equal(mr.planner.api_key, token);
    const adv = (await s.rigConfig("advisor-routes")) as unknown as Record<
      string,
      { type: string; effort?: string; api_key: string } | null
    >;
    assert.equal(adv.auditor?.type, "claude");
    assert.equal(adv.auditor?.effort, "max");
    // Only the public names: an older supervisor's teachers, combiner and panel are gone.
    assert.deepEqual([adv.teachers, adv.combiner, adv.panel], [undefined, undefined, undefined]);
    // The line Teachers gives the first teacher its model and effort: one teacher.
    const one = (adv as unknown as { teacher_models: { model: string; reasoning: string }[] })
      .teacher_models;
    assert.deepEqual(
      one.map((t) => [t.model, t.reasoning]),
      [["claude-test", "high"]],
    );
    assert.deepEqual(
      [s.store.agentModels.byRole("rig-a").second_teacher, adv.merged_by, adv.review_panel],
      [undefined, null, null],
    );
    // Its empty choice clears the teachers; a form without a line's field keeps that line's model.
    await s.post("/ui/rigs/rig-a/edit", { ...form, role_teachers: "", effort_teachers: "" });
    assert.deepEqual(
      [
        s.store.agentModels.byRole("rig-a").teachers,
        s.store.agentModels.byRole("rig-a").second_teacher,
      ],
      [undefined, undefined],
    );
    assert.equal(s.store.agentModels.byRole("rig-a").planner?.model, "opus-5.5");
    // A role set back to "same as the workers" loses its own model.
    await s.post("/ui/rigs/rig-a/edit", { ...form, role_auditor: "", effort_auditor: "" });
    assert.equal(s.store.agentModels.byRole("rig-a").auditor, undefined);
    // A provider some role uses can't be deleted, and Providers says which rig uses it.
    assert.equal(s.store.modelProviders.delete("claude-max"), "in_use");
    const providersPage = await (await s.get("/ui/settings")).text();
    const claudeRow = providersPage.slice(providersPage.indexOf('data-k="provider-claude-max"'));
    assert.match(claudeRow.slice(0, claudeRow.indexOf("</summary>")), /used by rig-a/);
  });

  test("Edit rig: the rig's reported settings, and Save sends only what changed", async () => {
    const s = await stack();
    await s.relay();
    const page = await (await s.get("/ui/rigs/rig-a/edit")).text();
    assert.match(
      page,
      /<input type="checkbox" name="judge" value="1" data-part data-name="Judge" checked>/,
    );
    assert.match(page, /<b>Supervisor<\/b> <span class="pt-state on">on<\/span>/);
    assert.match(page, /<script src="\/ui\/assets\/edit-rig.js" defer>/);
    const labels = page.match(/class="lb"/g)?.length ?? 0;
    const tips = page.match(/class="ii" tabindex="0" data-tip="[^"]+"/g)?.length ?? 0;
    assert.ok(labels > 0 && tips === labels, `${labels} labels, ${tips} with descriptions`);
    // The form as the page sends it: every switch on but the planner, two workers at a time.
    const form: Record<string, string> = { csrf: s.csrfFrom(page), choice: "", harness: "pi" };
    for (const k of ["judge", "workers", "auditor", "teachers", "review", "exports"]) form[k] = "1";
    // A trial quiet for 30 minutes asks the owner (goal 143); empty, the default, is never.
    assert.match(
      page,
      /<input name="quiet_minutes" type="number" min="1" max="1440" value="" placeholder="never"/,
    );
    // How the agent programs run (goal 169), under Advanced: in their own terminal until someone
    // chooses headless.
    assert.match(
      page,
      /<details class="adv"><summary>Advanced<\/summary>.*Agent programs run.*<select name="program_mode" data-label="how agent programs run"><option value="terminal" selected>In their own terminal<\/option><option value="headless">Headless<\/option><\/select>/s,
    );
    Object.assign(form, {
      lanes: "2",
      trial_minutes: "20",
      max_turns: "",
      quiet_minutes: "30",
      program_mode: "headless",
      promotion: "auto",
    });
    const r = await s.post("/ui/rigs/rig-a/edit", form);
    assert.match(
      decodeURIComponent(String(r.headers.get("location"))),
      /Control sent \d settings to rig-a/,
    );
    const cmd = s.store.commands.list(5).find((c) => c.kind === "rig_settings");
    assert.ok(cmd);
    assert.equal(s.store.commands.latest("rig-a", "rig_settings", 1)[0]?.payload.quiet_minutes, 30);
    assert.equal(
      s.store.commands.latest("rig-a", "rig_settings", 1)[0]?.payload.program_mode,
      "headless",
    );
    await s.relay();
    assert.equal(s.env.service.settings.get().planner, false);
    assert.equal(s.env.service.settings.get().lanes, 2);
    assert.equal(s.env.service.settings.get().quiet_minutes, 30);
    assert.equal(s.env.service.settings.get().program_mode, "headless");
    await s.relay();
    const after = await (await s.get("/ui/rigs/rig-a/edit")).text();
    assert.match(after, /name="planner" value="1" data-part data-name="Planner">/);
    assert.match(after, /name="quiet_minutes" type="number" min="1" max="1440" value="30"/);
    assert.match(after, /<option value="headless" selected>Headless<\/option>/);
  });

  test("Edit rig: a rig with a GPU set shows the judge's share, and a new one is sent signed", async () => {
    const s = await stack();
    // No GPU set reported: no field.
    await s.relay();
    assert.doesNotMatch(await (await s.get("/ui/rigs/rig-a/edit")).text(), /name="judge_gpus"/);
    s.env.service.gpuSplit = { set: 4, judge: 2 };
    await s.relay();
    const page = await (await s.get("/ui/rigs/rig-a/edit")).text();
    assert.match(
      page,
      /<input name="judge_gpus" type="number" min="1" max="3" value="2" data-restarts>/,
    );
    assert.match(
      page,
      /Now: 2 for the judge, 2 for the agents\. A new split restarts the rig's harness/,
    );
    const form: Record<string, string> = { csrf: s.csrfFrom(page), choice: "", harness: "pi" };
    for (const k of ["judge", "workers", "planner", "auditor", "teachers", "review", "exports"])
      form[k] = "1";
    Object.assign(form, { lanes: "1", trial_minutes: "20", max_turns: "", promotion: "auto" });
    const bad = await s.post("/ui/rigs/rig-a/edit", { ...form, judge_gpus: "4" });
    assert.match(
      decodeURIComponent(String(bad.headers.get("location"))),
      /with 4 GPUs the judge takes 1 to 3 of them/,
    );
    await s.post("/ui/rigs/rig-a/edit", { ...form, judge_gpus: "3" });
    const cmd = s.store.commands.pending("rig-a").find((c) => c.envelope.kind === "rig_settings");
    assert.equal((cmd?.envelope.payload as { judge_gpus?: number } | undefined)?.judge_gpus, 3);
  });
});
