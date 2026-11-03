import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { STE_SHORT_RULES } from "../../../../src/agents/roles/final-writer.ts";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import { AdvisorsConfig } from "../../../../src/supervisor/advisors/index.ts";
import {
  type AdviseConfig,
  adviseOnce,
  emptyAdviseState,
} from "../../../../src/supervisor/advisors/pass/index.ts";
import { serveAdvisorTools } from "../../../../src/supervisor/advisors/tools/mcp.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { cardsUpToDate } from "../../../helpers/research-cards.ts";
import { answeredResearchRun, goodPaper } from "../../../helpers/research-paper.ts";

/**
 * Goal 112: the supervisor's final writer writes an answered research run's paper with the first
 * teacher's model. It reads the run's research, checks its drafts with check_paper (the harness's
 * code checks) and ste_check (the rig's STE checker, when the deployment gives one), and gets the
 * checker's guide in its prompt, or short STE rules without one. The supervisor runs the checker
 * itself on the paper it posts, and posts its result with the paper.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const RUN = "r-1";
const RESEARCH_TOOLS = ["list_research", "read_source", "read_research_file", "search_research"];

/**
 * A stand-in for the deployment's STE checker (Thermite ships none): it is run as
 * `node <script> --json --mode descriptive -`, reads the text on its input, and prints the same
 * JSON a real checker prints. It finds one error, the word "utilize", and refuses other arguments.
 */
const CHECKER = `import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.join(" ") !== "--json --mode descriptive -") {
  process.stderr.write("unexpected arguments: " + args.join(" "));
  process.exit(2);
}
const text = readFileSync(0, "utf8");
const findings = [];
text.split("\\n").forEach((line, i) => {
  const at = line.search(/\\butilize\\b/i);
  if (at >= 0)
    findings.push({ path: "<stdin>", line: i + 1, column: at + 1, severity: "error", rule: "1.1",
      message: "utilize is not an approved word: use use", text: "utilize" });
});
const counts = { error: findings.length, warning: 0, info: 0 };
process.stdout.write(JSON.stringify({ version: "0.0.1-test", issue: "test", counts, findings }, null, 1) + "\\n");
process.exit(counts.error ? 1 : 0);
`;

/** The stand-in checker in a skill-like folder, with its guide beside it when one is given. */
function checkerAt(guide?: string): string {
  const root = mkdtempSync(join(tmpdir(), "thermite-ste-"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "ste_lint.mjs"), CHECKER);
  if (guide) {
    mkdirSync(join(root, "reference"));
    writeFileSync(join(root, "reference", "ste-guide.md"), guide);
  }
  return join(root, "scripts", "ste_lint.mjs");
}

/** A research run waiting for its paper: its review accepted, its supervisor's writer asked. */
async function waiting(t: TestContext) {
  const s = await answeredResearchRun(RUN);
  t.after(() => s.close());
  await s.env.service.setAdvisors({ auditor: false, review_panel: 0, writer: true }, "supervisor");
  assert.ok(s.env.service.papers.request(RUN, "s"));
  // Every answer card is up to date: only the final writer works in these rounds (goal 117).
  cardsUpToDate(s.env.service, RUN);
  const events = (kind: string) =>
    s.ledger.db
      .prepare("select body from event where kind = ? and subject = ? order by id")
      .all(kind, RUN)
      .map((e) => JSON.parse(String((e as { body: string }).body)) as Record<string, unknown>);
  return { ...s, events };
}

function config(
  s: Awaited<ReturnType<typeof waiting>>,
  advisors: AdvisorsConfig,
  steChecker?: string,
): AdviseConfig {
  const api = createHarnessApi(s.env.service, tokens);
  return {
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
    advisors,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      return api.request(`${url.pathname}${url.search}`, init as RequestInit);
    },
    ...(steChecker ? { steChecker } : {}),
  };
}

function runtime(url: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
  writeFileSync(join(dir, "key"), "test-key\n");
  return { name, runtime: "openai", base_url: url, model: name, api_key_file: join(dir, "key") };
}

/** The teachers' round is not due: only the final writer works in these rounds. */
const state = () => ({ ...emptyAdviseState(), lastTeacherAt: { [RUN]: new Date().toISOString() } });

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => String((p as { text?: unknown }).text ?? "")).join("")
      : "";

