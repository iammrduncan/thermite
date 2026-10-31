import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseContract } from "../../../src/core/contract.ts";
import { runResearchTrial } from "../../../src/harness/agents/research/worker.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { ResearchFolder } from "../../../src/harness/research/folder.ts";
import { Research } from "../../../src/harness/research/research/index.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { researchFixture } from "../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/** Two pages on two "sites" (two ports), so a claim can be corroborated. */
async function web() {
  const page = (body: string) =>
    `<html><head><title>Notes</title></head><body>${body}</body></html>`;
  const servers = await Promise.all(
    [
      "<p>The harness archived 42 pages in its first run.</p><p>Stateless workers lose nothing when they crash.</p>",
      "<p>Again: the harness archived 42 pages in its first run, a second site says.</p>",
    ].map(async (body) => {
      const s = createServer((req, res) => {
        if (req.url === "/robots.txt") return void res.writeHead(404).end();
        res.writeHead(200, { "content-type": "text/html" }).end(page(body));
      });
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      return s;
    }),
  );
  const urls = servers.map(
    (s, i) =>
      `http://${i === 0 ? "127.0.0.1" : "localhost"}:${(s.address() as AddressInfo).port}/p.html`,
  );
  return {
    urls,
    close: () => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))),
  };
}

async function setup() {
  const env = makeHarnessEnv("rig-r");
  const parsed = parseContract({ ...researchFixture });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const out = await env.service.applyCommand(
    env.sign("assign_campaign", {
      run: "r-1",
      contract: parsed.contract,
      contract_sha: parsed.sha,
      imports: [],
    }),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const { stateDir, scratchDir } = env.service.paths;
  const make = () =>
    new ResearchFolder({
      ledger: env.service.ledger,
      scratchRoot: join(scratchDir, "research"),
      stateRoot: join(stateDir, "research-work"),
      runner: new LocalRunner(scratchDir),
    });
  const folder = make();
  const research = new Research(env.service.ledger, stateDir, {
    allowPrivate: true,
    onChange: (run) => void folder.sync(run),
  });
  return { env, research, folder, make, root: join(scratchDir, "research", "r-1") };
}

const read = (...p: string[]) => readFileSync(join(...p), "utf8");

describe("the research folder", () => {
  test("holds every record as files, kept current; findings are checked against verified claims", async () => {
    const w = await web();
    const { research, root } = await setup();
    const a = (await research.fetch("r-1", "lane-1", w.urls[0] as string)) as { source: string };
    const b = (await research.fetch("r-1", "lane-2", w.urls[1] as string)) as { source: string };
    const quote = "The harness archived 42 pages in its first run.";
    const good = research.addClaim("r-1", "lane-1", {
      text: "The harness archived 42 pages in its first run.",
      quotes: [
        { source: a.source, quote },
        { source: b.source, quote: "the harness archived 42 pages in its first run" },
      ],
      question: 0,
    });
    assert.equal(good.verified, true, JSON.stringify(good));
    // Cited by its URL: the claim keeps the source's id and what was cited.
    const draft = research.addClaim("r-1", "lane-2", {
      text: "Workers never crash at all.",
      quotes: [
        { source: w.urls[0] as string, quote: "Workers never crash at all, ever, in any run." },
      ],
    });
    assert.equal(draft.verified, false);
    research.addNote("r-1", "lane-1", "Look for a third site.", [a.source]);
    research.proposeHypothesis("r-1", "lane-1", {
      text: "Archiving early helps.",
      supporting: [good.claim],
      question: 0,
    });

    // Code checks findings: only verified claims, and only their numbers.
    const finding = research.addFinding("r-1", "lane-1", {
      text: "The first run archived 42 pages.",
      summary: "Two independent sites say the harness archived 42 pages in its first run.",
      why_it_matters: "It shows the archive works from the start.",
      supporting: [good.claim],
    });
    assert.deepEqual(finding.problems, []);
    assert.equal(finding.supported, true);
    const weak = research.addFinding("r-1", "lane-2", {
      text: "Workers never crash, in 7 of 7 runs.",
      summary: "One page says so.",
      why_it_matters: "Fewer restarts.",
      supporting: [draft.claim, "c-nothing"],
    });
    assert.equal(weak.supported, false);
    assert.ok(weak.problems.some((p) => /is a draft, not verified/.test(p)));
    assert.ok(weak.problems.some((p) => /no claim c-nothing/.test(p)));
    assert.ok(weak.problems.some((p) => /the number 7 is not in the claims it cites/.test(p)));
    research.updateSection("r-1", "lane-1", "background", "First version.");
    research.updateSection("r-1", "lane-1", "background", "Second version.");

    // The files: each source's archived text, each record, the index.
    assert.ok(read(root, "sources", `${a.source}.txt`).includes(quote));
    assert.match(read(root, "sources", `${a.source}.txt`), new RegExp(`URL: ${w.urls[0]}`));
    assert.match(read(root, "claims", `${good.claim}.md`), /^# Claim c-[0-9a-f]+: verified/);
    assert.match(
      read(root, "claims", `${good.claim}.md`),
      /Question 1 \(index 0\): What harness designs/,
    );
    assert.match(read(root, "claims", `${draft.claim}.md`), /: draft[\s\S]*Why it is a draft/);
    assert.ok(
      read(root, "claims", `${draft.claim}.md`).includes(
        `- ${a.source} (${w.urls[0]}), cited as ${w.urls[0]}:`,
      ),
      "the source's id and address, and the URL the worker cited",
    );
    assert.match(
      read(root, "claims", `${draft.claim}.md`),
      new RegExp(`quote not found verbatim in ${a.source}`),
    );
    assert.match(
      read(root, "findings", `${finding.finding}.md`),
      /supported[\s\S]*## Why it matters\n\nIt shows/,
    );
    assert.match(read(root, "findings", `${weak.finding}.md`), /draft[\s\S]*the number 7/);
    assert.match(read(root, "notes", "note-00001.md"), /Look for a third site\./);
    assert.match(read(root, "report", "background.md"), /Second version\./);
    const index = read(root, "INDEX.md");
    assert.match(
      index,
      /- Question 1 \(index 0\): What harness designs keep agents productive for days\? \(1 verified claims\)/,
    );
    assert.match(index, /claims\/: 2 claims, 1 verified and 1 drafts/);
    assert.match(
      index,
      new RegExp(`${finding.finding} \\(supported\\): The first run archived 42 pages\\.`),
    );
    assert.match(read(root, "REPORT.md"), /No report yet/);

    // The report: findings with their summary, why and support; drafts apart, with the reasons.
    const body = research.report("r-1", "digest").body;
    // Its questions numbered for reading, with the index a claim's `question` takes (goal 117).
    assert.match(body, /## Questions\n- Question 1 \(index 0\): What harness designs/);
    const findings = body.split("## Findings")[1]?.split("\n## ")[0] ?? "";
    assert.match(findings, /### The first run archived 42 pages\./);
    assert.match(findings, /Why it matters: It shows the archive works/);
    assert.match(
      findings,
      /Supported by 1 verified claims \(1 from at least 2 independent domains\)/,
    );
    assert.doesNotMatch(findings, /Workers never crash/);
    assert.match(
      body,
      /## Draft findings[\s\S]*Workers never crash, in 7 of 7 runs\.[\s\S]*the number 7/,
    );
    assert.match(
      read(root, "REPORT.md"),
      /the digest report of[\s\S]*### The first run archived 42 pages/,
    );
    await w.close();
  });

  test("a lane's working area: saved and shown to the other lanes when its trial ends, back after a restart; symlinks are left out", async () => {
    const { env, folder, make, root } = await setup();
    const f = await folder.prepareLane("r-1", "lane-1", "agent-1");
    assert.equal(f.root, root);
    assert.equal(f.work, join(root, "work", "lane-1"));
    mkdirSync(join(f.work, "drafts"));
    writeFileSync(join(f.work, "synthesis.md"), "What we know so far.\n");
    writeFileSync(join(f.work, "drafts", "outline.md"), "1. archive\n");
    const outside = join(env.service.paths.stateDir, "not-for-lanes.txt");
    writeFileSync(outside, "harness state\n");
    symlinkSync(outside, join(f.work, "peek.txt"));
    assert.deepEqual(await folder.captureLane("r-1", "lane-1", "t-1"), { written: 2, removed: 0 });
    assert.equal(read(root, "lanes", "lane-1", "synthesis.md"), "What we know so far.\n");
    assert.ok(!existsSync(join(root, "lanes", "lane-1", "peek.txt")), "a symlink is not followed");
    const rows = env.service.ledger.db
      .prepare("select lane, trial, path, change from research_file order by id")
      .all();
    assert.deepEqual(
      rows.map((r) => `${r.lane} ${r.trial} ${r.path} ${r.change}`),
      ["lane-1 t-1 drafts/outline.md written", "lane-1 t-1 synthesis.md written"],
    );
    assert.match(read(root, "INDEX.md"), /lanes\/lane-1\/synthesis\.md \(21 bytes/);

    // The next trial: one file changed, one removed; only the changes are recorded.
    await folder.prepareLane("r-1", "lane-1", "lane-1");
    writeFileSync(join(f.work, "synthesis.md"), "What we know now.\n");
    rmSync(join(f.work, "drafts"), { recursive: true });
    assert.deepEqual(await folder.captureLane("r-1", "lane-1", "t-2"), { written: 1, removed: 1 });
    assert.ok(!existsSync(join(root, "lanes", "lane-1", "drafts")));
    assert.doesNotMatch(read(root, "INDEX.md"), /outline\.md/);

    // A restart clears scratch: the records come back from the ledger, the files from state.
    rmSync(join(env.service.paths.scratchDir, "research"), { recursive: true });
    const again = make();
    const g = await again.prepareLane("r-1", "lane-2", "agent-2");
    assert.equal(read(root, "lanes", "lane-1", "synthesis.md"), "What we know now.\n");
    assert.ok(existsSync(g.work));
    await again.prepareLane("r-1", "lane-1", "agent-1");
    assert.equal(read(root, "work", "lane-1", "synthesis.md"), "What we know now.\n");
    const exported = again.exportFiles("r-1");
    assert.ok(exported.files.includes("INDEX.md"));
    assert.ok(exported.files.includes(join("lanes", "lane-1", "synthesis.md")));
    assert.ok(!exported.files.some((p) => p.startsWith("work")), "working areas are not exported");
  });

  test("each text file a lane writes is a document of the run: its text in an event, its removal too", async () => {
    const { env, folder } = await setup();
    const docs = () =>
      env.service.ledger
        .eventsAfter(0, 10_000)
        .events.filter((e) => e.kind === "research_doc")
        .map((e) => ({ actor: e.actor, subject: e.subject, ...(e.body as object) }));
    const f = await folder.prepareLane("r-1", "lane-1", "agent-1");
    writeFileSync(join(f.work, "synthesis.md"), "What we know so far.\n");
    writeFileSync(join(f.work, "long.md"), `${"x".repeat(25_000)}\n`);
    writeFileSync(join(f.work, "weights.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(f.work, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await folder.captureLane("r-1", "lane-1", "t-1");
    const first = docs() as Record<string, unknown>[];
    assert.deepEqual(
      first.map((d) => d.path),
      ["long.md", "synthesis.md"],
      "text files only: not a binary file, not one that is not UTF-8",
    );
    const syn = first.find((d) => d.path === "synthesis.md");
    assert.deepEqual(syn, {
      actor: "lane-1",
      subject: "r-1",
      lane: "lane-1",
      trial: "t-1",
      path: "synthesis.md",
      change: "written",
      bytes: 21,
      sha256: syn?.sha256,
      text: "What we know so far.\n",
    });
    const long = first.find((d) => d.path === "long.md");
    assert.equal(String(long?.text).length, 20_000, "cut to an item's length");
    assert.equal(long?.clipped, true);
    // The next trial: one document unchanged, one changed, one removed, the binary removed.
    await folder.prepareLane("r-1", "lane-1", "agent-1");
    writeFileSync(join(f.work, "synthesis.md"), "What we know now.\n");
    rmSync(join(f.work, "long.md"));
    rmSync(join(f.work, "weights.bin"));
    await folder.captureLane("r-1", "lane-1", "t-2");
    assert.deepEqual(
      (docs() as Record<string, unknown>[]).slice(2).map((d) => `${d.path} ${d.change} ${d.trial}`),
      ["synthesis.md written t-2", "long.md removed t-2"],
      "a removed file that was never a document says nothing",
    );
    // Nothing changed: nothing more.
    await folder.prepareLane("r-1", "lane-1", "agent-1");
    await folder.captureLane("r-1", "lane-1", "t-3");
    assert.equal(docs().length, 4);
  });

  test("a finished campaign's export carries its report and its whole folder", async () => {
    const w = await web();
    const { env, research, folder } = await setup();
    env.service.researchFolder = (run) => folder.exportFiles(run);
    const a = (await research.fetch("r-1", "lane-1", w.urls[0] as string)) as { source: string };
    const c = research.addClaim("r-1", "lane-1", {
      text: "Stateless workers lose nothing when they crash.",
      quotes: [{ source: a.source, quote: "Stateless workers lose nothing when they crash." }],
    });
    const before = await env.service.export("test");
    assert.ok(!existsSync(join(before.dir, "research")), "not before the final report");
    research.report("r-1", "final");
    const out = await env.service.export("test");
    const base = join(out.dir, "research", "r-1", "folder");
    assert.match(read(base, "REPORT.md"), /the final report/);
    assert.match(read(base, "claims", `${c.claim}.md`), /verified/);
    assert.ok(existsSync(join(base, "sources", `${a.source}.txt`)));
    const manifest = JSON.parse(read(out.dir, "manifest.json")) as {
      files: Record<string, string>;
    };
    assert.ok(manifest.files["research/r-1/folder/INDEX.md"], "listed with its hash");
    await w.close();
  });

  test("a Pi worker searches the folder, writes in its own area only, and records a finding", async () => {
    const w = await web();
    const { research, folder } = await setup();
    const a = (await research.fetch("r-1", "lane-1", w.urls[0] as string)) as { source: string };
    const c = research.addClaim("r-1", "lane-1", {
      text: "Stateless workers lose nothing when they crash.",
      quotes: [{ source: a.source, quote: "Stateless workers lose nothing when they crash." }],
    });
    const paths = await folder.prepareLane("r-1", "lane-1", "agent-1");
    const results: string[] = [];
    const fake = await startFakeModel(({ messages }) => {
      const tools = messages.filter((m) => m.role === "tool");
      const last = tools.at(-1);
      if (last) results.push(String(last.content));
      const steps = [
        { name: "search_files", args: { text: "lose nothing" } },
        { name: "write_file", args: { path: "work/lane-1/notes.md", content: "crash-safe\n" } },
        { name: "write_file", args: { path: "claims/forged.md", content: "verified" } },
        { name: "read_file", args: { path: "../../../etc/passwd" } },
        {
          name: "add_finding",
          args: {
            text: "Workers survive crashes.",
            summary: "An archived page says stateless workers lose nothing when they crash.",
            why_it_matters: "Long campaigns can restart workers freely.",
            supporting: [c.claim],
          },
        },
      ];
      const next = steps[tools.length];
      return next ? { toolCalls: [next] } : { text: "done" };
    });
    const model = {
      baseUrl: fake.url,
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const r = await runResearchTrial(
      { trialId: "t-1", run: "r-1", lane: "lane-1", brief: "Go.", wallMs: 30_000, folder: paths },
      {
        model,
        call: async (op, args) => {
          const { run, lane, ...rest } = args as { run: string; lane: string };
          if (op === "finding") return research.addFinding(run, lane, rest);
          return research.stats(run);
        },
      },
    );
    await fake.close();
    assert.equal(r.toolCalls, 5);
    assert.match(
      results[0] ?? "",
      new RegExp(`sources/${a.source}\\.txt:\\d+: .*Stateless workers lose nothing`),
    );
    assert.match(results[0] ?? "", new RegExp(`claims/${c.claim}\\.md`));
    assert.equal(read(paths.work, "notes.md"), "crash-safe\n");
    assert.match(results[2] ?? "", /you can write only in your working area, work\/lane-1\//);
    assert.ok(!existsSync(join(paths.root, "claims", "forged.md")));
    assert.match(results[3] ?? "", /outside the research folder/);
    assert.match(results[4] ?? "", /"supported":true/);
    await w.close();
  });
});
