import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SecretBox } from "../../../src/control/secrets.ts";
import { EDIT_RIG_JS } from "../../../src/control/ui/rigs/edit/client.ts";
import { AdvisorsConfig, advisorsFileReport } from "../../../src/supervisor/advisors/index.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { figuresCall, ingestReport } from "../../helpers/control-store.ts";

/**
 * Edit rig's lines for the synthesizer and the final writer (goal 166): each a line of The
 * advisors, with its own model, effort, Runs in and Context. With no model, each uses the first
 * teacher's: the Teachers line's model when it has one, else the first teacher of the rig's
 * advisors file, as its supervisor reports it.
 */

/** Control with rig-a reporting, the owner signed in, and the provider "lab" with two models. */
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
  ]);
  const session = await signIn(api);
  const page = async () => await session.page("/ui/rigs/rig-a/edit");
  const post = async (form: Record<string, string>) => {
    const r = await session.post("/ui/rigs/rig-a/edit", form);
    return decodeURIComponent(r.headers.get("location") ?? "");
  };
  const report = async (advisors: unknown) =>
    figuresCall(store, "rig-a", { at: new Date().toISOString(), advisors }).status;
  const advisorRoutes = async () =>
    (await rigConfig("advisor-routes")) as unknown as Record<
      string,
      { model: string; harness: string } | null
    >;
  return { store, page, post, report, advisorRoutes };
}

const unesc = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];

/** What a browser posts for the form as the page opens: each named field that is not disabled. */
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

/** A line of the agents' table, by its id. */
const lineOf = (html: string, id: string) => {
  const at = html.indexOf(`data-line="${id}"`);
  return html.slice(at, html.indexOf('<div class="row-say"', at));
};

/** A line's empty Model choice, its empty Runs in choice, its Context cell and its sentence. */
const cells = (html: string, id: string) => {
  const l = lineOf(html, id);
  return {
    model: unesc(
      /data-role="[^"]+"[^>]*><option value="" data-kind="">([^<]*)<\/option>/.exec(l)?.[1] ?? "",
    ),
    runs: unesc(
      /data-runs-in="[^"]+"[^>]*><option value=""[^>]*>([^<]*)<\/option>/.exec(l)?.[1] ?? "",
    ),
    ctx: unesc(/<span data-ctx-sum="[^"]+"><span class="muted">([^<]*)<\/span>/.exec(l)?.[1] ?? ""),
    say: unesc(/data-fb-say="([^"]*)"/.exec(l)?.[1] ?? ""),
    off: /data-fb-off="1"/.test(l),
  };
};

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

