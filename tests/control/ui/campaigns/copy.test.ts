import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { CampaignDraft } from "../../../../src/control/campaigns/builder.ts";
import { startCampaign } from "../../../../src/control/campaigns/new.ts";
import { KitRepos } from "../../../../src/control/kits/repos.ts";
import { McpServers } from "../../../../src/control/mcp-servers/index.ts";
import { SecretBox } from "../../../../src/control/secrets.ts";
import { controlOnly, signIn } from "../../../helpers/control-stack.ts";
import { controlStore, ingestReport } from "../../../helpers/control-store.ts";

/**
 * Copy on a campaign's page (goal 069), driven as a browser drives it without the page's script:
 * the Copy panel's form is read from the page's HTML, changed as a person would change it (a
 * name typed, a server ticked, a tool unticked), and posted. Control answers with the copy's page,
 * or with the panel again and its refusal in words. The script's own checks are in
 * ui/copy-campaign-client.test.ts.
 */

const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";
const CPU = { type: "cpu", class: "generic-cpu" };

/** A hill climb whose kit names one server for its workers, as the New campaign page saves it. */
const hill: CampaignDraft = {
  mode: "hill_climb",
  campaign: "matmul-speed",
  title: "Make the matrix multiply faster",
  target: { type: "x", class: "x" },
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
  mcp_servers: [{ name: "web-search", agents: ["workers"], tools: { workers: ["search"] } }],
};

/** A research campaign whose workers use web-search (the page sets the target from the rig). */
const research: Omit<CampaignDraft, "target"> = {
  mode: "research",
  campaign: "web-survey",
  title: "Survey 2-bit decoding",
  research: { topic: "2-bit decoding", questions: ["Which papers help?"], min_duration: "1h" },
  mcp_servers: [{ name: "web-search", agents: ["workers"] }],
};

/**
 * Control with kits, a CPU rig (rig-a) that reported, two MCP servers in Settings whose tools
 * control read (web-search: search, extract; paper-search: find), matmul-speed saved twice and
 * web-survey once; signed in to the dashboard.
 */
async function stack() {
  const store = controlStore();
  const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
  const secrets = SecretBox.ephemeral();
  const listed: Record<string, string[]> = {
    "web-search": ["search", "extract"],
    "paper-search": ["find"],
  };
  const servers = new McpServers(store, secrets, {
    connect: async (url) => ({
      listTools: async () =>
        (listed[new URL(url).hostname.split(".")[0] ?? ""] ?? []).map((name) => ({ name })),
      callTool: async () => ({}),
      close: async () => {},
    }),
  });
  for (const name of Object.keys(listed)) {
    servers.put({ name, url: `https://${name}.example.com/mcp`, auth: "none" }, "owner:test");
    assert.equal(await servers.check(name), null);
  }
  const { keys, control } = controlOnly({
    store,
    tokens: { rigs: {} },
    options: { staleAfterMs: 600_000, kits, secrets, mcpServers: servers },
  });
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "ledger-rig-a",
    cursor: 0,
    next: 0,
    generated_at: new Date().toISOString(),
    events: [],
    summary: {
      hardware: {
        collected_at: new Date().toISOString(),
        target: { ...CPU, id: "cpu-1" },
        device_mode: "none",
        devices: [],
        cpu: { model: "Example CPU", host: 8, usable: 8, quota: null },
        memory: { host_mib: 16_000, limit_mib: null },
        disks: [],
        os: { kernel: "6.8", arch: "x64", node: "v22", image: null },
        toolchain: { cc: "cc 12", nvcc: null },
        errors: [],
      },
    },
  });
  const deps = { store, kits, privateKeyPem: keys.privateKeyPem };
  for (const draft of [hill, hill, research]) {
    const saved = await startCampaign(deps, {
      draft,
      rig: "rig-a",
      target: CPU,
      start: false,
      by: "owner:ui",
    });
    assert.ok(saved.ok, JSON.stringify(saved));
  }
  const { get, post } = await signIn(control);
  const page = async (path: string) => {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    return r.text();
  };
  return { store, get, page, post };
}

const unesc = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unesc(m[1] ?? "") : undefined;
};

