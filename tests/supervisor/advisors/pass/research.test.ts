import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import { Research } from "../../../../src/harness/research/research/index.ts";
import type { HarnessService } from "../../../../src/harness/service/index.ts";
import { AdvisorsConfig } from "../../../../src/supervisor/advisors/index.ts";
import {
  type AdviseConfig,
  adviseOnce,
  emptyAdviseState,
} from "../../../../src/supervisor/advisors/pass/index.ts";
import { serveAdvisorTools } from "../../../../src/supervisor/advisors/tools/mcp.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";
import { cardsUpToDate } from "../../../helpers/research-cards.ts";
import { fillResearch, makeResearchRun, servePages } from "../../../helpers/research-run.ts";

/**
 * Goal 098: a run's teachers read what the run itself found, read only, through the harness:
 * its sources, claims, hypotheses, findings, notes and files, and a search of all of it. A
 * research run's teachers always get these tools, a hill-climb or goal run's when its trials
 * recorded some, and teachers that may fetch any web page never.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const RESEARCH = ["list_research", "read_source", "read_research_file", "search_research"];
const CODE = ["list_files", "read_file", "read_diff", "read_evidence"];

function config(
  service: HarnessService,
  advisors: AdvisorsConfig,
  lines: string[],
  asked: string[],
): AdviseConfig {
  const api = createHarnessApi(service, tokens);
  return {
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
    advisors,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      asked.push(url.pathname);
      return api.request(`${url.pathname}${url.search}`, init as RequestInit);
    },
    live: (l) => lines.push(`${l.run ?? "-"} ${l.kind}: ${l.text}`),
  };
}

function runtime(url: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
  writeFileSync(join(dir, "key"), "test-key\n");
  return { name, runtime: "openai", base_url: url, model: name, api_key_file: join(dir, "key") };
}

const answer = { toolCalls: [{ name: "answer", args: { summary: "read", portfolio: [] } }] };

/**
 * A read of a run's own research. The final writer's look at the papers to write (goal 112) and
 * the synthesizer's at the answer cards to write (goal 117), which a rig with teachers makes each
 * round, are not one.
 */
const readsResearch = (p: string) =>
  p.startsWith("/v1/research/") &&
  p !== "/v1/research/papers/pending" &&
  p !== "/v1/research/cards/pending";

