import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { CampaignDraft } from "../../../../src/control/campaigns/builder.ts";
import {
  campaignContextRefusal,
  contextApplies,
  type OwnModel,
  ownModels,
  rigContext,
} from "../../../../src/control/campaigns/context.ts";
import { startCampaign } from "../../../../src/control/campaigns/new.ts";
import { KitRepos } from "../../../../src/control/kits/repos.ts";
import { SecretBox } from "../../../../src/control/secrets.ts";
import { ControlStore } from "../../../../src/control/store/index.ts";
import {
  CAMPAIGN_CONTEXT_JS,
  CC_CORE_JS,
} from "../../../../src/control/ui/campaigns/context/client.ts";
import { agentsContextRefusal } from "../../../../src/core/compaction.ts";
import { controlOnly, signIn } from "../../../helpers/control-stack.ts";
import { ingestReport } from "../../../helpers/control-store.ts";

/**
 * A campaign's Agents' context on the screens (goal 070, as the owner approved the revised
 * mockup): its page (the two fields, the help line, what applies on each rig, Save), Start a run's
 * line, the Copy panel and New campaign's step 4. Forms are posted as a browser posts them.
 */

const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";
const CPU = { type: "cpu", class: "generic-cpu" };
const draft: CampaignDraft = {
  mode: "hill_climb",
  campaign: "matmul-speed",
  title: "Make the matrix multiply faster",
  target: CPU,
  project: {
    url: "https://git.example.com/team/fastmat.git",
    commit: C,
    repo: "fastmat",
    editable_paths: ["src/kernels/**"],
  },
  kit: {
    source: "here",
    build: "make bench",
    outputs: ["bench"],
    cases: [{ name: "small", params: { n: 64 }, work: 524288 }],
    run: "{build}/bench --n {n} --out {out}/result.txt",
    check: "test -s {out}/result.txt",
  },
  score: { name: "throughput", unit: "FLOP/s" },
};

