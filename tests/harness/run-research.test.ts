import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { Registry } from "../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { Research } from "../../src/harness/research/research/index.ts";
import {
  ANSWER_CHARS,
  DIGEST_CHARS,
  FILE_CHARS,
  RESEARCH_IS_DATA,
  SOURCE_CHARS_MAX,
} from "../../src/harness/run-research.ts";
import { makeJudgeEnv } from "../helpers/judge-env.ts";
import {
  fillResearch,
  makeResearchRun,
  RESEARCH_QUESTIONS,
  servePages,
} from "../helpers/research-run.ts";

/**
 * Goal 098: the teachers read the run's own research, read only, through the harness: its
 * sources, claims, hypotheses, findings, notes and files, a page at a time, with every answer cut
 * to a size and marked as data; the supervisor's token only. The brief says what it holds.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function setup(t: TestContext) {
  const r = await makeResearchRun();
  t.after(() => r.close());
  const ids = await fillResearch(r);
  const api = createHarnessApi(r.env.service, tokens);
  const get = async (path: string, token = tokens.supervisor) => {
    const res = await api.request(path, { headers: auth(token) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { ...r, ids, api, get };
}

type Page = {
  note: string;
  total: number;
  offset: number;
  next: number | null;
  items: Record<string, unknown>[];
};

describe("the teachers read the run's own research (goal 098)", () => {
  test("each kind, newest first, with the harness's check and the reasons for a draft", async (t) => {
    const s = await setup(t);
    const page = async (path: string) => {
      const r = await s.get(path);
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
      const p = r.body as unknown as Page;
      assert.equal(p.note, RESEARCH_IS_DATA);
      return p;
    };
    const sources = await page("/v1/research/sources?run=r-1");
    assert.equal(sources.total, 2);
    assert.deepEqual(
      sources.items.map((x) => x.id),
      [...s.ids.sources].reverse(),
      "newest first",
    );
    const a = sources.items.find((x) => x.id === s.ids.sources[0]) as Record<string, unknown>;
    assert.equal(a.title, "Harness notes");
    assert.match(String(a.url), /\/a\.html$/);
    assert.equal(a.domain, "127.0.0.1");
    assert.equal(a.by, "lane-1");
    assert.deepEqual(a.claims, { verified: 1, draft: 1 });

    const claims = await page("/v1/research/claims?run=r-1");
    assert.equal(claims.total, 3);
    const draft = claims.items.find((x) => x.id === s.ids.claims.draft) as Record<string, unknown>;
    assert.equal(draft.state, "draft");
    assert.equal(draft.question, 1);
    assert.equal(draft.question_text, RESEARCH_QUESTIONS[1]);
    assert.match(
      JSON.stringify(draft.why_draft),
      /quote not found verbatim in s-[0-9a-f]+: .*The harness archived 4200 pages/,
    );
    const ok = claims.items.find((x) => x.id === s.ids.claims.verified) as Record<string, unknown>;
    assert.equal(ok.state, "verified");
    assert.equal(ok.why_draft, undefined);
    assert.deepEqual(ok.quotes, [
      {
        source: s.ids.sources[0],
        url: a.url,
        quote: "The harness archived 42 pages in its first run.",
      },
    ]);
    // Narrowed by question and by state.
    const q1 = await page("/v1/research/claims?run=r-1&question=1");
    assert.deepEqual(
      q1.items.map((x) => x.id).sort(),
      [s.ids.claims.draft, s.ids.claims.clock].sort(),
    );
    const q1verified = await page("/v1/research/claims?run=r-1&question=1&state=verified");
    assert.deepEqual(
      q1verified.items.map((x) => x.id),
      [s.ids.claims.clock],
    );

    const hypotheses = await page("/v1/research/hypotheses?run=r-1");
    assert.deepEqual(
      hypotheses.items.map((x) => [x.id, x.supporting, x.status, x.question]),
      [[s.ids.hypothesis, [], "author", null]],
      "the author's hypothesis, with its status and question (goal 117)",
    );

    const findings = await page("/v1/research/findings?run=r-1");
    assert.deepEqual(Object.fromEntries(findings.items.map((x) => [x.id, x.state])), {
      [s.ids.findings.supported]: "supported",
      [s.ids.findings.draft]: "draft",
    });
    const f = findings.items.find((x) => x.id === s.ids.findings.draft) as Record<string, unknown>;
    assert.match(JSON.stringify(f.why_draft), /is a draft, not verified/);
    const drafts = await page("/v1/research/findings?run=r-1&state=draft");
    assert.deepEqual(
      drafts.items.map((x) => x.id),
      [s.ids.findings.draft],
    );

    const notes = await page("/v1/research/notes?run=r-1");
    assert.deepEqual(
      notes.items.map((x) => [x.text, x.sources]),
      [["Look for a second site that says the same.", [s.ids.sources[0]]]],
    );

    // The report first, then the sections, then the lanes' files, newest first.
    const files = await page("/v1/research/files?run=r-1");
    assert.deepEqual(
      files.items.map((x) => [x.path, x.by]),
      [
        ["REPORT.md", "harness"],
        ["report/synthesis.md", "lane-1"],
        ["lanes/lane-1/weights.bin", "lane-1"],
        ["lanes/lane-1/q0-synthesis.md", "lane-1"],
      ],
    );

    // A filter a kind does not take is refused in words.
    const bad = await s.get("/v1/research/notes?run=r-1&state=verified");
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /state narrows claims \(verified, draft\) and findings/);
    const badState = await s.get("/v1/research/claims?run=r-1&state=supported");
    assert.equal(badState.status, 400);
    assert.match(String(badState.body.error), /a claim's state is verified or draft/);
    assert.equal((await s.get("/v1/research/notes?run=r-1&question=0")).status, 400);
    assert.equal((await s.get("/v1/research/claims?run=nope")).status, 404);
  });

  test("lists come a page at a time, and no answer is longer than its cap", async (t) => {
    const s = await setup(t);
    const one = (await s.get("/v1/research/claims?run=r-1&limit=1")).body as unknown as Page;
    assert.equal(one.items.length, 1);
    assert.equal(one.total, 3);
    assert.equal(one.next, 1);
    const last = (await s.get("/v1/research/claims?run=r-1&offset=2&limit=5"))
      .body as unknown as Page;
    assert.equal(last.items.length, 1);
    assert.equal(last.next, null);
    assert.equal((await s.get("/v1/research/claims?run=r-1&limit=51")).status, 400);
    assert.equal((await s.get("/v1/research/claims?run=r-1&offset=-1")).status, 400);

    // Fifty notes of 4,000 characters each: the page stops at the cap and says where to go on.
    for (let i = 0; i < 50; i++)
      s.research.addNote(
        "r-1",
        "lane-2",
        `${String(i).padStart(2, "0")} ${"long note ".repeat(399)}`,
      );
    const big = await s.get("/v1/research/notes?run=r-1&limit=50");
    const p = big.body as unknown as Page;
    assert.ok(
      JSON.stringify(big.body).length <= ANSWER_CHARS,
      String(JSON.stringify(big.body).length),
    );
    assert.ok(p.items.length > 1 && p.items.length < 50, String(p.items.length));
    assert.equal(p.total, 51);
    assert.equal(p.next, p.items.length);
    const rest = (await s.get(`/v1/research/notes?run=r-1&offset=${p.next}&limit=50`))
      .body as unknown as Page;
    assert.notEqual(rest.items[0]?.id, p.items.at(-1)?.id);
  });

  test("a source's archived text in parts, and a file of the research folder by lines", async (t) => {
    const s = await setup(t);
    const src = s.ids.sources[0] as string;
    const whole = await s.get(`/v1/research/source?run=r-1&source=${src}`);
    assert.equal(whole.status, 200);
    assert.match(String(whole.body.text), /The harness archived 42 pages in its first run\./);
    assert.equal(whole.body.next, null);
    assert.equal(whole.body.note, RESEARCH_IS_DATA);
    const part = await s.get(`/v1/research/source?run=r-1&source=${src}&offset=4&limit=7`);
    assert.equal(part.body.from, 4);
    assert.equal(part.body.next, 11);
    assert.equal(String(part.body.text).length, 7);
    assert.equal(
      (await s.get(`/v1/research/source?run=r-1&source=${src}&limit=${SOURCE_CHARS_MAX + 1}`))
        .status,
      400,
    );
    assert.equal((await s.get("/v1/research/source?run=r-1&source=s-nope")).status, 404);

    const lane = await s.get("/v1/research/file?run=r-1&path=lanes/lane-1/q0-synthesis.md");
    assert.equal(lane.status, 200);
    assert.equal(lane.body.by, "lane-1");
    assert.equal(lane.body.trial, "t-1");
    assert.equal(lane.body.total_lines, 4);
    assert.match(String(lane.body.content), /^1\t# Question 0\n2\t\n3\tWhat we know/);
    const second = await s.get(
      "/v1/research/file?run=r-1&path=lanes/lane-1/q0-synthesis.md&offset=3&limit=1",
    );
    assert.equal(second.body.content, "3\tWhat we know: the harness archived 42 pages.");
    assert.equal(second.body.next, 4);
    const report = await s.get("/v1/research/file?run=r-1&path=REPORT.md");
    assert.match(
      String(report.body.content),
      /\tCorpus: 2 sources from 1 domains; 2 verified claims/,
    );
    const section = await s.get("/v1/research/file?run=r-1&path=report/synthesis.md");
    assert.equal(section.body.content, "1\tTwo sites so far.\n2\tBoth agree.");
    const binary = await s.get("/v1/research/file?run=r-1&path=lanes/lane-1/weights.bin");
    assert.equal(binary.body.not_shown, "a binary file");
    assert.equal(binary.body.content, undefined);
    for (const path of [
      "../state/ledger/ledger.db",
      "lanes/lane-1/../../INDEX.md",
      "/etc/passwd",
    ]) {
      const r = await s.get(`/v1/research/file?run=r-1&path=${encodeURIComponent(path)}`);
      assert.equal(r.status, 400, path);
      assert.match(String(r.body.error), /not a path in the research folder/);
    }
    for (const path of ["INDEX.md", "sources/x.txt", "lanes/lane-1/nope.md", "report/nope.md"])
      assert.equal(
        (await s.get(`/v1/research/file?run=r-1&path=${encodeURIComponent(path)}`)).status,
        404,
        path,
      );

    // A long file is read in parts no longer than the cap.
    const work = await s.folder.prepareLane("r-1", "lane-2", "agent-2");
    writeFileSync(join(work.work, "wide.md"), `${"x".repeat(1000)}\n`.repeat(200));
    await s.folder.captureLane("r-1", "lane-2", "t-2");
    const wide = await s.get("/v1/research/file?run=r-1&path=lanes/lane-2/wide.md&limit=2000");
    assert.ok(String(wide.body.content).length <= FILE_CHARS);
    assert.ok(Number(wide.body.to) < 200 && wide.body.next === Number(wide.body.to) + 1);
  });

  test("a search of all of it by words, in every kind or some", async (t) => {
    const s = await setup(t);
    type Hits = {
      matched: number;
      note: string;
      items: { kind: string; id: string; excerpt: string }[];
    };
    const search = async (q: string) =>
      (await s.get(`/v1/research/search?run=r-1&${q}`)).body as unknown as Hits;
    const all = await search("q=archived+42");
    assert.equal(all.note, RESEARCH_IS_DATA);
    const kinds = new Set(all.items.map((x) => x.kind));
    for (const k of ["source", "claim", "finding", "file"]) assert.ok(kinds.has(k), k);
    assert.ok(all.items.some((x) => x.id === "lanes/lane-1/q0-synthesis.md"));
    assert.ok(
      all.items.every((x) => /archived 42/i.test(x.excerpt)),
      JSON.stringify(all.items),
    );
    // Words match within words, as the past-research search reads them: 42 is in 4200.
    const claims = await search("q=archived+42&kinds=claim");
    assert.deepEqual(
      claims.items.map((x) => x.id).sort(),
      [s.ids.claims.verified, s.ids.claims.draft].sort(),
    );
    const stateless = await search("q=stateless+crash&kinds=source,claim,note");
    assert.deepEqual(
      stateless.items.map((x) => [x.kind, x.id]),
      [["source", s.ids.sources[0]]],
    );
    const clock = await search("q=clock+workers&kinds=source,claim");
    assert.deepEqual(clock.items.map((x) => x.kind).sort(), ["claim", "source"]);
    assert.equal((await search("q=nothing+like+this")).matched, 0);
    const bad = await s.get("/v1/research/search?run=r-1&q=x&kinds=attempt");
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /no kind attempt: the kinds are source, claim/);
  });

  test("only the supervisor's token reads it: a worker's or an agent's is refused", async (t) => {
    const s = await setup(t);
    // A worker's own token, for a trial open in this run: it reaches the worker's own routes.
    const trial = randomBytes(16).toString("hex");
    new Registry(s.env.service.ledger).startTrial({
      id: "t-9",
      run: "r-1",
      lane: "lane-1",
      epoch: 1,
      family: "explore",
      parent: "0".repeat(40),
      token: trial,
    });
    const own = await s.api.request("/v1/trial/messages", { headers: auth(`trial.${trial}`) });
    assert.equal(own.status, 200, "the worker's token works for its own routes");
    const paths = [
      "/v1/research/sources?run=r-1",
      "/v1/research/claims?run=r-1",
      "/v1/research/hypotheses?run=r-1",
      "/v1/research/findings?run=r-1",
      "/v1/research/notes?run=r-1",
      "/v1/research/files?run=r-1",
      `/v1/research/source?run=r-1&source=${s.ids.sources[0]}`,
      "/v1/research/file?run=r-1&path=REPORT.md",
      "/v1/research/search?run=r-1&q=archived",
    ];
    for (const path of paths) {
      assert.equal((await s.get(path)).status, 200, path);
      for (const token of [tokens.proposer, `trial.${trial}`, "trial.not-a-trial", ""])
        assert.equal((await s.get(path, token)).status, 401, `${path} with ${token || "no token"}`);
    }
  });

  test("the brief says what the research holds, before the long parts, with the tools that read the rest", async (t) => {
    const s = await setup(t);
    const brief = s.env.service.brief("r-1") as Record<string, unknown>;
    const keys = Object.keys(brief);
    assert.ok(keys.indexOf("research") > keys.indexOf("objective"));
    for (const later of ["campaign_brief", "evidence", "queue", "field_notes", "owner_messages"])
      if (keys.includes(later)) assert.ok(keys.indexOf("research") < keys.indexOf(later), later);
    const r = brief.research as Record<string, unknown>;
    assert.equal(r.note, RESEARCH_IS_DATA);
    assert.deepEqual(
      {
        sources: r.sources,
        domains: r.domains,
        claims: r.claims,
        hypotheses: r.hypotheses,
        findings: r.findings,
        notes: r.notes,
        files: r.files,
      },
      {
        sources: 2,
        domains: 1,
        claims: { verified: 2, draft: 1 },
        hypotheses: 1,
        findings: { supported: 1, draft: 1 },
        notes: 1,
        files: 4,
      },
    );
    assert.deepEqual(r.questions, [
      { question: 0, text: RESEARCH_QUESTIONS[0], verified: 1, draft: 0 },
      { question: 1, text: RESEARCH_QUESTIONS[1], verified: 1, draft: 1 },
    ]);
    const report = r.newest_report as { kind: string; chars: number; text: string };
    assert.equal(report.kind, "digest");
    assert.match(report.text, /^# Survey a research topic/);
    assert.ok(report.text.length <= DIGEST_CHARS);
    assert.match(
      String(r.read),
      /list_research lists .*; read_source reads .*; read_research_file reads REPORT\.md, .*; search_research searches all of it by words\./,
    );

    // A long digest is cut in the brief; the file reads it whole.
    for (let i = 0; i < 40; i++)
      s.research.updateSection("r-1", "lane-1", `part-${i}`, "words ".repeat(300));
    s.research.report("r-1", "digest");
    const cut = (
      s.env.service.brief("r-1") as { research: { newest_report: { text: string; chars: number } } }
    ).research.newest_report;
    assert.ok(cut.chars > DIGEST_CHARS);
    assert.equal(cut.text.length, DIGEST_CHARS);
  });

  test("a hill-climb run answers with what its trials recorded: sources, claims and notes, and nothing else", async (t) => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const api = createHarnessApi(env.service, tokens);
    const get = async (path: string) => {
      const res = await api.request(path, { headers: auth(tokens.supervisor) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    // Nothing recorded yet: the brief says nothing of research, and the lists are empty.
    assert.equal((env.service.brief("js-1") as { research?: unknown }).research, undefined);
    const empty = (await get("/v1/research/claims?run=js-1")).body as unknown as Page;
    assert.equal(empty.total, 0);
    assert.match(empty.note, /A hill-climb or goal run records sources, claims and notes only/);
    // A trial recorded a source, a claim and a note (goal 065).
    const r = await servePages();
    t.after(() => r.close());
    const research = new Research(env.service.ledger, env.service.paths.stateDir, {
      allowPrivate: true,
    });
    const a = (await research.fetch("js-1", "lane-1", `${r.base}/a.html`)) as { source: string };
    research.addClaim("js-1", "lane-1", {
      text: "The first run archived 42 pages.",
      quotes: [{ source: a.source, quote: "The harness archived 42 pages in its first run." }],
    });
    research.addNote("js-1", "lane-1", "A page worth reading again.", [a.source]);
    const brief = (env.service.brief("js-1") as { research?: Record<string, unknown> }).research;
    assert.ok(brief, "the brief says what the run's trials recorded");
    assert.deepEqual(
      [brief.sources, brief.claims, brief.notes, brief.questions, brief.newest_report],
      [1, { verified: 1, draft: 0 }, 1, undefined, undefined],
    );
    assert.equal(((await get("/v1/research/claims?run=js-1")).body as unknown as Page).total, 1);
    assert.equal(((await get("/v1/research/sources?run=js-1")).body as unknown as Page).total, 1);
    assert.equal(((await get("/v1/research/notes?run=js-1")).body as unknown as Page).total, 1);
    for (const kind of ["hypotheses", "findings", "files"])
      assert.equal(
        ((await get(`/v1/research/${kind}?run=js-1`)).body as unknown as Page).total,
        0,
        kind,
      );
  });
});