describe("a run's teachers read what the run found (goal 098)", () => {
  test("a research run's teachers read its claims, a source, a lane's file and a search before they propose", async (t: TestContext) => {
    const r = await makeResearchRun();
    t.after(() => r.close());
    const ids = await fillResearch(r);
    // Every answer card is up to date: the synthesizer has nothing to write (goal 117).
    cardsUpToDate(r.env.service, r.run);
    const seen = { tools: [] as string[], system: "", prompt: "" };
    const results: string[] = [];
    const fake = await startFakeModel(({ messages, tools }) => {
      seen.tools = tools.map((x) => x.function.name);
      seen.system = JSON.stringify(messages.find((m) => m.role === "system")?.content ?? "");
      const user = messages.find((m) => m.role === "user")?.content;
      seen.prompt =
        typeof user === "string"
          ? user
          : Array.isArray(user)
            ? user.map((p) => String((p as { text?: unknown }).text ?? "")).join("")
            : "";
      const done = messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      results.splice(0, results.length, ...done);
      const call = (name: string, args: unknown) => ({ toolCalls: [{ name, args }] });
      if (done.length === 0) return call("list_research", { kind: "claim", state: "draft" });
      if (done.length === 1) return call("read_source", { source: ids.sources[1], limit: 500 });
      if (done.length === 2)
        return call("read_research_file", { path: "lanes/lane-1/q0-synthesis.md" });
      if (done.length === 3) return call("search_research", { query: "clock", kinds: ["claim"] });
      return answer;
    });
    t.after(() => fake.close());
    const asked: string[] = [];
    await adviseOnce(
      config(
        r.env.service,
        AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-a")] }),
        [],
        asked,
      ),
      emptyAdviseState(),
    );
    // The research tools, and none of the code tools: a research run has no code.
    for (const name of RESEARCH) assert.ok(seen.tools.includes(name), name);
    for (const name of CODE) assert.ok(!seen.tools.includes(name), name);
    // Told to read what the run found before proposing, and that it is data.
    assert.match(
      seen.system,
      /When you have the tools, read what the run found before you propose/,
    );
    // A research run's teachers get the research prompt (goal 117): tasks cite what they rest on.
    assert.match(seen.system, /You review an automated research run that reads sources/);
    assert.match(seen.system, /the run's source, claim, finding or card ids/);
    // The brief's summary, ahead of the long parts.
    const brief = JSON.parse(seen.prompt.slice(seen.prompt.indexOf("\n") + 1)) as Record<
      string,
      unknown
    >;
    const keys = Object.keys(brief);
    assert.ok(keys.indexOf("research") >= 0 && keys.indexOf("research") < keys.indexOf("evidence"));
    assert.deepEqual((brief.research as { claims: unknown }).claims, { verified: 2, draft: 1 });
    // What each tool read.
    assert.equal(results.length, 4, results.join("\n"));
    const drafts = JSON.parse(results[0] as string) as {
      items: { id: string; why_draft: string[] }[];
    };
    assert.deepEqual(
      drafts.items.map((x) => x.id),
      [ids.claims.draft],
    );
    assert.match(String(drafts.items[0]?.why_draft), /quote not found verbatim/);
    assert.match(results[1] ?? "", /Long research campaigns need a clock the workers cannot stop/);
    assert.match(results[2] ?? "", /3\\tWhat we know: the harness archived 42 pages\./);
    assert.match(results[3] ?? "", new RegExp(ids.claims.clock));
    assert.deepEqual(asked.filter(readsResearch), [
      "/v1/research/claims",
      "/v1/research/source",
      "/v1/research/file",
      "/v1/research/search",
    ]);
    assert.ok(!asked.some((p) => p.startsWith("/v1/code/")), asked.join(", "));
  });

  test("a hill-climb run's teachers get them only once its trials recorded research; with an open fetch, never, said once", async (t: TestContext) => {
    const offered: string[][] = [];
    const fake = await startFakeModel(({ tools }) => {
      offered.push(tools.map((x) => x.function.name));
      return answer;
    });
    t.after(() => fake.close());
    const teachers = AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-a")] });

    // A hill-climb run whose trials recorded nothing: the code tools, none of the research tools.
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const asked: string[] = [];
    await adviseOnce(config(env.service, teachers, [], asked), emptyAdviseState());
    assert.ok(offered.length > 0);
    for (const name of CODE) assert.ok(offered.at(-1)?.includes(name), name);
    for (const name of RESEARCH) assert.ok(!offered.at(-1)?.includes(name), name);
    assert.ok(!asked.some(readsResearch), asked.join(", "));

    // Its trials recorded a source and a claim (goal 065): now they get both.
    const pages = await servePages();
    t.after(() => pages.close());
    const research = new Research(env.service.ledger, env.service.paths.stateDir, {
      allowPrivate: true,
    });
    const a = (await research.fetch("js-1", "lane-1", `${pages.base}/a.html`)) as {
      source: string;
    };
    research.addClaim("js-1", "lane-1", {
      text: "The first run archived 42 pages.",
      quotes: [{ source: a.source, quote: "The harness archived 42 pages in its first run." }],
    });
    await adviseOnce(config(env.service, teachers, [], []), emptyAdviseState());
    for (const name of [...CODE, ...RESEARCH]) assert.ok(offered.at(-1)?.includes(name), name);

    // A research run's teachers that may fetch any web page: none of them, said once.
    const r = await makeResearchRun();
    t.after(() => r.close());
    await fillResearch(r);
    cardsUpToDate(r.env.service, r.run);
    const lines: string[] = [];
    const open: string[] = [];
    const cfg = config(
      r.env.service,
      AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-a")], fetch_domains: ["*"] }),
      lines,
      open,
    );
    let state = await adviseOnce(cfg, emptyAdviseState());
    state = await adviseOnce(cfg, { ...state, lastTeacherAt: {} });
    for (const name of [...RESEARCH, ...CODE]) assert.ok(!offered.at(-1)?.includes(name), name);
    assert.ok(offered.at(-1)?.includes("fetch_url"));
    assert.ok(!open.some(readsResearch), open.join(", "));
    const said = lines.filter((l) =>
      l.includes(
        `so they read none of the run's own sources, claims, hypotheses, findings, notes or files: only the summary in their brief`,
      ),
    );
    assert.equal(said.length, 1, lines.join("\n"));
    // A research run has no code to withhold: that line is not said.
    assert.ok(!lines.some((l) => l.includes("so they read no code")), lines.join("\n"));
  });

  test("in Claude Code, OpenCode and Codex the research tools are served on localhost, read only", async () => {
    const asked: string[] = [];
    const server = await serveAdvisorTools({
      research: {
        list: async (kind, o) => {
          asked.push(`list ${kind} ${JSON.stringify(o)}`);
          return { items: [] };
        },
        readSource: async (s, o, l) => {
          asked.push(`source ${s} ${o} ${l}`);
          return { text: "archived words" };
        },
        readFile: async (p, o, l) => {
          asked.push(`file ${p} ${o} ${l}`);
          return { content: "1\tline" };
        },
        search: async (q, o) => {
          asked.push(`search ${q} ${JSON.stringify(o)}`);
          return { items: [] };
        },
      },
    });
    try {
      const config = JSON.parse(String(server.args[1])) as {
        mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
      };
      const entry = config.mcpServers.thermite;
      assert.ok(entry);
      assert.deepEqual(server.args.slice(2), [
        "--allowedTools",
        ...RESEARCH.map((n) => `mcp__thermite__${n}`),
      ]);
      const client = new Client({ name: "test", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: entry.headers },
        }),
      );
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((x) => [x.name, x.annotations?.readOnlyHint]).sort(),
        RESEARCH.map((n) => [n, true]).sort(),
      );
      const r = await client.callTool({
        name: "read_source",
        arguments: { source: "s-1", offset: 10, limit: 20 },
      });
      await client.callTool({
        name: "list_research",
        arguments: { kind: "claim", question: 1, state: "draft" },
      });
      await client.callTool({ name: "read_research_file", arguments: { path: "REPORT.md" } });
      await client.callTool({
        name: "search_research",
        arguments: { query: "clock", kinds: ["claim", "source"] },
      });
      // A kind the run's research has not: refused before the harness is asked.
      const bad = await client.callTool({ name: "list_research", arguments: { kind: "attempt" } });
      await client.close();
      assert.match(JSON.stringify(r.content), /archived words/);
      assert.equal(bad.isError, true);
      assert.deepEqual(asked, [
        "source s-1 10 20",
        'list claim {"question":1,"state":"draft"}',
        "file REPORT.md undefined undefined",
        'search clock {"kinds":["claim","source"]}',
      ]);
    } finally {
      await server.close();
    }
  });
});
