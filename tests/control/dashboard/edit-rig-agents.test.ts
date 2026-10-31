import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agentModelsOf } from "../../../src/control/rigs/model.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { EDIT_RIG_JS } from "../../../src/control/ui/rigs/edit/client.ts";
import { AdvisorsConfig, advisorsFileReport } from "../../../src/supervisor/advisors/index.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { figuresCall, ingestReport } from "../../helpers/control-store.ts";

/**
 * Edit rig's section "2 · The agents" (goals 070, 073 and 074, as the owner approved its revised
 * mockup): The work and The advisors, each line with its model, effort, Runs in and Context, the
 * teachers with one or two models and a merged by model. The form is posted as a browser posts
 * it, from the page's own fields, and control keeps what it says or refuses it in words.
 */

/**
 * Control with rig-a reporting, and the owner signed in. Providers: "lab" (an OpenAI-compatible
 * key) with wide-model at 204,800 tokens, strong-model at 400,000 and open-model with none; "sub"
 * (a ChatGPT subscription) with gpt-sol; "claude-sub" (a Claude subscription) with opus-5.5; and
 * OpenCode's own "zen" with big-pickle.
 */
async function stack() {
  const secrets = SecretBox.ephemeral();
  const {
    store,
    control: api,
    rigConfig,
  } = controlOnly({
    options: { staleAfterMs: 600_000, secrets },
  });
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "ledger-rig-a",
    cursor: 0,
    next: 0,
    generated_at: new Date().toISOString(),
    events: [],
    summary: {},
  });
  store.modelProviders.put({
    name: "lab",
    type: "openai",
    base_url: "https://models.example.com/v1",
    key: { sealed: secrets.seal("lab-key-for-tests"), hint: "…ests" },
  });
  store.modelProviders.setModels("lab", [
    { id: "wide-model", context_window: 204_800 },
    { id: "strong-model", context_window: 400_000 },
    { id: "open-model" },
  ]);
  const login = {
    access: "chatgpt-access-for-tests",
    refresh: "chatgpt-refresh-for-tests",
    expires: Date.now() + 3_600_000,
    earliest_refresh: null,
    client_id: "client-for-tests",
    host_id: "host-for-tests",
  };
  store.modelProviders.put({
    name: "sub",
    type: "chatgpt",
    base_url: "",
    key: { sealed: secrets.seal(JSON.stringify(login)), hint: "ChatGPT" },
  });
  store.modelProviders.setModels("sub", [{ id: "gpt-sol", context_window: 272_000 }]);
  store.modelProviders.put({
    name: "claude-sub",
    type: "claude",
    base_url: "",
    key: { sealed: secrets.seal("claude-subscription-for-tests"), hint: "…ests" },
  });
  store.modelProviders.setModels("claude-sub", [{ id: "opus-5.5", context_window: 200_000 }]);
  store.modelProviders.put({
    name: "zen",
    type: "opencode",
    base_url: "https://opencode.ai/zen/v1",
  });
  store.modelProviders.setModels("zen", [{ id: "big-pickle" }]);
  const session = await signIn(api);
  const page = async (path = "/ui/rigs/rig-a/edit") => await session.page(path);
  const post = async (form: Record<string, string>) => {
    const r = await session.post("/ui/rigs/rig-a/edit", form);
    return decodeURIComponent(r.headers.get("location") ?? "");
  };
  // What the rig's config on the bus holds for it: `/v1/rigs/<rig>/<key>`.
  const asRig = async (path: string) =>
    (await rigConfig(path.split("/").at(-1) as "model-route" | "advisor-routes")) as Record<
      string,
      unknown
    >;
  return { store, api, page, post, asRig };
}

const unesc = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];

/**
 * What a browser posts for the Edit rig form as the page opens: each named field that is not
 * disabled, a checkbox or radio only when checked, a select's selected option (else its first).
 * Fields in lines with the hidden attribute are posted too, as a browser posts them.
 */
