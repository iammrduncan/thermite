import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { KitRepos } from "../../../../src/control/kits/repos.ts";
import {
  BRIEF_CORE_JS,
  briefPane,
  campaignBriefBlock,
} from "../../../../src/control/ui/campaigns/brief.ts";
import { NEW_CAMPAIGN_JS } from "../../../../src/control/ui/campaigns/new/client.ts";
import { MD_CORE_JS, mdHtml } from "../../../../src/control/ui/components/markdown.ts";
import { controlOnly, mcpClient, signIn } from "../../../helpers/control-stack.ts";
import { ingestReport } from "../../../helpers/control-store.ts";

/**
 * A campaign's brief on the screens and over the APIs (goal 078): New campaign takes it for every
 * mode, as the page's script sends it; the campaign's page shows it; Copy keeps it, and a copy
 * over REST or MCP may give its own.
 */

const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";
const CPU = { type: "cpu", class: "generic-cpu" };

/** The brief's page-free part, as the browser runs it. */
const core = new Function(
  `${BRIEF_CORE_JS}; return { briefDraft, briefSay, briefList, briefLinks, mdHtml };`,
)() as {
  briefDraft: (
    mode: string,
    f: { notes: string; links: string; ideas: string[]; hypotheses: string[] },
  ) => Record<string, unknown>;
  briefLinks: (text: string) => { links: string[]; bad: number[] };
  briefSay: (chars: number, bytes: number) => string;
  briefList: (xs: string[]) => string[];
  mdHtml: (s: string) => string;
};