describe("Edit rig's synthesizer and final writer (goal 166)", () => {
  test("two lines of The advisors, after the review panel, each with its fields and its job", async () => {
    const s = await stack();
    const html = await s.page();
    for (const [id, name, job] of [
      ["synthesizer", "Synthesizer", "Writes each research question's answer card."],
      ["final_writer", "Final writer", "Writes a research run's paper when it ends."],
    ] as const) {
      const l = lineOf(html, id);
      assert.match(l, new RegExp(`<span class="lb">${name}<i class="ii"`));
      assert.ok(l.includes(`<span class="job">${job}</span>`), id);
      assert.match(l, /data-kind="advisor"/);
      assert.match(l, /data-follows="teachers"/);
      for (const k of ["role", "effort", "harness", "context", "compact"])
        assert.match(l, new RegExp(`name="${k}_${id}"`));
    }
    assert.ok(html.indexOf('data-line="review_panel"') < html.indexOf('data-line="synthesizer"'));
    assert.ok(html.indexOf('data-line="synthesizer"') < html.indexOf('data-line="final_writer"'));
    // Not reported yet: the first teacher's, without more.
    for (const id of ["synthesizer", "final_writer"])
      assert.deepEqual(cells(html, id), {
        model: "same as the first teacher",
        runs: "as the first teacher",
        ctx: "as the first teacher",
        say: "the first teacher's model",
        off: false,
      });
    // The page's script reads the lines it follows, and is valid JavaScript.
    assert.match(EDIT_RIG_JS, /dataset\.follows/);
    assert.doesNotThrow(() => new Function(EDIT_RIG_JS));
  });

  test("with no model: the advisors file's first teacher, or off with none; the Teachers line's model when it has one", async () => {
    const s = await stack();
    const file = AdvisorsConfig.parse({
      teachers: [
        { name: "teacher-a", runtime: "claude-code", model: "opus-5.5", token: "token-for-tests" },
      ],
    });
    const roles = { teachers: 1, merged_by: false, auditor: false, review_panel: 0 };
    assert.equal(await s.report({ ...STATS, roles, file: advisorsFileReport(file) }), 200);
    assert.deepEqual(cells(await s.page(), "final_writer"), {
      model: "same as the first teacher",
      runs: "Claude Code",
      ctx: "no window · 80%",
      say: "the first teacher's model (rig's file: opus-5.5)",
      off: false,
    });
    // No advisors at all: no first teacher, so it is off.
    assert.equal(await s.report(null), 200);
    assert.deepEqual(cells(await s.page(), "synthesizer"), {
      model: "same as the first teacher",
      runs: "—",
      ctx: "—",
      say: "the first teacher's model: none, as the rig's advisors file has no teachers, so it is off until it or the teachers have a model",
      off: true,
    });
    // The Teachers line has a model: they follow it, its window and point.
    s.store.agentModels.assignRole("rig-a", "teachers", {
      provider: "lab",
      model: "wide-model",
      compactAt: 70,
    });
    const c = cells(await s.page(), "synthesizer");
    assert.equal(c.ctx, "as the first teacher: 204,800 · 70%");
    assert.equal(c.runs, "as the first teacher");
  });

  test("a model posted on either line is kept, reaches the rig's routes, and goes back to the first teacher's when emptied", async () => {
    const s = await stack();
    const said = await s.post({
      ...formOf(await s.page()),
      role_synthesizer: "lab|strong-model",
      harness_synthesizer: "codex",
      effort_synthesizer: "high",
      context_synthesizer: "131072",
      compact_synthesizer: "75",
      role_final_writer: "lab|wide-model",
      harness_final_writer: "pi",
    });
    assert.match(
      said,
      /ok=Control sent a model for the synthesizer and a model for the final writer to rig-a\./,
    );
    const roles = s.store.agentModels.byRole("rig-a");
    assert.deepEqual(
      [
        roles.synthesizer?.model,
        roles.synthesizer?.harness,
        roles.synthesizer?.effort,
        roles.synthesizer?.contextCap,
        roles.synthesizer?.compactAt,
      ],
      ["strong-model", "codex", "high", 131_072, 75],
    );
    assert.equal(roles.final_writer?.model, "wide-model");
    const routes = await s.advisorRoutes();
    assert.deepEqual(
      [routes.synthesizer?.model, routes.synthesizer?.harness, routes.final_writer?.model],
      ["strong-model", "codex", "wide-model"],
    );
    let html = await s.page();
    assert.match(
      lineOf(html, "synthesizer"),
      /<option value="lab\|strong-model"[^>]* selected>strong-model<\/option>/,
    );
    assert.match(lineOf(html, "synthesizer"), /<b>131,072<\/b> · <b>75%<\/b>/);
    // The same form again changes nothing.
    assert.match(await s.post(formOf(html)), /ok=Nothing changed\./);
    // Emptied: back to the first teacher's model, in the line's words.
    html = await s.page();
    assert.match(
      await s.post({ ...formOf(html), role_final_writer: "", harness_final_writer: "" }),
      /ok=Control sent the final writer back to the first teacher's model to rig-a\./,
    );
    assert.equal(s.store.agentModels.byRole("rig-a").final_writer, undefined);
    assert.equal((await s.advisorRoutes()).final_writer, null);
    // The teachers emptied keep them: they have models of their own.
    assert.equal(s.store.agentModels.byRole("rig-a").synthesizer?.model, "strong-model");
  });
});