function formOf(html: string): Record<string, string> {
  const at = html.indexOf('<form id="edit-rig"');
  const f = html.slice(at, html.indexOf("</form>", at));
  const out: Record<string, string> = {};
  for (const m of f.matchAll(/<input\b([^>]*)>/g)) {
    const a = m[1] ?? "";
    const name = attr(a, "name");
    if (!name || /(?:^|\s)disabled(?:\s|$|=)/.test(a)) continue;
    const type = attr(a, "type") ?? "text";
    if ((type === "checkbox" || type === "radio") && !/(?:^|\s)checked(?:\s|$|=)/.test(a)) continue;
    out[name] = unesc(attr(a, "value") ?? "");
  }
  for (const m of f.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(m[1] ?? "", "name");
    if (!name || /(?:^|\s)disabled(?:\s|$|=)/.test(m[1] ?? "")) continue;
    const opts = [...(m[2] ?? "").matchAll(/<option\b([^>]*)>/g)].map((o) => o[1] ?? "");
    const sel = opts.find((o) => /(?:^|\s)selected(?:\s|$|=)/.test(o)) ?? opts[0] ?? "";
    out[name] = unesc(attr(sel, "value") ?? "");
  }
  return out;
}

/** The agents' table of the page, alone. */
const agentsOf = (html: string) => {
  const at = html.indexOf('<div class="roles" data-agents>');
  return html.slice(at, html.indexOf('<div class="flag" id="share"', at));
};
/** A line of the agents' table, by its id. */
const lineOf = (html: string, id: string) => {
  const at = html.indexOf(`data-line="${id}"`);
  return html.slice(at, html.indexOf('<div class="row-say"', at));
};

