import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseContract } from "../../../src/core/contract.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { runTrial } from "../../../src/harness/agents/worker/index.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { ResearchFolder } from "../../../src/harness/research/folder.ts";
import { Research } from "../../../src/harness/research/research/index.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { researchFixture } from "../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/** One page on a local "site". */
async function web() {
  const server = createServer((req, res) => {
    if (req.url === "/robots.txt") return void res.writeHead(404).end();
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(
        "<html><head><title>Kernel notes</title></head><body><p>The weights stream from memory when the working set is larger than the cache.</p></body></html>",
      );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/p.html`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const QUOTE = "The weights stream from memory when the working set is larger than the cache.";

const bodies = (env: ReturnType<typeof makeHarnessEnv>, kind: string) =>
  env.service.ledger
    .eventsAfter(0, 10_000)
    .events.filter((e) => e.kind === kind)
    .map((e) => e.body as Record<string, unknown>);

describe("research in every mode", () => {
  test("the research events carry the text a knowledge base needs", async () => {
    const w = await web();
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
    const research = new Research(env.service.ledger, env.service.paths.stateDir, {
      allowPrivate: true,
    });
    const s = (await research.fetch("r-1", "lane-1", w.url)) as { source: string };
    assert.deepEqual(bodies(env, "source_fetched").at(-1), {
      source: s.source,
      domain: "127.0.0.1",
      status: 200,
      bytes: (bodies(env, "source_fetched").at(-1) as { bytes: number }).bytes,
      url: w.url,
      title: "Kernel notes",
      text: (bodies(env, "source_fetched").at(-1) as { text: string }).text,
    });
    // A hypothesis is an event too, with the verified claims it rests on.
    research.proposeHypothesis("r-1", "lane-1", {
      text: "Reads dominate.",
      supporting: ["c-none"],
    });
    const h = bodies(env, "hypothesis_added").at(-1) as Record<string, unknown>;
    assert.equal(h.lane, "lane-1");
    assert.equal(h.text, "Reads dominate.");
    assert.deepEqual(h.supporting, [], "only verified claims of the run");
    assert.match(String(h.hypothesis), /^h-[0-9a-f]{12}$/);
    // The text that was read, as the archive keeps it: the folder holds the source itself.
    const text = String((bodies(env, "source_fetched").at(-1) as { text: string }).text);
    assert.ok(text.includes(QUOTE), "the page's text, with the words a claim quotes");
    const long = `The weights stream from memory, ${"and so on ".repeat(80)}`;
    const c = research.addClaim("r-1", "lane-1", {
      text: long,
      quotes: [{ source: s.source, quote: QUOTE }],
    });
    const claim = bodies(env, "claim_added").at(-1) as Record<string, string>;
    assert.equal(claim.claim, c.claim);
    assert.equal(claim.text?.length, 500, "the claim's words, at most 500 characters");
    assert.ok(claim.text?.endsWith("…"));
    assert.equal(claim.quote, QUOTE);
    const ok = research.addClaim("r-1", "lane-1", {
      text: "Weights stream from memory when the working set exceeds the cache.",
      quotes: [{ source: s.source, quote: QUOTE }],
    });
    research.addFinding("r-1", "lane-1", {
      text: `Cutting bytes matters more than cutting instructions here. ${"x".repeat(1200)}`,
      summary: "The weights do not fit in the cache.",
      why_it_matters: "It says where to look first.",
      supporting: [ok.claim],
    });
    const finding = bodies(env, "finding_added").at(-1) as Record<string, string>;
    assert.equal(finding.statement?.length, 1000, "the statement, at most 1000 characters");
    assert.equal(finding.summary, "The weights do not fit in the cache.");
    assert.equal(finding.why, "It says where to look first.");
    const n = research.addNote("r-1", "lane-1", "Look for a second site.", [s.source], "t-1");
    assert.deepEqual(bodies(env, "research_note").at(-1), {
      note: n.note,
      by: "lane-1",
      text: "Look for a second site.",
      sources: [s.source],
      url: w.url,
      trial: "t-1",
    });
    assert.throws(() => research.addNote("r-1", "lane-1", "   "), /needs its text/);
    await w.close();
  });

  test("a hill-climb trial records sources, claims and notes in its run's folder; the rest stays research's", async () => {
    const w = await web();
    const env = makeHarnessEnv();
    const assigned = await env.service.applyCommand(
      env.sign("assign_campaign", env.assignPayload()),
    );
    assert.ok(assigned.status === "applied" && assigned.accepted, JSON.stringify(assigned));
    const { stateDir, scratchDir } = env.service.paths;
    const folder = new ResearchFolder({
      ledger: env.service.ledger,
      scratchRoot: join(scratchDir, "research"),
      stateRoot: join(stateDir, "research-work"),
      runner: new LocalRunner(scratchDir),
      knowledge: env.service.knowledge,
    });
    const research = new Research(env.service.ledger, stateDir, {
      allowPrivate: true,
      onChange: (run) => void folder.sync(run),
    });
    new Registry(env.service.ledger).startTrial({
      id: "t-0123456789abcdef",
      run: "smoke-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seedCommit,
      token: "code-token",
    });
    const api = createHarnessApi(env.service, { supervisor: "s", proposer: "p" }, { research });
    const call = (op: string, body: unknown) =>
      api.request(`/v1/research/${op}`, {
        method: "POST",
        headers: { authorization: "Bearer trial.code-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const fetched = await call("fetch", { url: w.url, run: "elsewhere" });
    assert.equal(fetched.status, 200, await fetched.clone().text());
    const { source } = (await fetched.json()) as { source: string };
    const claim = await call("claim", {
      text: "Weights stream from memory when the working set exceeds the cache.",
      quotes: [{ source, quote: QUOTE }],
    });
    assert.equal(((await claim.json()) as { verified: boolean }).verified, true);
    assert.equal((await call("note", { text: "Profile first.", sources: [source] })).status, 200);
    assert.equal((await call("search-corpus", { text: "working set" })).status, 200);
    for (const op of ["finding", "section", "stats", "hypothesis"]) {
      const r = await call(op, { text: "t", name: "n", body: "b" });
      assert.equal(r.status, 400, op);
      assert.match(await r.text(), /records sources, claims and notes only/);
    }
    const rows = env.service.ledger.db
      .prepare("select run, lane from note union all select run, lane from claim")
      .all()
      .map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { run: "smoke-1", lane: "lane-1" },
      { run: "smoke-1", lane: "lane-1" },
    ]);
    const root = folder.root("smoke-1");
    assert.ok(existsSync(join(root, "sources", `${source}.txt`)));
    assert.equal(
      readFileSync(join(root, "notes", "note-00001.md"), "utf8").split("\n")[2],
      "Profile first.",
    );
    assert.ok(!existsSync(join(root, "REPORT.md")), "a hill climb has no research report");
    assert.ok(!existsSync(join(root, "work")), "nor working areas");
    assert.match(readFileSync(join(root, "INDEX.md"), "utf8"), /- claims\/: 1 claims, 1 verified/);
    // Past research shows in the folder and its index, and stays out of the run's export.
    env.service.writeKnowledge("smoke-1", [
      {
        seq: 4,
        campaign: "kernels",
        rig: "rig-b",
        run: "kernels-7",
        kind: "note",
        ref: "12",
        title: "Vector loads need aligned pointers",
        body: "Vector loads need 16-byte aligned pointers.",
        by: "lane-2",
        url: null,
        sub: "lesson",
        at: "2026-10-16T00:00:00.000Z",
        updated_at: "2026-10-16T00:00:00.000Z",
      },
    ]);
    folder.sync("smoke-1");
    assert.match(
      readFileSync(join(root, "INDEX.md"), "utf8"),
      /- knowledge\/: past research .*1 note, from kernels/,
    );
    const exported = folder.exportFiles("smoke-1").files;
    assert.ok(exported.includes("INDEX.md"));
    assert.ok(exported.some((f) => f.startsWith("sources/")));
    assert.ok(!exported.some((f) => f.startsWith("knowledge")), "past research is not this run's");
    await w.close();
  });

  test("a code trial's Pi worker has the research tools for sources, claims and notes", async () => {
    const calls: { op: string; args: Record<string, unknown> }[] = [];
    let offered: string[] = [];
    const fake = await startFakeModel(({ messages, tools }) => {
      offered = tools.map((t) => t.function.name);
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0)
        return {
          toolCalls: [
            { name: "add_note", args: { text: "Profile first.", sources: ["s-1"], run: "other" } },
          ],
        };
      return { text: "nothing to submit" };
    });
    const dir = mkdtempSync(join(tmpdir(), "thermite-ws-"));
    const r = await runTrial(
      {
        trialId: "t-1",
        run: "smoke-1",
        lane: "lane-1",
        workspace: dir,
        parentCommit: "0".repeat(40),
        editablePaths: ["src/**"],
        brief: "b",
        wallMs: 30_000,
        maxTurns: 6,
      },
      {
        runner: new LocalRunner(dir),
        laneTool: ["lanetool"],
        model: {
          baseUrl: fake.url,
          model: "t",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: async () => {
          throw new Error("not submitted");
        },
        status: async () => ({}),
        research: async (op, args) => {
          calls.push({ op, args });
          return { note: 1 };
        },
      },
    );
    await fake.close();
    assert.equal(r.submitted, undefined);
    for (const name of ["fetch", "read_source", "search_corpus", "add_claim", "add_note"])
      assert.ok(offered.includes(name), name);
    for (const name of ["add_finding", "update_section", "progress"])
      assert.ok(!offered.includes(name), `${name} is research's`);
    assert.deepEqual(calls, [
      {
        op: "note",
        args: { text: "Profile first.", sources: ["s-1"], run: "smoke-1", lane: "lane-1" },
      },
    ]);
  });
});