const hardware = (type: string) => ({
  collected_at: "2026-10-21T01:00:00Z",
  target: { type, class: type === "cpu" ? "generic-cpu" : "Example GPU", id: `${type}-1` },
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
 * Control with three rigs: rig-a (CPU) whose workers run wide-model (204,800 tokens), rig-b (CPU)
 * whose workers run narrow-model (131,072) and whose auditor runs tiny-model (100,000), and rig-g
 * (a GPU: other hardware). matmul-speed is saved once on the New campaign page. The owner is
 * signed in.
 */
async function stack() {
  const secrets = SecretBox.ephemeral();
  const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
  const { keys, store, control } = controlOnly({
    tokens: { rigs: {} },
    options: { staleAfterMs: 600_000, kits, secrets },
  });
  for (const [rig, type, model] of [
    ["rig-a", "cpu", "wide-model"],
    ["rig-b", "cpu", "narrow-model"],
    ["rig-g", "cuda-gpu", "wide-model"],
  ] as const)
    await ingestReport(store, {
      rig,
      ledger_id: `ledger-${rig}`,
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary: {
        model: { source: "control", name: "lab", version: 1, model, harness: "pi" },
        hardware: hardware(type),
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
    { id: "tiny-model", context_window: 100_000 },
  ]);
  store.agentModels.assignRig("rig-a", { provider: "lab", model: "wide-model", harness: "pi" });
  store.agentModels.assignRig("rig-b", { provider: "lab", model: "narrow-model", harness: "pi" });
  store.agentModels.assignRole("rig-b", "auditor", { provider: "lab", model: "tiny-model" });
  const saved = await startCampaign(
    { store, kits, privateKeyPem: keys.privateKeyPem },
    { draft, rig: "rig-a", target: CPU, start: false, by: "owner:ui" },
  );
  assert.ok(saved.ok);
  const session = await signIn(control);
  const { page } = session;
  const csrf = session.csrfOf(await page("/ui/campaigns/matmul-speed"));
  /** Posts a form as the page does: with the page's token. */
  const post = async (path: string, form: Record<string, string>) => {
    const r = await session.post(path, { csrf, ...form });
    return { status: r.status, to: decodeURIComponent(r.headers.get("location") ?? ""), r };
  };
  const contract = (campaign: string) =>
    store.campaigns.versions(campaign)[0]?.contract as
      | { version: number; agents_context?: Record<string, number> }
      | undefined;
  return { store, page, post, contract };
}

const unesc = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];
/** What a browser posts for the form whose opening tag matches `at`: its named, enabled fields. */
function formOf(html: string, at: string): Record<string, string> {
  const i = html.indexOf(at);
  assert.ok(i >= 0, `the page has ${at}`);
  const f = html.slice(i, html.indexOf("</form>", i));
  const out: Record<string, string> = {};
  for (const m of f.matchAll(/<input\b([^>]*)>/g)) {
    const a = m[1] ?? "";
    const name = attr(a, "name");
    if (!name || /(?:^|\s)disabled(?:\s|$|=)/.test(a)) continue;
    const type = attr(a, "type") ?? "text";
    if ((type === "checkbox" || type === "radio") && !/(?:^|\s)checked(?:\s|$|=)/.test(a)) continue;
    out[name] = unesc(attr(a, "value") ?? "");
  }
  return out;
}
/** The campaign page's Agents' context block, alone. */
const blockOf = (html: string) => {
  const i = html.indexOf('<div class="block" id="agents-context">');
  assert.ok(i >= 0, "the page has its Agents' context");
  return html.slice(i, html.indexOf("</form>", i));
};
const rowOf = (html: string, rig: string) => {
  const i = html.indexOf(`data-cc-row="${rig}"`);
  return i < 0 ? "" : html.slice(i, html.indexOf("</tr>", i));
};

describe("a campaign's Agents' context on the screens (goal 070)", () => {
  test("its page: two fields, one help line, what applies on each rig; Save makes a new version, or says why not", async () => {
    const s = await stack();
    let html = await s.page("/ui/campaigns/matmul-speed");
    let block = blockOf(html);
    assert.match(
      block,
      /<h2>Agents' context<\/h2><span class="right">every run of matmul-speed<\/span>/,
    );
    assert.match(block, /<form method="post" action="\/ui\/campaigns\/matmul-speed\/context"/);
    // The two fields with their info icons, empty, and the one help line.
    assert.match(
      block,
      /<span class="lb">Context window<i class="ii" tabindex="0" data-tip="[^"]+">i<\/i><\/span><span class="cc-in"><input name="context_window" data-cc-cw value=""/,
    );
    assert.match(
      block,
      /<span class="lb">Compact at<i class="ii" tabindex="0" data-tip="[^"]+">i<\/i><\/span><span class="cc-in"><input name="compact_at" data-cc-ca value=""/,
    );
    assert.match(
      block,
      /<div class="cc-help">Empty: the rig's\. A number applies to every agent of its runs, on any rig\.<\/div>/,
    );
    assert.match(block, /<span class="lb">What applies on each rig<i class="ii"/);
    // One row for each rig that can run it (not the GPU rig): the rig's own, in plain.
    assert.match(
      rowOf(block, "rig-a"),
      /<td class="num">204,800<\/td><td class="num">80%<\/td><td><span class="cc-st ok">ok<\/span>/,
    );
    assert.match(rowOf(block, "rig-b"), /<td class="num">131,072<\/td><td class="num">80%<\/td>/);
    assert.equal(rowOf(block, "rig-g"), "");
    assert.match(html, /<script src="\/ui\/assets\/campaign-context\.js" defer><\/script>/);
    assert.match(block, /POST \/v1\/campaigns\/matmul-speed\/context/);
    assert.match(block, /thermite campaign context matmul-speed\. MCP: set_campaign_context/);

    // Save, as a browser posts the form: a new version with the numbers.
    const form = formOf(html, 'action="/ui/campaigns/matmul-speed/context"');
    let r = await s.post("/ui/campaigns/matmul-speed/context", {
      ...form,
      context_window: "131,072",
      compact_at: "70",
    });
    assert.match(
      r.to,
      /\?on=context&ok=Saved as version 2: 131,072 tokens at 70%\. New runs of matmul-speed take it\.#agents-context$/,
    );
    assert.deepEqual(s.contract("matmul-speed")?.agents_context, {
      context_window: 131_072,
      compact_at: 70,
    });
    html = await s.page("/ui/campaigns/matmul-speed?on=context&ok=Saved");
    block = blockOf(html);
    assert.match(block, /<b class="ok">Saved<\/b>/);
    assert.match(block, /name="context_window" data-cc-cw value="131072"/);
    assert.match(block, /name="compact_at" data-cc-ca value="70"/);
    // The campaign's numbers in bold; on rig-b its auditor's tiny-model takes less: no run there.
    assert.match(rowOf(block, "rig-a"), /<b>131,072<\/b><\/td><td class="num"><b>70%<\/b>/);
    assert.match(rowOf(block, "rig-b"), /can't start: tiny-model takes at most 100,000/);
    assert.match(block, /&quot;context_window&quot;: 131072,\n {2}&quot;compact_at&quot;: 70/);
    // The same again changes nothing; a field that is not a number, or out of range, is refused
    // in words, and the fields show what was typed.
    r = await s.post("/ui/campaigns/matmul-speed/context", {
      ...form,
      context_window: "131072",
      compact_at: "70",
    });
    assert.match(r.to, /ok=Nothing changed: version 2 has these numbers already\./);
    for (const [cw, ca, words] of [
      ["big", "", /error=Write the number of tokens in digits, such as 131072\./],
      [
        "1000",
        "",
        /error=A context window is a whole number of tokens from 4,096 to 100,000,000\./,
      ],
      [
        "",
        "99",
        /error=The compaction point is a whole percent of the context window, from 50 to 95\./,
      ],
    ] as const) {
      r = await s.post("/ui/campaigns/matmul-speed/context", {
        ...form,
        context_window: cw,
        compact_at: ca,
      });
      assert.match(r.to, words);
      assert.equal(s.contract("matmul-speed")?.version, 2);
    }
    html = await s.page(
      `/ui/campaigns/matmul-speed${r.to.slice(r.to.indexOf("?")).replace(/#.*$/, "")}`,
    );
    block = blockOf(html);
    assert.match(block, /<b class="bad">Not saved\.<\/b> The compaction point/);
    assert.match(block, /name="compact_at" data-cc-ca value="99"/);
    // Both fields empty: each agent keeps the rig's again.
    r = await s.post("/ui/campaigns/matmul-speed/context", {
      ...form,
      context_window: "",
      compact_at: "",
    });
    assert.match(r.to, /ok=Saved as version 3: the rig's, for each agent\./);
    assert.equal(s.contract("matmul-speed")?.agents_context, undefined);
    // The page's script is valid JavaScript.
    assert.doesNotThrow(() => new Function(CAMPAIGN_CONTEXT_JS));
  });

  test("Start a run says what the chosen rig's workers get, and marks a rig where a model takes less", async () => {
    const s = await stack();
    let html = await s.page("/ui/campaigns/matmul-speed?start=1");
    // Nothing set: each rig's own, and a link to set it.
    assert.match(
      html,
      /<div class="small cc-line" data-cc-line="rig-a">On rig-a, the workers get 204,800 tokens and compact at 80%\. <a href="\/ui\/campaigns\/matmul-speed#agents-context" data-close-to="#agents-context">Set this campaign's context<\/a><\/div>/,
    );
    assert.match(html, /<div class="small cc-line" data-cc-line="rig-b" hidden>/);
    assert.match(html, /<span class="cc-rignote">Workers' window: 204,800\.<\/span>/);
    await s.post("/ui/campaigns/matmul-speed/context", {
      context_window: "131072",
      compact_at: "70",
    });
    html = await s.page("/ui/campaigns/matmul-speed?start=1");
    assert.match(
      html,
      /data-cc-line="rig-a">On rig-a, the workers get <b>131,072<\/b> tokens and compact at <b>70%<\/b>\. <a [^>]*>Change this campaign's context<\/a>/,
    );
    assert.match(html, /<span class="cc-rignote">Workers' window: 131,072\.<\/span>/);
    // rig-b: its auditor's model takes less. The option says so, and the page's script keeps
    // Start the run off there.
    assert.match(
      html,
      /<input type="radio" name="rig" value="rig-b" data-model="narrow-model" data-cc-refused>/,
    );
    assert.match(
      html,
      /<span class="cc-rignote bad">Can't start: tiny-model takes at most 100,000 tokens\.<\/span>/,
    );
    // Control refuses it too, in words, whatever the page sends.
    const r = await s.post("/ui/campaigns/matmul-speed/runs", { rig: "rig-b", agents: "on" });
    assert.match(
      r.to,
      /error=.*tiny-model, the model of the auditor on rig-b, takes at most 100,000 tokens/,
    );
  });

  test("the Copy panel starts with the source's context; a copy keeps it, takes its own, or none", async () => {
    const s = await stack();
    await s.post("/ui/campaigns/matmul-speed/context", {
      context_window: "131072",
      compact_at: "70",
    });
    const html = await s.page("/ui/campaigns/matmul-speed?copy=1");
    const copy = html.slice(html.indexOf('<aside class="drawer" aria-label="Copy the campaign">'));
    assert.match(copy, /<span class="lb">Agents' context<i class="ii"/);
    assert.match(copy, /name="context_window" data-cc-cw value="131072"/);
    assert.match(
      copy,
      /<div class="cc-say" data-cc-say aria-live="polite"><span class="ok">✓ As matmul-speed\.<\/span><\/div>/,
    );
    const form = formOf(html, 'action="/ui/campaigns/matmul-speed/copy"');
    // As the source's: the copy's contract has the same.
    let r = await s.post("/ui/campaigns/matmul-speed/copy", { ...form, name: "same-copy" });
    assert.match(r.to, /ok=Copied matmul-speed version 2 as same-copy\.$/);
    assert.deepEqual(s.contract("same-copy")?.agents_context, {
      context_window: 131_072,
      compact_at: 70,
    });
    // Its own: only the window.
    r = await s.post("/ui/campaigns/matmul-speed/copy", {
      ...form,
      name: "own-copy",
      context_window: "65536",
      compact_at: "",
    });
    assert.match(r.to, /Agents' context: 65,536 tokens\.$/);
    assert.deepEqual(s.contract("own-copy")?.agents_context, { context_window: 65_536 });
    // None: each agent keeps the rig's.
    r = await s.post("/ui/campaigns/matmul-speed/copy", {
      ...form,
      name: "no-context",
      context_window: "",
      compact_at: "",
    });
    assert.equal(s.contract("no-context")?.agents_context, undefined);
    // Refused in words: the panel again, with what was typed.
    r = await s.post("/ui/campaigns/matmul-speed/copy", {
      ...form,
      name: "bad-copy",
      compact_at: "40",
    });
    const again = await r.r.text();
    assert.match(
      again,
      /<b class="bad">Not copied\.<\/b> The compaction point is a whole percent of the context window, from 50 to 95\./,
    );
    assert.match(again, /name="compact_at" data-cc-ca value="40"/);
    assert.equal(s.contract("bad-copy"), undefined);
  });

  test("New campaign: the two fields in step 4, the rigs' agents for the script, the numbers in the contract or refused in words", async () => {
    const s = await stack();
    const html = await s.page("/ui/campaigns/new");
    const where = html.slice(html.indexOf('data-pane="where"'), html.indexOf('data-pane="review"'));
    assert.match(
      where,
      /<div class="sec cc-sec" data-cc-rigs="[^"]+"><h2>Agents' context<\/h2><div class="cc" data-cc="new">/,
    );
    assert.ok(where.indexOf("Agents' context") < where.indexOf("<summary>Advanced</summary>"));
    const rigs = JSON.parse(unesc(/data-cc-rigs="([^"]+)"/.exec(where)?.[1] ?? "{}")) as Record<
      string,
      OwnModel[]
    >;
    assert.deepEqual(
      rigs["rig-b"]?.map((a) => [a.agent, a.model, a.listed]),
      [
        ["workers", "narrow-model", 131_072],
        ["auditor", "tiny-model", 100_000],
      ],
    );
    assert.match(
      where,
      /<option value="lab\|tiny-model" data-window="100000">tiny-model<\/option>/,
    );
    // Saved with the numbers, as the page's script sends them in the draft.
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";
    const send = (agents_context: Record<string, number>, campaign: string) =>
      s.post("/ui/campaigns/new", {
        csrf,
        rig: "rig-a",
        start_value: "save",
        draft: JSON.stringify({ ...draft, campaign, target: undefined, agents_context }),
      });
    let r = await send({ context_window: 131_072, compact_at: 70 }, "with-context");
    assert.equal(r.status, 303);
    assert.deepEqual(s.contract("with-context")?.agents_context, {
      context_window: 131_072,
      compact_at: 70,
    });
    r = await send({ compact_at: 99 }, "bad-context");
    assert.match(
      await r.r.text(),
      /The agents' context: The compaction point is a whole percent of the context window, from 50 to 95\./,
    );
    assert.equal(s.contract("bad-context"), undefined);
  });

  test("the page's script checks as control does: the fields' words, what applies and the refusal", () => {
    const core = new Function(`${CC_CORE_JS}; return { ccRead, ccApply, ccShort };`)() as {
      ccRead: (w: string, p: string) => { cw: number | null; at: number | null; errs: string[] };
      ccApply: (own: OwnModel[], c: { cw: number | null; at: number | null }) => unknown;
      ccShort: (c: { cw: number | null; at: number | null }) => string;
    };
    // The fields' words are control's.
    for (const [w, p] of [
      ["1000", ""],
      ["", "99"],
      ["200000000", "50"],
      ["", "49%"],
    ] as const) {
      const said = core.ccRead(w, p).errs.join(" ");
      assert.equal(
        said,
        agentsContextRefusal({
          ...(w ? { context_window: Number(w) } : {}),
          ...(p ? { compact_at: Number(p.replace("%", "")) } : {}),
        }),
      );
    }
    assert.deepEqual(core.ccRead("131,072", "70%"), {
      cw: 131_072,
      at: 70,
      errs: [],
      cwBad: false,
      atBad: false,
    });
    assert.match(core.ccRead("big", "").errs.join(""), /in digits/);
    assert.equal(core.ccShort({ cw: 131_072, at: 70 }), "131,072 tokens at 70%");
    // What applies, and the refusal, as rigContext says it, and as control decides it.
    const s = new ControlStore(":memory:");
    s.modelProviders.put({
      name: "lab",
      type: "openai",
      base_url: "https://models.example.com/v1",
      key: { sealed: SecretBox.ephemeral().seal("lab-key-for-tests"), hint: "…ests" },
    });
    s.modelProviders.setModels("lab", [
      { id: "wide-model", context_window: 204_800 },
      { id: "tiny-model", context_window: 100_000 },
      { id: "open-model" },
    ]);
    s.agentModels.assignRig("rig-a", {
      provider: "lab",
      model: "wide-model",
      harness: "pi",
      contextCap: 65_536,
      compactAt: 75,
    });
    s.agentModels.assignRig("rig-b", { provider: "lab", model: "open-model", harness: "pi" });
    s.agentModels.assignRole("rig-b", "auditor", { provider: "lab", model: "tiny-model" });
    for (const rig of ["rig-a", "rig-b", "rig-c"])
      for (const c of [
        {},
        { context_window: 131_072 },
        { compact_at: 60 },
        { context_window: 50_000, compact_at: 90 },
      ]) {
        const contract = { mode: "hill_climb", agents_context: c };
        const own = ownModels(s, rig, "hill_climb");
        const want = rigContext(own, Object.keys(c).length ? c : undefined);
        assert.deepEqual(
          core.ccApply(own, { cw: c.context_window ?? null, at: c.compact_at ?? null }),
          want,
          `${rig} with ${JSON.stringify(c)}`,
        );
        // Control's own answers: Start a run's workers, and its refusal.
        const applies = contextApplies(s, rig, contract);
        if (applies?.agents.workers?.model)
          assert.equal(want.window, applies.agents.workers.context_window);
        assert.equal(Boolean(want.refused), campaignContextRefusal(s, rig, contract) !== "");
      }
  });
});