describe("the final writer writes the research paper (goal 112)", () => {
  test("its tools: check_paper gives the harness's problems, ste_check runs the deployment's checker; the paper is posted with the checker's result", async (t) => {
    const s = await waiting(t);
    const seen = { system: "", tools: [] as string[], results: [] as string[] };
    const fake = await startFakeModel(({ messages, tools }) => {
      seen.system = textOf(messages.find((m) => m.role === "system")?.content);
      seen.tools = tools.map((x) => x.function.name);
      const results = messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
      if (!results.length)
        return {
          toolCalls: [
            {
              name: "check_paper",
              args: {
                markdown: goodPaper(s.ids, {
                  abstract: "## Abstract\n\nA short abstract.",
                  results: "",
                }),
              },
            },
            { name: "ste_check", args: { text: "We utilize the archive." } },
          ],
        };
      seen.results = results;
      return {
        toolCalls: [
          {
            name: "answer",
            args: {
              paper: goodPaper(s.ids),
              experiments: [
                {
                  title: "Measure the archive on a second site",
                  why: "Every claim comes from one site.",
                  kind: "hill_climb",
                  measure: "pages archived a minute, higher",
                  findings: [s.ids.findings.supported],
                },
              ],
            },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const out = await adviseOnce(
      config(s, AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-1")] }), checkerAt()),
      state(),
    );
    assert.equal(out.stats.papers, 1, JSON.stringify(out.stats));
    assert.match(seen.system, /You are the final writer of a research run/);
    for (const name of [...RESEARCH_TOOLS, "check_paper", "ste_check"])
      assert.ok(seen.tools.includes(name), name);
    // check_paper: the harness's own problems, with their lines.
    const checked = JSON.parse(seen.results[0] ?? "{}") as {
      ok: boolean;
      problems: { problem: string }[];
    };
    assert.equal(checked.ok, false);
    assert.ok(
      checked.problems.some((p) => p.problem.startsWith("question 2 is not answered: ")),
      JSON.stringify(checked),
    );
    // ste_check: the stand-in checker's findings.
    const ste = JSON.parse(seen.results[1] ?? "{}") as {
      checked: boolean;
      counts: { error: number };
      findings: { line: number; rule: string; message: string }[];
    };
    assert.equal(ste.checked, true);
    assert.equal(ste.counts.error, 1);
    assert.deepEqual(
      ste.findings.map((f) => [f.line, f.rule, f.message]),
      [[1, "1.1", "utilize is not an approved word: use use"]],
    );
    // The supervisor ran the checker on the paper it posted: STE checked, no error.
    const accepted = s.events("research_paper_accepted")[0] as Record<string, unknown>;
    assert.equal(accepted.writer, "teacher-1");
    assert.deepEqual(accepted.ste, {
      checked: true,
      version: "0.0.1-test",
      issue: "test",
      counts: { error: 0, warning: 0, info: 0 },
    });
    assert.equal((accepted.experiments as unknown[]).length, 1);
    // Its model calls are the final writer's, under its own name (goal 166), not the teachers'.
    const calls = s.events("model_call");
    assert.ok(calls.length >= 1);
    assert.ok(
      calls.every((c) => c.agent === "final_writer"),
      JSON.stringify(calls[0]),
    );
    // And its prompt is kept with the run, as its role rendered it.
    const kept = s.events("agent_prompt").filter((p) => p.role === "final-writer");
    assert.equal(kept.length, 1);
    assert.match(String(kept[0]?.call), /^final paper /);
  });

  test("in Pi, a paper the checks refuse goes back to the writer within its call, and it revises", async (t) => {
    const s = await waiting(t);
    const said: string[] = [];
    const fake = await startFakeModel(({ messages }) => {
      const results = messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
      said.push(...results.slice(said.length));
      // First: a paper with an STE error and a number no claim gives; then the paper that holds.
      const paper = results.length
        ? goodPaper(s.ids)
        : goodPaper(s.ids, {
            next: `## Future work\n\nWe utilize a second site for 9 more pages [${s.ids.claims.verified}].`,
          });
      return { toolCalls: [{ name: "answer", args: { paper, experiments: [] } }] };
    });
    t.after(() => fake.close());
    await adviseOnce(
      config(s, AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-1")] }), checkerAt()),
      state(),
    );
    // One refusal within the call; the revised answer was taken.
    assert.equal(said.length, 1, said.join(" | "));
    assert.match(said[0] ?? "", /^refused: /);
    assert.match(said[0] ?? "", /the number 9 is not in the claims this paragraph cites/);
    assert.match(said[0] ?? "", /STE 1\.1: utilize is not an approved word/);
    assert.equal(s.events("research_paper_refused").length, 0, "nothing refused was posted");
    assert.equal(s.events("research_paper_accepted").length, 1);
  });

  test("a paper the checker finds an error in is posted with that result and refused; the next round's package carries the problems", async (t) => {
    const s = await waiting(t);
    // A command-line writer answers once, with no check: the supervisor's own STE run catches it.
    const dir = mkdtempSync(join(tmpdir(), "thermite-cli-"));
    const script = join(dir, "writer.mjs");
    const paper = goodPaper(s.ids, {
      next: `## Future work\n\nWe utilize a second site [${s.ids.claims.verified}].`,
    });
    writeFileSync(
      script,
      `process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify(${JSON.stringify({ paper, experiments: [] })})));`,
    );
    const advisors = AdvisorsConfig.parse({
      teachers: [
        { name: "cli-writer", runtime: "cli", argv: [process.execPath, script], restricted: true },
      ],
    });
    await adviseOnce(config(s, advisors, checkerAt()), state());
    const refused = s.events("research_paper_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.ste_checked, true);
    assert.deepEqual(refused[0]?.problems, [
      "the STE checker found 1 error",
      `line ${paper.split("\n").findIndex((l) => l.includes("utilize")) + 1}: STE 1.1: utilize is not an approved word: use use ("utilize")`,
    ]);
    const pkg = s.env.service.paperPackages()[0];
    assert.deepEqual(pkg?.last_refusal?.problems, refused[0]?.problems);
    assert.equal(s.ledger.runs.get(RUN)?.status, "running");
  });

  test("the prompt: the checker's guide when it is beside the checker, else short STE rules; without a checker, ste_check says so and the paper is not checked", async (t) => {
    const s = await waiting(t);
    const systems: string[] = [];
    const results: string[] = [];
    // The run the writer works on now (each part below has its own).
    let ids = s.ids;
    const fake = await startFakeModel(({ messages }) => {
      const system = textOf(messages.find((m) => m.role === "system")?.content);
      const tools = messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
      if (!tools.length) {
        systems.push(system);
        return { toolCalls: [{ name: "ste_check", args: { text: "A short text." } }] };
      }
      results.push(tools[0] ?? "");
      return {
        toolCalls: [{ name: "answer", args: { paper: goodPaper(ids), experiments: [] } }],
      };
    });
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-1")] });
    // Without a checker: the short rules, and ste_check says the rig has none.
    await adviseOnce(config(s, advisors), state());
    assert.ok(systems[0]?.includes(STE_SHORT_RULES));
    assert.deepEqual(JSON.parse(results[0] ?? "{}"), {
      checked: false,
      why: "the rig has no STE checker",
    });
    assert.deepEqual(s.events("research_paper_accepted")[0]?.ste, {
      checked: false,
      why: "the rig has no STE checker",
    });
    // A checker with its guide beside it: the guide, not the short rules.
    const other = await waiting(t);
    ids = other.ids;
    const guided = AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-1")] });
    await adviseOnce(
      config(other, guided, checkerAt("GUIDE-MARKER: write one topic in a sentence.")),
      state(),
    );
    assert.match(systems[1] ?? "", /GUIDE-MARKER: write one topic in a sentence\./);
    assert.ok(!systems[1]?.includes(STE_SHORT_RULES));
    assert.equal(other.events("research_paper_accepted").length, 1);
    // A checker with no guide beside it: the short rules.
    const third = await waiting(t);
    ids = third.ids;
    await adviseOnce(config(third, guided, checkerAt()), state());
    assert.ok(systems[2]?.includes(STE_SHORT_RULES));
    assert.equal(third.events("research_paper_accepted").length, 1);
  });

  test("in Claude Code, OpenCode and Codex the writer's checks are served on localhost with the research tools", async () => {
    const asked: string[] = [];
    const server = await serveAdvisorTools({
      paper: {
        check: async (markdown) => {
          asked.push(`check ${markdown}`);
          return { ok: true, problems: [] };
        },
        ste: async (text) => {
          asked.push(`ste ${text}`);
          return { checked: false, why: "the rig has no STE checker" };
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
        "mcp__thermite__check_paper",
        "mcp__thermite__ste_check",
      ]);
      const client = new Client({ name: "test", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: entry.headers },
        }),
      );
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((x) => [x.name, x.annotations?.readOnlyHint]).sort(), [
        ["check_paper", true],
        ["ste_check", true],
      ]);
      const r = await client.callTool({ name: "ste_check", arguments: { text: "A text." } });
      await client.callTool({ name: "check_paper", arguments: { markdown: "# A paper" } });
      await client.close();
      assert.match(JSON.stringify(r.content), /the rig has no STE checker/);
      assert.deepEqual(asked, ["ste A text.", "check # A paper"]);
    } finally {
      await server.close();
    }
  });
});