describe("Edit rig's agents (goals 070, 073 and 074)", () => {
  test("The work and The advisors: one line for each agent, with its job, Runs in, Context and an info icon on every label", async () => {
    const s = await stack();
    const html = await s.page();
    const table = agentsOf(html);
    assert.match(
      html,
      /<h2>2 · The agents<\/h2><p class="lead">Each agent runs in the harness you choose, with its own context\. With no model here, the workers use the rig's own settings, the planner uses the workers' model, and the synthesizer and the final writer use the first teacher's\. Another advisor uses the model in the rig's advisors file\. If the file has none, that advisor is off\.<\/p>/,
    );
    // The two groups, then each agent with its job on one line, in order.
    const order = [
      "The work",
      "Workers",
      "Change the code, one trial each.",
      "Planner",
      "Picks what each worker tries next.",
      "The advisors",
      "Teachers",
      "Read recent trials and suggest next steps.",
      "merged by",
      "Auditor",
      "Checks a win before it is kept.",
      "Review panel",
      "Scores goals that code can&#39;t measure.".replace("&#39;", "'"),
      "Synthesizer",
      "Writes each research question&#39;s answer card.".replace("&#39;", "'"),
      "Final writer",
      "Writes a research run&#39;s paper when it ends.".replace("&#39;", "'"),
    ];
    let from = 0;
    for (const t of order) {
      const i = table.indexOf(t, from);
      assert.ok(i >= from, `"${t}" comes next in the table`);
      from = i;
    }
    assert.doesNotMatch(html, /Teacher pair|Combiner|rig default/);
    // Every label in the table has its info icon: the headers, the groups, each agent, merged by
    // and the two Context fields of every line.
    const labels = table.match(/<span class="lb">/g) ?? [];
    const withIcon =
      table.match(
        /<span class="lb">[^<]*<i class="ii" tabindex="0" data-tip="[^"]+">i<\/i><\/span>/g,
      ) ?? [];
    assert.equal(labels.length, 5 + 2 + 7 + 1 + 9 * 2);
    assert.equal(withIcon.length, labels.length);
    // Each line's fields, by the form names the server reads.
    for (const id of [
      "planner",
      "teachers",
      "second_teacher",
      "merged_by",
      "auditor",
      "review_panel",
      "synthesizer",
      "final_writer",
    ])
      for (const k of ["role", "effort", "harness", "context", "compact"])
        assert.match(lineOf(html, id), new RegExp(`name="${k}_${id}"`));
    for (const k of ["choice", "effort", "harness", "context_workers", "compact_workers"])
      assert.match(lineOf(html, "workers"), new RegExp(`name="${k}"`));
    // Runs in offers the four harnesses on every line, the workers' without an empty choice.
    for (const id of ["workers", "planner", "auditor"])
      assert.match(
        lineOf(html, id),
        /<option value="pi"[^>]*>Pi<\/option><option value="opencode"[^>]*>OpenCode v2<\/option><option value="claude-code"[^>]*>Claude Code<\/option><option value="codex"[^>]*>Codex<\/option>/,
      );
    assert.match(lineOf(html, "planner"), /<option value="" selected>as the workers<\/option>/);
    assert.match(lineOf(html, "auditor"), /<option value="" selected>rig's file<\/option>/);
    assert.doesNotMatch(lineOf(html, "workers"), /data-runs-in="workers"[^>]*><option value=""/);
    // An empty model says what the agent uses then: the rig's own settings (not reported here),
    // the workers' model for the planner, the advisors file (not reported yet) for an advisor.
    assert.match(lineOf(html, "workers"), /<option value="" data-kind="">rig's settings<\/option>/);
    assert.match(lineOf(html, "auditor"), /<option value="" data-kind="">rig's file<\/option>/);
    assert.match(
      lineOf(html, "planner"),
      /<option value="" data-kind="">same as the workers<\/option>/,
    );
    // The Context cell opens without the script: a details element with its two fields.
    assert.match(
      lineOf(html, "workers"),
      /<details class="ctx-w" data-ctx="workers"><summary class="ctx-b"[^>]*>.*rig's settings/,
    );
    // Each model says what the page's script checks: where it runs, its window, Codex.
    assert.match(
      table,
      /data-kind="key" data-provider="lab" data-model="wide-model" data-window="204800" data-codex="1">wide-model</,
    );
    assert.match(
      table,
      /data-kind="claude" data-provider="claude-sub" data-model="opus-5\.5" data-window="200000">claude-code:opus-5\.5</,
    );
    assert.match(
      table,
      /data-kind="opencode" data-provider="zen" data-model="big-pickle" data-window="0">big-pickle</,
    );
    // One teacher: its second line and merged by are hidden, and so is + second teacher until
    // the first teacher has a model.
    assert.match(table, /<div class="ln sub" data-line="second_teacher"[^>]* hidden>/);
    assert.match(table, /<div class="ln sub" data-line="merged_by"[^>]* hidden>/);
    assert.match(table, /<div class="ln add" data-t2-addline hidden>/);
    assert.match(html, /<script src="\/ui\/assets\/edit-rig\.js" defer><\/script>/);
    // The page's script is valid JavaScript.
    assert.doesNotThrow(() => new Function(EDIT_RIG_JS));
  });

  test("each line's model, effort, Runs in, window and point are posted as a browser posts them, and control keeps them", async () => {
    const s = await stack();
    const form = formOf(await s.page());
    assert.equal(form.choice, "");
    assert.equal(form.context_workers, "");
    const said = await s.post({
      ...form,
      choice: "lab|wide-model",
      harness: "pi",
      effort: "medium",
      context_workers: "131,072",
      compact_workers: "70",
      role_planner: "lab|strong-model",
      harness_planner: "codex",
      role_auditor: "claude-sub|opus-5.5",
      harness_auditor: "claude-code",
      effort_auditor: "max",
      context_auditor: "150000",
      compact_auditor: "75%",
      role_review_panel: "sub|gpt-sol",
      harness_review_panel: "codex",
    });
    assert.match(
      said,
      /ok=Control sent a new model and a model for the planner and a model for the auditor and a model for the review panel to rig-a\./,
    );
    const w = s.store.agentModels.byRig()["rig-a"];
    assert.deepEqual(
      [w?.model, w?.harness, w?.effort, w?.contextCap, w?.compactAt],
      ["wide-model", "pi", "medium", 131_072, 70],
    );
    const roles = s.store.agentModels.byRole("rig-a");
    assert.equal(roles.planner?.harness, "codex");
    assert.deepEqual(
      [
        roles.auditor?.harness,
        roles.auditor?.effort,
        roles.auditor?.contextCap,
        roles.auditor?.compactAt,
      ],
      ["claude-code", "max", 150_000, 75],
    );
    assert.equal(roles.review_panel?.harness, "codex");
    // The rig's routes carry them: the workers' and the planner's, then the advisors'.
    const mr = (await s.asRig("/v1/rigs/rig-a/model-route")) as {
      route: { context_window: number; compact_at: number };
      planner: { harness: string; model: string };
    };
    assert.deepEqual([mr.route.context_window, mr.route.compact_at], [131_072, 70]);
    assert.deepEqual([mr.planner.model, mr.planner.harness], ["strong-model", "codex"]);
    const adv = (await s.asRig("/v1/rigs/rig-a/advisor-routes")) as {
      auditor: { context_window: number; compact_at: number; harness: string };
      review_panel: { harness: string };
    };
    assert.deepEqual(
      [adv.auditor.context_window, adv.auditor.compact_at, adv.auditor.harness],
      [150_000, 75, "claude-code"],
    );
    assert.equal(adv.review_panel.harness, "codex");
    // The page shows them: the fields' values, and in the Context cell the numbers set here bold.
    let html = await s.page();
    assert.match(
      lineOf(html, "workers"),
      /name="context_workers" data-cap value="131072" placeholder="204,800"/,
    );
    assert.match(lineOf(html, "workers"), /<b>131,072<\/b> · <b>70%<\/b>/);
    assert.match(lineOf(html, "auditor"), /<b>150,000<\/b> · <b>75%<\/b>/);
    assert.match(lineOf(html, "planner"), /<option value="codex" selected>Codex<\/option>/);
    assert.match(lineOf(html, "planner"), /400,000 · 80%/);
    assert.match(lineOf(html, "review_panel"), /272,000 · 80%/);
    // The same form again changes nothing.
    assert.match(await s.post(formOf(html)), /ok=Nothing changed\./);
    // The provider's own window is no cap, and 80% no point of its own: the line's defaults.
    html = await s.page();
    await s.post({ ...formOf(html), context_workers: "204800", compact_workers: "80" });
    assert.deepEqual(
      [
        s.store.agentModels.byRig()["rig-a"]?.contextCap,
        s.store.agentModels.byRig()["rig-a"]?.compactAt,
      ],
      [undefined, undefined],
    );
    // An empty field removes the auditor's own; a form without the fields keeps them.
    html = await s.page();
    const { context_planner: _c, compact_planner: _p, ...older } = formOf(html);
    await s.post({ ...older, effort_planner: "high" });
    assert.equal(s.store.agentModels.byRole("rig-a").planner?.effort, "high");
    await s.post({ ...formOf(await s.page()), context_auditor: "", compact_auditor: "" });
    assert.deepEqual(
      [
        s.store.agentModels.byRole("rig-a").auditor?.contextCap,
        s.store.agentModels.byRole("rig-a").auditor?.compactAt,
      ],
      [undefined, undefined],
    );
    // A line with no model again: its model goes, and its context with it.
    await s.post({ ...formOf(await s.page()), role_auditor: "", harness_auditor: "" });
    assert.equal(s.store.agentModels.byRole("rig-a").auditor, undefined);
  });

  test("a harness that cannot run the model, a window or a point out of range: refused in words, and nothing is saved", async () => {
    const s = await stack();
    const form = { ...formOf(await s.page()), choice: "lab|wide-model", harness: "pi" };
    const cases: [Record<string, string>, RegExp][] = [
      [
        { role_auditor: "claude-sub|opus-5.5", harness_auditor: "pi" },
        /error=Auditor: A Claude subscription runs only in Claude Code: choose Claude Code for the auditor, or another model\./,
      ],
      [
        { role_planner: "lab|wide-model", harness_planner: "claude-code" },
        /error=Planner: Claude Code runs only with a Claude subscription here: choose Pi, OpenCode v2 or Codex for this provider\./,
      ],
      [
        {
          role_planner: "claude-sub|opus-5.5",
          harness_planner: "claude-code",
          role_review_panel: "claude-sub|opus-5.5",
          harness_review_panel: "codex",
        },
        /error=Review panel: A Claude subscription runs only in Claude Code: choose Claude Code for the review panel, or another model\./,
      ],
      [
        { role_review_panel: "zen|big-pickle", harness_review_panel: "pi" },
        /error=Review panel: OpenCode's free models run only in OpenCode: choose OpenCode v2 for the review panel, or another model\./,
      ],
      [{ context_workers: "300000" }, /error=Workers: wide-model takes at most 204,800 tokens\./],
      [
        { context_workers: "1000" },
        /error=Workers: A context window is a whole number of tokens from 4,096 to 100,000,000\./,
      ],
      [
        { context_workers: "big" },
        /error=Workers: write the number of tokens in digits, such as 131072\./,
      ],
      [
        { compact_workers: "99" },
        /error=Workers: The compaction point is a whole percent of the context window, from 50 to 95\./,
      ],
      [
        {
          role_auditor: "claude-sub|opus-5.5",
          harness_auditor: "claude-code",
          context_auditor: "250000",
        },
        /error=Auditor: opus-5\.5 takes at most 200,000 tokens\./,
      ],
      [
        { role_auditor: "lab|open-model", harness_auditor: "pi", compact_auditor: "4o" },
        /error=Auditor: the compaction point is a whole percent/,
      ],
    ];
    for (const [change, refused] of cases) {
      assert.match(await s.post({ ...form, ...change }), refused);
      // Nothing of the form was saved: not the workers' model, nor another line's.
      assert.equal(s.store.agentModels.byRig()["rig-a"], undefined);
      assert.deepEqual(s.store.agentModels.byRole("rig-a"), {});
    }
    // A model with no window takes any window in range.
    await s.post({
      ...form,
      role_auditor: "lab|open-model",
      harness_auditor: "pi",
      context_auditor: "64000",
    });
    assert.equal(s.store.agentModels.byRole("rig-a").auditor?.contextCap, 64_000);
  });

  test("the teachers: one, or two with a merged by model, each with its own effort, Runs in and context; × removes the second", async () => {
    const s = await stack();
    // + second teacher without the script: the page again, with the second teacher's lines.
    let html = await s.page("/ui/rigs/rig-a/edit?teachers=2");
    assert.doesNotMatch(agentsOf(html), /data-line="second_teacher"[^>]* hidden/);
    assert.doesNotMatch(agentsOf(html), /data-line="merged_by"[^>]* hidden/);
    assert.match(
      lineOf(html, "second_teacher"),
      /<option value="" data-kind="">choose a model<\/option>/,
    );
    assert.match(
      lineOf(html, "second_teacher"),
      /href="\/ui\/rigs\/rig-a\/edit\?teachers=1#agents" data-t2-x/,
    );
    assert.match(
      agentsOf(html),
      /href="\/ui\/rigs\/rig-a\/edit\?teachers=2#agents" data-t2-add>\+ second teacher</,
    );
    // A second teacher needs a first.
    assert.match(
      await s.post({
        ...formOf(html),
        role_second_teacher: "sub|gpt-sol",
        harness_second_teacher: "codex",
      }),
      /error=Teacher 2: a second teacher needs a first\./,
    );
    assert.deepEqual(s.store.agentModels.byRole("rig-a"), {});
    const said = await s.post({
      ...formOf(html),
      role_teachers: "claude-sub|opus-5.5",
      harness_teachers: "claude-code",
      effort_teachers: "high",
      role_second_teacher: "sub|gpt-sol",
      harness_second_teacher: "codex",
      effort_second_teacher: "medium",
      compact_second_teacher: "70",
      role_merged_by: "lab|wide-model",
      harness_merged_by: "pi",
      context_merged_by: "131072",
    });
    assert.match(
      said,
      /ok=Control sent a model for the teachers and a model for a second teacher and a merged by model for the teachers to rig-a\./,
    );
    const r = s.store.agentModels.byRole("rig-a");
    assert.deepEqual(
      [r.teachers?.model, r.teachers?.harness, r.teachers?.effort],
      ["opus-5.5", "claude-code", "high"],
    );
    assert.deepEqual(
      [
        r.second_teacher?.model,
        r.second_teacher?.harness,
        r.second_teacher?.effort,
        r.second_teacher?.compactAt,
      ],
      ["gpt-sol", "codex", "medium", 70],
    );
    assert.deepEqual(
      [r.merged_by?.model, r.merged_by?.harness, r.merged_by?.contextCap],
      ["wide-model", "pi", 131_072],
    );
    const agents = agentModelsOf(s.store, "rig-a");
    assert.deepEqual(
      agents.teachers.models.map((m) => m.model),
      ["opus-5.5", "gpt-sol"],
    );
    assert.equal(agents.teachers.merged_by?.model, "wide-model");
    const adv = (await s.asRig("/v1/rigs/rig-a/advisor-routes")) as {
      teacher_models: { model: string; harness: string }[];
      merged_by: { model: string; context_window: number };
    };
    assert.deepEqual(
      adv.teacher_models.map((t) => [t.model, t.harness]),
      [
        ["claude-opus-5-5", "claude-code"],
        ["gpt-sol", "codex"],
      ],
    );
    assert.deepEqual([adv.merged_by.model, adv.merged_by.context_window], ["wide-model", 131_072]);
    // The page opens with both teachers shown, and no + second teacher.
    html = await s.page();
    assert.doesNotMatch(agentsOf(html), /data-line="second_teacher"[^>]* hidden/);
    assert.match(agentsOf(html), /<div class="ln add" data-t2-addline hidden>/);
    assert.match(lineOf(html, "merged_by"), /<b>131,072<\/b> · 80%/);
    assert.match(lineOf(html, "second_teacher"), /272,000 · <b>70%<\/b>/);
    // × without the script: the page again, with the second teacher's lines emptied (the script
    // says what they had); saved, the first teacher stays alone.
    html = await s.page("/ui/rigs/rig-a/edit?teachers=1");
    assert.match(
      lineOf(html, "second_teacher"),
      /name="role_second_teacher"[^>]*data-was="sub\|gpt-sol"/,
    );
    assert.match(agentsOf(html), /data-line="second_teacher"[^>]* hidden/);
    assert.match(
      await s.post(formOf(html)),
      /ok=Control sent the teachers back to one teacher and the teachers' merged by model back to the rig's advisors file to rig-a\./,
    );
    assert.deepEqual(Object.keys(s.store.agentModels.byRole("rig-a")), ["teachers"]);
    // Two teachers again, then the first with no model: all three go, said once.
    html = await s.page("/ui/rigs/rig-a/edit?teachers=2");
    await s.post({
      ...formOf(html),
      role_second_teacher: "sub|gpt-sol",
      harness_second_teacher: "codex",
      role_merged_by: "lab|wide-model",
      harness_merged_by: "pi",
    });
    assert.equal(agentModelsOf(s.store, "rig-a").teachers.models.length, 2);
    html = await s.page();
    assert.match(
      await s.post({
        ...formOf(html),
        role_teachers: "",
        harness_teachers: "",
        role_second_teacher: "",
        role_merged_by: "",
      }),
      /ok=Control sent the teachers back to the rig's advisors file to rig-a\./,
    );
    assert.deepEqual(s.store.agentModels.byRole("rig-a"), {});
  });
});

/**
 * What a line with no model says it uses (goal 074; the owner, 2026-10-21: "what is default of
 * default?"): the advisors file as the rig's supervisor reports it, or none (off), or "rig's
 * file" until it has reported; the rig's own model as its harness reports it, for the workers.
 */
describe("Edit rig's empty model names the real fallback (goal 074)", () => {
  const STATS = {
    teacher_runs: 0,
    directive_sets: 0,
    directives: 0,
    audits: 0,
    reviews: 0,
    errors: 0,
    tokens_in: 0,
    tokens_out: 0,
    usd: 0,
  };
  const report = async (s: Awaited<ReturnType<typeof stack>>, body: Record<string, unknown>) =>
    (await figuresCall(s.store, "rig-a", { at: new Date().toISOString(), ...body })).status;
  /** A line's empty Model choice, its empty Runs in choice and its Context cell, as text. */
  const cells = (html: string, id: string) => {
    const l = lineOf(html, id);
    return {
      model: unesc(
        /data-role="[^"]+"[^>]*><option value="" data-kind="">([^<]*)<\/option>/.exec(l)?.[1] ?? "",
      ),
      runs: unesc(
        /data-runs-in="[^"]+"[^>]*><option value=""[^>]*>([^<]*)<\/option>/.exec(l)?.[1] ?? "",
      ),
      ctx: unesc(
        /<span data-ctx-sum="[^"]+"><span class="muted">([^<]*)<\/span>/.exec(l)?.[1] ?? "",
      ),
      say: unesc(/data-fb-say="([^"]*)"/.exec(l)?.[1] ?? ""),
      off: /data-fb-off="1"/.test(l),
    };
  };

  test("not reported yet: each advisor says rig's file; the workers, rig's settings", async () => {
    const s = await stack();
    const html = await s.page();
    for (const id of ["teachers", "merged_by", "auditor", "review_panel"])
      assert.deepEqual(cells(html, id), {
        model: "rig's file",
        runs: "rig's file",
        ctx: "rig's file",
        say: "the one in the rig's advisors file, if it has one",
        off: false,
      });
    assert.equal(cells(html, "workers").model, "rig's settings");
    assert.equal(cells(html, "workers").ctx, "rig's settings");
    assert.equal(cells(html, "planner").model, "same as the workers");
    assert.equal(cells(html, "second_teacher").model, "choose a model");
    // Effort says whose default it is.
    assert.match(lineOf(html, "auditor"), /<option value="" selected>model's default<\/option>/);
    assert.doesNotMatch(html, /rig default/);
  });

  test("a file that names models: the model, its harness and its window, greyed", async () => {
    const s = await stack();
    const file = AdvisorsConfig.parse({
      teachers: [
        { name: "teacher-a", runtime: "claude-code", model: "opus-5.5", token: "token-for-tests" },
      ],
      auditor: {
        name: "auditor",
        runtime: "openai",
        base_url: "https://llm.example.com/v1",
        model: "model-a",
        api_key_file: "/etc/thermite/advisors/llm-key",
        context_window: 131_072,
        compact_at: 70,
      },
      review_panel: [
        {
          name: "reviewer-a",
          runtime: "codex",
          base_url: "https://llm.example.com/v1",
          model: "model-a",
          api_key_file: "/etc/thermite/advisors/llm-key",
        },
        {
          name: "reviewer-b",
          runtime: "codex",
          base_url: "https://llm.example.com/v1",
          model: "model-b",
          api_key_file: "/etc/thermite/advisors/llm-key",
        },
      ],
    });
    const roles = { teachers: 1, merged_by: false, auditor: true, review_panel: 2 };
    assert.equal(
      await report(s, { advisors: { ...STATS, roles, file: advisorsFileReport(file) } }),
      200,
    );
    const html = await s.page();
    assert.deepEqual(cells(html, "teachers"), {
      model: "rig's file: opus-5.5",
      runs: "Claude Code",
      ctx: "no window · 80%",
      say: "the one in the rig's advisors file (opus-5.5)",
      off: false,
    });
    assert.deepEqual(cells(html, "auditor"), {
      model: "rig's file: model-a",
      runs: "Pi",
      ctx: "131,072 · 70%",
      say: "the one in the rig's advisors file (model-a)",
      off: false,
    });
    assert.deepEqual(cells(html, "review_panel"), {
      model: "rig's file: model-a, model-b",
      runs: "Codex",
      ctx: "no window · 80%",
      say: "the one in the rig's advisors file (model-a, model-b)",
      off: false,
    });
    // The file names no merged by model: two teachers' first review is the set.
    assert.deepEqual(cells(html, "merged_by"), {
      model: "none: off",
      runs: "—",
      ctx: "—",
      say: "none: the rig's advisors file has none, so the first review that comes back is the set",
      off: true,
    });
    // A model given here still shows as given; its empty choice keeps the file's words.
    s.store.agentModels.assignRole("rig-a", "auditor", { provider: "lab", model: "wide-model" });
    const given = lineOf(await s.page(), "auditor");
    assert.match(given, /<option value="lab\|wide-model"[^>]* selected>wide-model<\/option>/);
    assert.match(given, /<option value="" data-kind="">rig's file: model-a<\/option>/);
  });

  test("no advisors at all: each advisor is none: off, and its cells say —", async () => {
    const s = await stack();
    // Every version of the supervisor reports no advisors as null.
    assert.equal(await report(s, { advisors: null }), 200);
    const html = await s.page();
    assert.deepEqual(cells(html, "auditor"), {
      model: "none: off",
      runs: "—",
      ctx: "—",
      say: "none: the rig's advisors file has none, so there is no auditor",
      off: true,
    });
    assert.equal(cells(html, "teachers").model, "none: off");
    assert.equal(cells(html, "review_panel").model, "none: off");
    assert.equal(cells(html, "merged_by").model, "none: off");
    // The page's lead and info icons say what an empty model means.
    assert.match(
      lineOf(html, "auditor"),
      /If the file has none, there is no auditor, and audits wait for you\./,
    );
  });

  test("an older supervisor (roles only): rig's file, as not reported", async () => {
    const s = await stack();
    const roles = { teachers: 2, merged_by: true, auditor: true, review_panel: 0 };
    assert.equal(await report(s, { advisors: { ...STATS, roles } }), 200);
    const html = await s.page();
    assert.equal(cells(html, "auditor").model, "rig's file");
    assert.equal(cells(html, "review_panel").runs, "rig's file");
  });

  test("the workers: the rig's own model, or none: can't run", async () => {
    const s = await stack();
    const ingest = async (model: unknown) =>
      await ingestReport(s.store, {
        rig: "rig-a",
        ledger_id: "ledger-rig-a",
        cursor: 0,
        next: 0,
        generated_at: new Date().toISOString(),
        events: [],
        summary: { model },
      });
    await ingest({ source: "environment", model: "local-coder", harness: "pi" });
    let w = cells(await s.page(), "workers");
    assert.equal(w.model, "rig's settings: local-coder");
    assert.equal(w.say, "the rig's own settings (local-coder)");
    await ingest({ source: "none" });
    w = cells(await s.page(), "workers");
    assert.equal(w.model, "none: can't run");
    assert.equal(w.ctx, "—");
  });
});