interface Field {
  name: string;
  value: string;
  type: string;
  on: boolean;
}
interface CopyForm {
  action: string;
  html: string;
  data: { from: string; taken: string[]; folderOnly: string[]; source: unknown[] };
  fields: Field[];
}

/** The Copy panel's form as the page drew it: where it posts, and every field it has. */
function copyForm(html: string): CopyForm {
  const f =
    /<form method="post" action="([^"]+)" class="drawer-form" data-copy="([^"]*)"[\s\S]*?<\/form>/.exec(
      html,
    );
  assert.ok(f, "the page has the Copy panel");
  const fields: Field[] = [];
  for (const [tag] of f[0].matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, "name");
    if (!name) continue;
    const type = attr(tag, "type") ?? "text";
    fields.push({
      name,
      value: attr(tag, "value") ?? "",
      type,
      on: type !== "checkbox" || /\schecked\b/.test(tag),
    });
  }
  return {
    action: unesc(f[1] ?? ""),
    html: f[0],
    data: JSON.parse(unesc(f[2] ?? "")),
    fields,
  };
}
/** Ticks or unticks a box, as a person does. */
function tick(form: CopyForm, name: string, value: string, on = true) {
  const box = form.fields.find((x) => x.name === name && x.value === value);
  assert.ok(box, `the panel has the box ${name}=${value}`);
  box.on = on;
}
/** Types into a field. */
function type(form: CopyForm, name: string, value: string) {
  const field = form.fields.find((x) => x.name === name);
  assert.ok(field, `the panel has the field ${name}`);
  field.value = value;
}
/** What a browser sends: every field but the boxes left unticked. */
const sent = (form: CopyForm) =>
  new URLSearchParams(
    form.fields.filter((x) => x.on).map((x): [string, string] => [x.name, x.value]),
  );

/** Every label in the panel has an info icon, but tick boxes whose words are their own label. */
function everyLabelExplained(form: CopyForm) {
  const labels = form.html.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) ?? [];
  assert.ok(labels.length > 0);
  let fields = 0;
  for (const l of labels) {
    // A server's name beside its box, and an agent's chip, are the box's own words.
    if (/^<label for="c-srv-/.test(l) || /data-who=/.test(l)) continue;
    fields++;
    assert.match(l, /class="ii" tabindex="0" data-tip="[^"]+"/, l.slice(0, 200));
  }
  assert.ok(fields > 0, "the panel has a field with a label");
  const lbs = form.html.match(/class="lb"/g)?.length ?? 0;
  const tips = form.html.match(/class="ii" tabindex="0" data-tip="[^"]+"/g)?.length ?? 0;
  assert.equal(tips, lbs, "every label in the panel has its description");
}

