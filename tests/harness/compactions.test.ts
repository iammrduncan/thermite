import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { KB_BODY_MAX } from "../../src/core/kb-index.ts";
import { Registry } from "../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { LocalRunner } from "../../src/harness/broker/runner.ts";
import { Compactions, compactionOf } from "../../src/harness/compactions.ts";
import { knowledgePart } from "../../src/harness/kb-part.ts";
import { ResearchFolder } from "../../src/harness/research/folder.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

const RUN = "smoke-1";
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

async function setup() {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const folder = new ResearchFolder({
    ledger: env.service.ledger,
    scratchRoot: join(env.service.paths.scratchDir, "research"),
    stateRoot: join(env.service.paths.stateDir, "research-work"),
    runner: new LocalRunner(env.service.paths.scratchDir),
  });
  env.service.compactions = new Compactions({
    ledger: env.service.ledger,
    live: env.service.live,
    folder,
  });
  const api = createHarnessApi(env.service, { supervisor: "sup", proposer: "prop" });
  const token = randomBytes(16).toString("hex");
  new Registry(env.service.ledger).startTrial({
    id: "t-0123456789abcdef",
    run: RUN,
    lane: "lane-2",
    epoch: 1,
    family: "f",
    parent: env.seedCommit,
    token,
  });
  const post = (path: string, body: unknown, t = token) =>
    api.request(path, { method: "POST", headers: auth(`trial.${t}`), body: JSON.stringify(body) });
  const events = (kind: string) =>
    env.service.ledger.eventsAfter(0, 100_000).events.filter((e) => e.kind === kind);
  return { env, folder, post, events };
}