/** Control with kits, a CPU rig that reported its hardware, and the owner signed in. */
async function stack() {
  const { store, control, api } = controlOnly({
    tokens: { rigs: {} },
    options: {
      staleAfterMs: 600_000,
      kits: new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-"))),
      probeRepo: async () => ({ commit: C, files: 3, suggest: ["src/**"] }),
    },
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
  const { page: get, csrfOf, post } = await signIn(control);
  const csrf = csrfOf(await get("/ui/campaigns/new"));
  /** New campaign's form, posted as the browser posts it: the draft as JSON, and the rig. */
  const submit = (draft: Record<string, unknown>, start = "save") =>
    post("/ui/campaigns/new", {
      csrf,
      draft: JSON.stringify(draft),
      rig: "rig-a",
      start_value: start,
    });
  const rest = (from: string, body: unknown) => api("POST", `/v1/campaigns/${from}/copy`, body);
  const contract = (campaign: string) =>
    store.campaigns.versions(campaign)[0]?.contract as Record<string, unknown> | undefined;
  return { store, control, get, submit, rest, contract };
}

/** The fields of the first step as the owner fills them, and the rest of a hill climb or goal. */
const NOTES = `## Background
We build **fastmat**: https://git.example.com/team/fastmat.

## What was tried
- Shared-memory tiling: no gain.
- Half-precision sums: they fail the check.

${"More background. ".repeat(3000)}`;
const fields = {
  notes: NOTES,
  links:
    "  https://git.example.com/team/fastmat/issues/12\n\nhttps://docs.example.com/fastmat/design  ",
  ideas: ["  Fuse the dequantize step.  ", "", "Load 128-bit vectors.\nThen unroll by 4."],
  hypotheses: ["It is memory bound at batch size 1.", "   "],
};
const codeDraft = (mode: "hill_climb" | "goal", over: Record<string, unknown> = {}) => ({
  mode,
  campaign: mode === "goal" ? "fastmat-goals" : "fastmat-speed",
  title: "Make the matrix multiply faster",
  lanes: 2,
  limits: {},
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
    cases: [{ name: "small", work: 524288 }],
    run: "{build}/bench --out {out}/result.txt",
    check: "test -s {out}/result.txt",
  },
  score: { kind: "time", min_effect: 0.05 },
  ...(mode === "goal"
    ? {
        goals: [
          { id: "builds-1", description: "It builds", verify: { type: "check", cells: ["small"] } },
        ],
      }
    : {}),
  ...core.briefDraft(mode, fields),
  ...over,
});

describe("a campaign's brief on the screens (goal 078)", () => {
  test("Markdown: escaped, with only the marks the brief uses, and the browser's copy is the page's", () => {
    const html = mdHtml(
      "# Title\nSee [the note](https://docs.example.com/a?x=1&y=2) and https://git.example.com/x.\n\n- one\n- two\n  more\n1. first\n\n> quoted <script>alert(1)</script>\n\n```sh\nmake <all>\n```\n**bold**, *it*, `code`, snake_case_name, [bad](javascript:alert(1))",
    );
    assert.match(html, /^<h3>Title<\/h3>/);
    assert.match(
      html,
      /<a href="https:\/\/docs\.example\.com\/a\?x=1&amp;y=2" rel="noopener noreferrer" target="_blank">the note<\/a>/,
    );
    assert.match(
      html,
      /<a href="https:\/\/git\.example\.com\/x"[^>]*>https:\/\/git\.example\.com\/x<\/a>\./,
    );
    assert.match(html, /<ul><li>one<\/li><li>two<br>more<\/li><\/ul><ol><li>first<\/li><\/ol>/);
    assert.match(
      html,
      /<blockquote><p>quoted &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p><\/blockquote>/,
    );
    assert.match(html, /<pre><code>make &lt;all&gt;<\/code><\/pre>/);
    assert.match(html, /<b>bold<\/b>, <i>it<\/i>, <code>code<\/code>, snake_case_name/);
    assert.doesNotMatch(html, /href="javascript/);
    assert.doesNotMatch(html, /<script/);
    const browser = new Function(`${MD_CORE_JS}; return mdHtml;`)() as (s: string) => string;
    assert.equal(browser(NOTES), mdHtml(NOTES));
    assert.equal(core.mdHtml("a\n\nb"), "<p>a</p><p>b</p>");
  });

  test("New campaign: the brief is its own step 2, for every mode, with an info icon on each label; Starting links under Additional information", async () => {
    const s = await stack();
    const page = await s.get("/ui/campaigns/new");
    // The steps, as the owner chose them on 2026-10-22: Aim, then The brief.
    assert.match(
      page,
      /<span class="k">1<\/span>Aim<\/li><li data-step="brief"><span class="k">2<\/span>The brief<\/li><li data-step="project" data-modes="hill_climb goal"><span class="k">3<\/span>Project<\/li><li data-step="measure" data-modes="hill_climb goal"><span class="k">4<\/span>How to measure<\/li><li data-step="research" data-modes="research"><span class="k">4<\/span>Time and tools<\/li><li data-step="where"><span class="k">5<\/span>Where it runs<\/li><li data-step="review"><span class="k">6<\/span>Review and start<\/li>/,
    );
    const aim = /<section class="pane" data-pane="aim"[\s\S]*?<\/section>/.exec(page)?.[0] ?? "";
    assert.doesNotMatch(aim, /The brief|name="notes"|name="topic"/);
    const brief =
      /<section class="pane" data-pane="brief"[\s\S]*?<\/section>/.exec(page)?.[0] ?? "";
    for (const label of [
      "Additional information",
      "Starting links",
      "Hypotheses",
      "Ideas to try",
      "Topic",
      "Questions",
    ])
      assert.match(
        brief,
        new RegExp(`<span class="lb">${label}<i class="ii" tabindex="0" data-tip="[^"]+">i</i>`),
        label,
      );
    assert.match(
      brief,
      /<div class="fd" data-modes="hill_climb goal"><span class="lb">Ideas to try/,
    );
    assert.match(brief, /<div data-modes="research"><label class="fd"><span class="lb">Topic/);
    // Starting links directly under Additional information; its tip says what is fetched.
    assert.match(
      brief,
      /<textarea name="notes" class="md-in"[\s\S]*?data-md-say>Markdown\. Empty is fine\.<\/div><\/div>\n<label class="fd"><span class="lb">Starting links<i class="ii" tabindex="0" data-tip="[^"]*Research: the harness fetches and archives them when the run starts\.[^"]*nothing fetches them first\.">i<\/i><\/span><textarea name="links"/,
    );
    assert.match(brief, /data-bl="questions"[\s\S]*data-bl-add="questions">Add a question</);
    assert.match(
      brief,
      /<button data-back>Back<\/button><button class="primary" data-next>Next<\/button>/,
    );
    // Research's step 4: how long it runs and its MCP servers; its links are in the brief.
    const research =
      /<section class="pane" data-pane="research"[\s\S]*?<\/section>/.exec(page)?.[0] ?? "";
    assert.match(research, /<h2>Time and tools<\/h2>/);
    assert.doesNotMatch(research, /name="topic"|Questions|Starting links|name="seeds"/);
    assert.match(research, /Run for at least/);
    assert.equal(page.match(/name="links"/g)?.length, 1);
    // One field for the additional information: Notes for the agents is gone.
    assert.equal(page.match(/name="notes"/g)?.length, 1);
    assert.doesNotMatch(page, /Notes for the agents/);
    // The page's script has the brief's part: the preview, the boxes and the line under the text.
    for (const piece of [
      "mdHtml",
      "data-bl-add",
      "briefSay",
      "blFill",
      "briefLinks",
      "data-links-say",
    ])
      assert.ok(NEW_CAMPAIGN_JS.includes(piece), piece);
    assert.doesNotThrow(() => new Function(NEW_CAMPAIGN_JS));
    // A draft sent back with mistakes keeps the brief, each entry in its own box.
    const back = briefPane({
      mode: "research",
      notes: "## Kept\nas typed",
      ideas: ["one", "two"],
      hypotheses: ["h <b>"],
      research: { topic: "t", questions: ["q1\nline 2"], seeds: ["https://a.example.com/x"] },
    });
    assert.match(
      back,
      /<textarea name="links" class="nc-links"[^>]*>https:\/\/a\.example\.com\/x<\/textarea>/,
    );
    assert.match(back, /<textarea name="notes" class="md-in"[^>]*>## Kept\nas typed<\/textarea>/);
    assert.match(
      back,
      /<div class="md-out md" data-md-out aria-live="polite"><h4>Kept<\/h4><p>as typed<\/p><\/div>/,
    );
    assert.equal(back.match(/data-bl-item="ideas"/g)?.length, 2);
    assert.match(back, />h &lt;b&gt;<\/textarea>/);
    assert.match(back, />q1\nline 2<\/textarea>/);
  });

  test("Starting links as typed: every line with words, and the lines that are not web addresses", () => {
    assert.deepEqual(core.briefLinks(fields.links), {
      links: [
        "https://git.example.com/team/fastmat/issues/12",
        "https://docs.example.com/fastmat/design",
      ],
      bad: [],
    });
    assert.deepEqual(core.briefLinks("https://a.example.com\nnot a link\n\nftp://b.example.com"), {
      links: ["https://a.example.com", "not a link", "ftp://b.example.com"],
      bad: [2, 4],
    });
    assert.deepEqual(core.briefDraft("hill_climb", { ...fields, notes: "" }).links, [
      "https://git.example.com/team/fastmat/issues/12",
      "https://docs.example.com/fastmat/design",
    ]);
    assert.ok(
      !("links" in core.briefDraft("research", fields)),
      "research sends them as its seeds",
    );
  });

  test("the line under Additional information says who gets all of it, and when it is too long to send", () => {
    assert.equal(core.briefSay(0, 0), "Markdown. Empty is fine.");
    assert.equal(
      core.briefSay(1240, 1240),
      "Markdown · 1,240 characters. Every agent gets all of it.",
    );
    assert.equal(
      core.briefSay(40_512, 40_512),
      "Markdown · 40,512 characters. Each worker's brief has the first 32,000; the rest is in BRIEF.md in the run's folder. The planner gets all of it, and the advisors as much as their window takes.",
    );
    assert.match(
      core.briefSay(3_100_000, 3_100_000),
      /^Too long to send: a campaign goes to a rig in one command of at most 3\.5 MiB\.$/,
    );
  });

  test("the form, as the browser posts it: hill climb and goal keep the additional information whole, the ideas and the hypotheses", async () => {
    const s = await stack();
    const hc = await s.submit(codeDraft("hill_climb"), "start");
    assert.equal(hc.status, 303, await hc.text());
    const c = s.contract("fastmat-speed");
    // No length limit: the whole text, and only the entries with words, trimmed.
    assert.equal(c?.notes, NOTES.trimEnd());
    assert.ok(String(c?.notes).length > 50_000);
    assert.deepEqual(c?.ideas, [
      "Fuse the dequantize step.",
      "Load 128-bit vectors.\nThen unroll by 4.",
    ]);
    assert.deepEqual(c?.hypotheses, ["It is memory bound at batch size 1."]);
    assert.deepEqual(c?.links, [
      "https://git.example.com/team/fastmat/issues/12",
      "https://docs.example.com/fastmat/design",
    ]);
    // The signed assignment carries the same contract to the rig.
    const signed = s.store.db
      .prepare("select signed from command where kind = 'assign_campaign'")
      .get() as { signed: string };
    const payload = (
      JSON.parse(signed.signed) as { envelope: { payload: { contract: Record<string, unknown> } } }
    ).envelope.payload;
    assert.deepEqual(payload.contract.ideas, c?.ideas);
    assert.equal(payload.contract.notes, c?.notes);
    const goal = await s.submit(codeDraft("goal"));
    assert.equal(goal.status, 303, await goal.text());
    assert.deepEqual(s.contract("fastmat-goals")?.ideas, c?.ideas);
    // An empty brief adds nothing to the contract.
    const bare = await s.submit(
      codeDraft("hill_climb", {
        campaign: "bare",
        notes: undefined,
        ideas: undefined,
        hypotheses: undefined,
        links: undefined,
      }),
    );
    assert.equal(bare.status, 303);
    const b = s.contract("bare") ?? {};
    assert.ok(!("notes" in b) && !("ideas" in b) && !("hypotheses" in b) && !("links" in b));
    // A starting link that is not a web address: refused in words.
    const badLink = await s.submit(
      codeDraft("hill_climb", { campaign: "bad-link", links: ["git.example.com/x"] }),
    );
    assert.match(
      await badLink.text(),
      /Starting links: git\.example\.com\/x is not a web address: write it as https:\/\/…/,
    );
  });

  test("the form, as the browser posts it: research keeps each question whole, its hypotheses and its additional information; ideas are not sent", async () => {
    const s = await stack();
    const question = `Which papers since 2024 train agents on tasks of 100 steps or more?\nFor each: the task, the method and what it reports. ${"Detail. ".repeat(200)}`;
    const draft = {
      mode: "research",
      campaign: "agent-survey",
      title: "Find methods that keep long agent tasks stable",
      lanes: 2,
      limits: {},
      research: {
        topic: "Long agent tasks",
        questions: core.briefList([question, "", "What fails, and why?"]),
        // The brief's Starting links: a research campaign's seeds.
        seeds: core.briefLinks(fields.links).links,
        min_duration: "8h",
      },
      ...core.briefDraft("research", fields),
    };
    assert.ok(!("ideas" in draft), "the page sends no ideas for research");
    const res = await s.submit(draft);
    assert.equal(res.status, 303, await res.text());
    const c = s.contract("agent-survey");
    assert.deepEqual(c?.questions, [question.trim(), "What fails, and why?"]);
    assert.deepEqual(c?.hypotheses, ["It is memory bound at batch size 1."]);
    assert.equal(c?.notes, NOTES.trimEnd());
    assert.deepEqual(c?.seeds, [
      "https://git.example.com/team/fastmat/issues/12",
      "https://docs.example.com/fastmat/design",
    ]);
    assert.ok(!("links" in (c ?? {})));
    // Ideas sent anyway, or no question: refused in words.
    const ideas = await s.submit({ ...draft, campaign: "agent-survey-b", ideas: ["x"] });
    assert.match(await ideas.text(), /Ideas to try are for hill-climb and goal campaigns/);
    const none = await s.submit({
      ...draft,
      campaign: "agent-survey-c",
      research: { ...draft.research, questions: [] },
    });
    assert.match(await none.text(), /a research campaign needs at least one question/);
  });

  test("the campaign's page shows the brief: the questions, the ideas, the hypotheses and the additional information as it renders", async () => {
    const s = await stack();
    await s.submit(codeDraft("hill_climb"));
    const page = await s.get("/ui/campaigns/fastmat-speed");
    const block =
      /<div class="block" id="brief">[\s\S]*?<\/details><\/div><\/div>/.exec(page)?.[0] ?? "";
    assert.ok(block, "the page has the brief");
    assert.match(
      block,
      /<ol class="kb-list"><li>Fuse the dequantize step\.<\/li><li>Load 128-bit vectors\.<br>Then unroll by 4\.<\/li><\/ol>/,
    );
    assert.match(block, /It is memory bound at batch size 1\./);
    // Its starting links, as links.
    assert.match(
      block,
      /<span class="lb">Starting links<i [^>]*>i<\/i><\/span><ul class="kb-list"><li><a href="https:\/\/git\.example\.com\/team\/fastmat\/issues\/12" rel="noopener noreferrer" target="_blank">/,
    );
    // A long text folds, with its size; its Markdown renders.
    assert.match(
      block,
      /<details class="kb-info"><summary><b>Additional information<\/b> <span class="muted small">5\d,\d{3} characters/,
    );
    assert.match(block, /<h4>Background<\/h4><p>We build <b>fastmat<\/b>/);
    // A research campaign shows its questions; a contract without a brief or questions, nothing.
    assert.match(
      campaignBriefBlock({ mode: "research", questions: ["q1\nline 2"], hypotheses: ["h"] }),
      /<ol class="kb-list"><li>q1<br>line 2<\/li><\/ol>[\s\S]*Each run starts with these as its hypotheses\./,
    );
    assert.equal(campaignBriefBlock({ mode: "hill_climb" }), "");
    assert.match(campaignBriefBlock({ notes: "short" }), /<details class="kb-info" open>/);
  });

  test("Copy keeps the brief; a copy over REST or MCP may give its own, each part in place of the source's", async () => {
    const s = await stack();
    await s.submit(codeDraft("hill_climb"));
    const source = s.contract("fastmat-speed");
    // Kept as it is.
    const kept = await s.rest("fastmat-speed", { name: "fastmat-speed-b" });
    assert.equal(kept.status, 201, await kept.text());
    const b = s.contract("fastmat-speed-b");
    for (const k of ["notes", "links", "ideas", "hypotheses"])
      assert.deepEqual(b?.[k], source?.[k], k);
    // Its own: new additional information, no ideas, the hypotheses kept.
    const own = await s.rest("fastmat-speed", {
      name: "fastmat-speed-c",
      notes: "## Only this\nA shorter brief.",
      ideas: [],
    });
    assert.equal(own.status, 201, await own.text());
    const c = s.contract("fastmat-speed-c");
    assert.equal(c?.notes, "## Only this\nA shorter brief.");
    assert.ok(!("ideas" in (c ?? {})));
    assert.deepEqual(c?.hypotheses, source?.hypotheses);
    // Control's audit log names the parts the copy has of its own; their text is in its contract.
    const audits = (
      s.store.db.prepare("select body from audit where action = 'campaign_copied'").all() as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body) as { campaign: string; own_brief?: string[] });
    assert.deepEqual(
      audits.map((a) => [a.campaign, a.own_brief]),
      [
        ["fastmat-speed-b", undefined],
        ["fastmat-speed-c", ["notes", "ideas"]],
      ],
    );
    // Over MCP: other hypotheses; and a research campaign takes no ideas.
    const client = await mcpClient(s.control);
    const out = await client.callTool({
      name: "copy_campaign",
      arguments: {
        from: "fastmat-speed",
        name: "fastmat-speed-d",
        hypotheses: ["It is compute bound."],
      },
    });
    assert.notEqual(out.isError, true, JSON.stringify(out));
    assert.deepEqual(s.contract("fastmat-speed-d")?.hypotheses, ["It is compute bound."]);
    assert.deepEqual(s.contract("fastmat-speed-d")?.ideas, source?.ideas);
    await s.submit({
      mode: "research",
      campaign: "survey",
      title: "A survey",
      lanes: 1,
      limits: {},
      research: { topic: "t", questions: ["q?"], seeds: [], min_duration: "8h" },
    });
    // A research copy's links are its seeds.
    const seeded = await s.rest("survey", { name: "survey-s", links: ["https://a.example.com/x"] });
    assert.equal(seeded.status, 201, await seeded.text());
    assert.deepEqual(s.contract("survey-s")?.seeds, ["https://a.example.com/x"]);
    const refused = await s.rest("survey", { name: "survey-b", ideas: ["x"] });
    assert.equal(refused.status, 400);
    assert.match(
      String(((await refused.json()) as { error: string }).error),
      /Ideas to try are for hill-climb and goal campaigns/,
    );
    // A copy's own link that is not a web address: the copy's brief is named, not the source.
    const badLink = await s.rest("fastmat-speed", {
      name: "fastmat-speed-e",
      links: ["not a url"],
    });
    assert.equal(badLink.status, 409);
    const why = String(((await badLink.json()) as { error: string }).error);
    assert.match(why, /^The copy's own brief is not valid: /);
    assert.doesNotMatch(why, /The contract of fastmat-speed/);
    await client.close();
  });
});