describe("Copy on a campaign's page (goal 069)", () => {
  test("a hill-climb copy: Copy beside Start a run, the panel, and the copy's page", async () => {
    const s = await stack();
    const html = await s.page("/ui/campaigns/matmul-speed");
    // Copy, then Start a run, at the top of the page; the panel closed until asked for.
    assert.match(
      html,
      /<div class="actions"><a class="btn" href="\/ui\/campaigns\/matmul-speed\?copy=1" data-open="#copy"><svg[^>]*>[\s\S]*?<\/svg>Copy<\/a><a class="btn primary" href="\/ui\/campaigns\/matmul-speed\?start=1" data-open="#start">/,
    );
    assert.match(html, /<div class="drawer-wrap" id="copy" hidden>/);
    assert.match(html, /<script src="\/ui\/assets\/copy\.js" defer><\/script>/);
    const js = await s.get("/ui/assets/copy.js");
    assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(await js.text(), /nameCheck/);

    // ?copy=1 opens it, as the button does without the page's script.
    const open = await s.page("/ui/campaigns/matmul-speed?copy=1");
    assert.match(open, /<div class="drawer-wrap" id="copy">/);
    const form = copyForm(open);
    assert.equal(form.action, "/ui/campaigns/matmul-speed/copy");
    assert.match(form.html, /<h3>Copy matmul-speed<\/h3>/);
    assert.match(
      form.html,
      /Copy it to start from zero: the copy gets its own empty collection in the knowledge base, so its runs read nothing that the runs of <b>matmul-speed<\/b> recorded\./,
    );
    // A free name to start with, and what its runs are called.
    assert.equal(form.fields.find((x) => x.name === "name")?.value, "matmul-speed-b");
    assert.match(
      form.html,
      /✓ Free\. Its runs are named matmul-speed-b-1, matmul-speed-b-2, and so on\./,
    );
    // Its kit's servers, read only: a copy has the same kit.json.
    assert.ok(!form.fields.some((x) => x.name === "srv" || x.name === "mcp"));
    assert.match(
      form.html,
      /<b>web-search<\/b> <span class="muted small">for the workers<\/span><\/span><span class="ck-what">The workers get 1 of its 2 tools\.<\/span>/,
    );
    assert.match(form.html, /✓ in Settings/);
    assert.match(form.html, /This campaign's MCP servers are in its kit's kit\.json/);
    assert.match(
      form.html,
      /<pre class="json cp-req" data-c-json>POST \/v1\/campaigns\/matmul-speed\/copy\n\{\n {2}&quot;name&quot;: &quot;matmul-speed-b&quot;\n\}<\/pre>/,
    );
    assert.match(
      form.html,
      /Copies version 2 of matmul-speed: the same contract and kit, with the new name\. No runs yet\./,
    );
    everyLabelExplained(form);
    // Names a copy may not take, for the script's check as you type.
    assert.ok(form.data.taken.includes("matmul-speed") && form.data.taken.includes("web-survey"));

    // Copy, as drawn: the copy's page.
    const r = await s.post(form.action, sent(form));
    assert.equal(r.status, 303, await r.clone().text());
    const to = r.headers.get("location") ?? "";
    assert.equal(
      decodeURIComponent(to),
      "/ui/campaigns/matmul-speed-b?ok=Copied matmul-speed version 2 as matmul-speed-b.",
    );
    const [source] = s.store.campaigns.versions("matmul-speed");
    const [copy] = s.store.campaigns.versions("matmul-speed-b");
    assert.ok(source && copy);
    assert.deepEqual(copy.copied_from, { campaign: "matmul-speed", version: 2 });
    assert.equal(copy.created_by, "owner:ui");
    assert.deepEqual(copy.sources, source.sources);
    assert.equal((copy.contract as { campaign: string }).campaign, "matmul-speed-b");
    assert.ok(
      s.store.auditLog
        .list(50)
        .some((a) => a.action === "campaign_copied" && a.actor === "owner:ui"),
    );
    const page = await s.page(to);
    assert.match(page, /<b class="ok">Copied matmul-speed version 2 as matmul-speed-b\.<\/b>/);
    assert.match(
      page,
      /Copied from<\/span> <a href="\/ui\/campaigns\/matmul-speed">matmul-speed version 2<\/a> <span class="muted">by you, just now\. Its collection in the knowledge base started empty\.<\/span>/,
    );
    assert.match(
      page,
      /Saved on control, with no run yet\. <a class="btn sm primary" href="\/ui\/campaigns\/matmul-speed-b\?start=1" data-open="#start"[^>]*><svg[^>]*>[\s\S]*?<\/svg>Start a run of matmul-speed-b<\/a>/,
    );
    assert.match(page, /None: its agents read only this campaign's collection\./);
    // A copy can be copied too: its panel offers the next free name.
    assert.equal(copyForm(page).fields.find((x) => x.name === "name")?.value, "matmul-speed-c");

    // Start a run of the copy, from its page: its own contract goes to the rig.
    const start =
      /<form method="post" action="(\/ui\/campaigns\/matmul-speed-b\/runs)"[\s\S]*?<\/form>/.exec(
        page,
      );
    assert.ok(start);
    const csrf = attr(/<input type="hidden" name="csrf"[^>]*>/.exec(start[0])?.[0] ?? "", "value");
    const run = await s.post(
      start[1] ?? "",
      new URLSearchParams({ csrf: csrf ?? "", rig: "rig-a", agents: "off" }),
    );
    assert.equal(run.status, 303, await run.clone().text());
    assert.match(
      decodeURIComponent(run.headers.get("location") ?? ""),
      /\/ui\/campaigns\/matmul-speed-b\/runs\/matmul-speed-b-try-1$/,
    );
    const signed = s.store.db
      .prepare("select signed from command where kind = 'assign_campaign'")
      .all() as { signed: string }[];
    const payload = JSON.parse(signed.at(-1)?.signed ?? "{}").envelope.payload;
    assert.equal(payload.contract.campaign, "matmul-speed-b");
    assert.equal(payload.contract_sha, copy.sha);
  });

  test("a research copy: its MCP servers as the source has them, one narrowed and one added", async () => {
    const s = await stack();
    const form = copyForm(await s.page("/ui/campaigns/web-survey?copy=1"));
    // Each server in Settings, for the workers and the advisors only: a research run has no planner.
    assert.match(form.html, /data-srv="web-search" data-tools="2"/);
    assert.match(form.html, /data-srv="paper-search" data-tools="1"/);
    assert.ok(!/data-who="planner"/.test(form.html));
    assert.deepEqual(
      form.fields.filter((x) => x.on && x.type === "checkbox").map((x) => `${x.name}=${x.value}`),
      [
        // A server not ticked keeps every tool ticked, for when it is.
        "tool:paper-search:workers=find",
        "tool:paper-search:advisors=find",
        "srv=web-search",
        "who:web-search=workers",
        "tool:web-search:workers=search",
        "tool:web-search:advisors=search",
        "tool:web-search:workers=extract",
        "tool:web-search:advisors=extract",
      ],
    );
    assert.match(form.html, /<span class="ok">✓ The same as web-survey\.<\/span>/);
    assert.match(
      form.html,
      /<button type="button" class="sm" data-c-mcp-reset hidden>Use the servers of web-survey again<\/button>/,
    );
    assert.match(
      form.html,
      /Copies version 1 of web-survey: the same contract, with the new name\./,
    );
    everyLabelExplained(form);

    // The workers keep only search of web-search; paper-search goes to the workers and advisors.
    tick(form, "tool:web-search:workers", "extract", false);
    tick(form, "srv", "paper-search");
    tick(form, "who:paper-search", "workers");
    tick(form, "who:paper-search", "advisors");
    type(form, "name", "web-survey-papers");
    const r = await s.post(form.action, sent(form));
    assert.equal(r.status, 303, await r.clone().text());
    const [copy] = s.store.campaigns.versions("web-survey-papers");
    assert.ok(copy);
    // In the panel's order, which is Settings'.
    assert.deepEqual((copy.contract as { mcp_servers: unknown }).mcp_servers, [
      { name: "paper-search", agents: ["workers", "advisors"] },
      { name: "web-search", agents: ["workers"], tools: { workers: ["search"] } },
    ]);
    assert.deepEqual(copy.copied_from, {
      campaign: "web-survey",
      version: 1,
      other_mcp_servers: true,
    });
    assert.match(
      await s.page(r.headers.get("location") ?? ""),
      /started empty\. Its agents use other MCP servers than its source's: paper-search \(workers; advisors\), web-search \(workers: search\)\./,
    );

    // As drawn, the servers are the source's: the copy's contract names them as it does.
    const same = copyForm(await s.page("/ui/campaigns/web-survey?copy=1"));
    type(same, "name", "web-survey-again");
    const r2 = await s.post(same.action, sent(same));
    assert.equal(r2.status, 303, await r2.clone().text());
    const [again] = s.store.campaigns.versions("web-survey-again");
    const [source] = s.store.campaigns.versions("web-survey");
    assert.ok(again && source);
    assert.deepEqual(again.copied_from, { campaign: "web-survey", version: 1 });
    assert.deepEqual(
      (again.contract as { mcp_servers: unknown }).mcp_servers,
      (source.contract as { mcp_servers: unknown }).mcp_servers,
    );

    // A server with no agent, and a kind of agent with no tool: refused in words, nothing saved.
    const before = s.store.campaigns.versions().length;
    const bad = copyForm(await s.page("/ui/campaigns/web-survey?copy=1"));
    tick(bad, "srv", "paper-search");
    tick(bad, "tool:web-search:workers", "search", false);
    tick(bad, "tool:web-search:workers", "extract", false);
    const refused = await s.post(bad.action, sent(bad));
    assert.equal(refused.status, 200);
    const again2 = copyForm(await refused.text());
    assert.match(
      again2.html,
      /<b class="bad">Not copied\.<\/b> Choose the agents that get paper-search, or untick it\. The workers get no tool of web-search: give them one, or untick workers\./,
    );
    // The panel comes back as it was sent: paper-search ticked, the source's list not kept.
    assert.ok(again2.fields.some((x) => x.name === "srv" && x.value === "paper-search" && x.on));
    assert.match(again2.html, /<b class="warn">Not as web-survey\.<\/b>/);
    assert.match(again2.html, /data-c-mcp-reset>Use the servers of web-survey again/);
    assert.equal(s.store.campaigns.versions().length, before);
  });

  test("a taken name and a name that is not valid: refused in words, the panel open again", async () => {
    const s = await stack();
    // A campaign known only by a grant in the knowledge base: its name is taken too.
    s.store.kb().grant("old-sweep", "matmul-speed", "owner:ui");
    const before = s.store.campaigns.versions().length;
    const form = copyForm(await s.page("/ui/campaigns/web-survey"));
    assert.ok(form.data.taken.includes("old-sweep"));
    assert.deepEqual(form.data.folderOnly, ["old-sweep"]);
    const refused = async (name: string, words: string) => {
      type(form, "name", name);
      const r = await s.post(form.action, sent(form));
      assert.equal(r.status, 200, name);
      const html = await r.text();
      assert.match(html, /<div class="drawer-wrap" id="copy">/, "the panel is open");
      const back = copyForm(html);
      assert.ok(back.html.includes(`<b class="bad">Not copied.</b> ${words}`), name);
      assert.equal(back.fields.find((x) => x.name === "name")?.value, name, "the name is kept");
    };
    await refused(
      "matmul-speed",
      "There is a campaign named matmul-speed already. Choose another name.",
    );
    await refused("old-sweep", "There is a campaign named old-sweep already. Choose another name.");
    await refused(
      "Web Survey",
      "A campaign's name is lowercase letters, digits, dashes and underscores, at most 64, starting with a letter or a digit.",
    );
    await refused(
      "rig-check-mine",
      "A name that starts with rig-check- is for rig checks. Choose another name.",
    );
    assert.equal(s.store.campaigns.versions().length, before, "nothing was saved");
    assert.ok(!s.store.auditLog.list(100).some((a) => a.action === "campaign_copied"));
  });

  test("a campaign control can't copy has no Copy: a rig check, and one control does not know", async () => {
    const s = await stack();
    await ingestReport(s.store, {
      rig: "rig-a",
      ledger_id: "ledger-rig-a",
      cursor: 0,
      next: 1,
      generated_at: new Date().toISOString(),
      events: [
        {
          id: 1,
          at: new Date().toISOString(),
          actor: "harness",
          kind: "run_created",
          subject: "rc-1",
          body: { campaign: "rig-check-smoke-cpu-1a2b3c4d", mode: "hill_climb", agents: false },
        },
      ],
      summary: {},
    });
    const check = await s.page("/ui/campaigns/rig-check-smoke-cpu-1a2b3c4d");
    assert.ok(!check.includes('?copy=1" data-open="#copy">'), "no Copy button");
    assert.ok(!check.includes('<div class="drawer-wrap" id="copy"'), "no Copy panel");
    const r = await s.post(
      "/ui/campaigns/rig-check-smoke-cpu-1a2b3c4d/copy",
      new URLSearchParams({
        csrf: copyCsrf(await s.page("/ui/campaigns/matmul-speed")),
        name: "smoke-b",
      }),
    );
    assert.equal(r.status, 400);
    assert.equal(
      await r.text(),
      "rig-check-smoke-cpu-1a2b3c4d is a rig check's campaign. A rig check cannot be copied.",
    );
    const nope = await s.post(
      "/ui/campaigns/nope/copy",
      new URLSearchParams({
        csrf: copyCsrf(await s.page("/ui/campaigns/matmul-speed")),
        name: "nope-b",
      }),
    );
    assert.equal(nope.status, 404);
    assert.equal(
      await nope.text(),
      "Control has no saved version or earlier assignment of nope. There is nothing to copy.",
    );
  });
});

/** The page's form token, from its Copy panel. */
const copyCsrf = (html: string) =>
  attr(/<input type="hidden" name="csrf"[^>]*>/.exec(copyForm(html).html)?.[0] ?? "", "value") ??
  "";