describe("compactions on the harness (goal 070)", () => {
  test("a Pi worker's conversation is kept in the run's research folder, and the compaction is one event with live lines", async () => {
    const s = await setup();
    const markdown = `# Trial t-0123456789abcdef: the conversation before compaction 1\n\n${"A long tool result. ".repeat(2000)}`;
    // The trial decides the run, the lane and the file's name; nothing in the body can.
    const bad = await s.post("/v1/trial/snapshot", { number: 1, markdown, run: "other" });
    assert.equal(bad.status, 400);
    const kept = await s.post("/v1/trial/snapshot", { number: 1, markdown });
    assert.equal(kept.status, 201, await kept.clone().text());
    const { path, rel } = (await kept.json()) as { path: string; rel: string };
    assert.equal(rel, "compactions/t-0123456789abcdef-1.md");
    assert.equal(path, join(s.folder.root(RUN), "compactions", "t-0123456789abcdef-1.md"));
    assert.equal(readFileSync(path, "utf8"), markdown, "where every agent of the run reads it");
    const state = join(s.env.service.paths.stateDir, "research-work", RUN, "compactions");
    assert.equal(readFileSync(join(state, "t-0123456789abcdef-1.md"), "utf8"), markdown);
    const done = await s.post("/v1/trial/compacted", {
      number: 1,
      tokens_before: 26_100,
      tokens_after: 3_400,
      how: "summary",
      kept: true,
      summary: "The kernel idles in Atomics.wait; remove it next.",
    });
    assert.equal(done.status, 201, await done.clone().text());
    const e = s.events("context_compacted");
    assert.equal(e.length, 1);
    assert.equal(e[0]?.subject, RUN);
    const b = e[0]?.body as Record<string, unknown>;
    assert.equal(b.trial, "t-0123456789abcdef");
    assert.equal(b.lane, "lane-2");
    assert.equal(b.harness, "pi");
    assert.equal(b.number, 1);
    assert.equal(b.tokens_before, 26_100);
    assert.equal(b.tokens_after, 3_400);
    assert.equal(b.snapshot, rel);
    assert.equal(b.clipped, true);
    assert.equal(String(b.text).length, KB_BODY_MAX);
    assert.match(String(b.summary), /Atomics\.wait/);
    // The live view: the compaction in words, then the summary.
    const lines = s.env.service.live
      .since(0, 1000)
      .entries.filter((l) => l.source === "trial:t-0123456789abcdef");
    assert.match(
      lines.at(-2)?.text ?? "",
      /The harness compacted the conversation \(compaction 1\) at about 26,100 tokens, down to about 3,400\. The trial goes on\. The conversation before it is kept in the run's research folder, compactions\/t-0123456789abcdef-1\.md\./,
    );
    assert.match(lines.at(-1)?.text ?? "", /The summary after compaction 1:\n\nThe kernel idles/);
    // The run's folder in the knowledge base keeps it as a document of the run.
    const part = knowledgePart(
      s.env.service.ledger,
      "rig-1",
      0,
      s.env.service.ledger.latestEventId(),
    );
    const doc = part.find((i) => i.kind === "doc" && i.ref === rel);
    assert.ok(doc, JSON.stringify(part.map((i) => [i.kind, i.ref])));
    assert.match(
      String(doc?.title),
      /trial t-0123456789abcdef: the conversation before compaction 1/,
    );
    assert.match(String(doc?.body), /Cut: the file has/);
    assert.equal(doc?.by, "lane-2");
  });

  test("a harness's own compaction (OpenCode, Codex, Claude Code) is recorded the same way, with what it reports", async () => {
    const s = await setup();
    const c = s.env.service.compactions as Compactions;
    const of = compactionOf({ id: "t-0123456789abcdef", run: RUN, lane: "lane-2" });
    c.keep(of, 1, "## 1. text\n\nWhat Thermite saw.\n");
    c.record(of, {
      number: 1,
      tokensBefore: 180_000,
      tokensAfter: 21_000,
      how: "harness",
      harness: "claude-code",
      kept: true,
    });
    c.record(of, {
      number: 2,
      tokensBefore: null,
      tokensAfter: null,
      how: "harness",
      harness: "codex",
      kept: false,
    });
    const e = s.events("context_compacted").map((x) => x.body as Record<string, unknown>);
    assert.equal(e[0]?.harness, "claude-code");
    assert.equal(e[0]?.snapshot, "compactions/t-0123456789abcdef-1.md");
    assert.equal(e[1]?.snapshot, null, "a conversation not kept is said so");
    assert.equal(e[1]?.tokens_before, null);
    const lines = s.env.service.live.since(0, 1000).entries.map((l) => l.text);
    assert.ok(
      lines.some((l) =>
        /^Claude Code compacted the conversation \(compaction 1\) at about 180,000 tokens, down to about 21,000\./.test(
          l,
        ),
      ),
    );
    assert.ok(
      lines.some((l) =>
        /^Codex compacted the conversation \(compaction 2\)\. The trial goes on\. The conversation before it was not kept\./.test(
          l,
        ),
      ),
    );
  });

  test("a program's own conversation is kept where its summary said, and the summary it went on from is recorded", async () => {
    const s = await setup();
    const c = s.env.service.compactions as Compactions;
    const of = compactionOf({ id: "t-0123456789abcdef", run: RUN, lane: "lane-2" });
    // Where the program's summary is told the file is: the run's folder as the worker sees it.
    const at = c.keptAt(of, true);
    assert.equal(at.dir, join(s.env.service.paths.scratchDir, "research", RUN, "compactions"));
    assert.equal(at.stem, "t-0123456789abcdef");
    assert.equal(at.readable, true);
    c.fromHarness(of, "opencode", {
      number: 1,
      tokensBefore: null,
      tokensAfter: null,
      markdown:
        "# Trial t-0123456789abcdef (lane-2): the conversation before compaction 1\n\nOpenCode's own.\n",
      summary: `## Relevant Files\n- ${at.dir}/${at.stem}-1.md: the whole conversation`,
    });
    // The file its summary names is the one kept.
    assert.match(readFileSync(join(at.dir, `${at.stem}-1.md`), "utf8"), /OpenCode's own/);
    const e = s.events("context_compacted").map((x) => x.body as Record<string, unknown>);
    assert.equal(e[0]?.harness, "opencode");
    assert.equal(e[0]?.how, "harness");
    assert.equal(e[0]?.snapshot, "compactions/t-0123456789abcdef-1.md");
    assert.match(
      String(e[0]?.summary),
      /^## Relevant Files\n- .*compactions\/t-0123456789abcdef-1\.md/,
    );
    const lines = s.env.service.live.since(0, 1000).entries.map((l) => l.text);
    assert.ok(
      lines.some((l) =>
        /^OpenCode compacted the conversation \(compaction 1\)\. The trial goes on\. The conversation before it is kept in the run's research folder, compactions\/t-0123456789abcdef-1\.md\./.test(
          l,
        ),
      ),
    );
    assert.ok(lines.some((l) => /^The summary after compaction 1:\n\n## Relevant Files/.test(l)));
  });

  test("the kept conversations come back under compactions/ when scratch is cleared, and leave with the run's folder", async () => {
    const s = await setup();
    const c = s.env.service.compactions as Compactions;
    const of = compactionOf({ id: "t-0123456789abcdef", run: RUN, lane: "lane-2" });
    const { path } = c.keep(of, 1, "kept\n");
    rmSync(join(s.env.service.paths.scratchDir, "research"), { recursive: true, force: true });
    assert.equal(existsSync(path), false);
    const files = s.folder.exportFiles(RUN);
    assert.ok(files.files.includes("compactions/t-0123456789abcdef-1.md"), files.files.join(","));
    assert.equal(readFileSync(path, "utf8"), "kept\n");
    assert.throws(() => c.keep(of, 0, "x"), /whole number from 1/);
    assert.throws(() => s.folder.keepCompaction(RUN, "../escape.md", "x"), /not a file name/);
  });
});
