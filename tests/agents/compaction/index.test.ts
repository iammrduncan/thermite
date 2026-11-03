import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CompactionReport, Compactor } from "../../../src/agents/compaction/index.ts";
import type { Section } from "../../../src/agents/prompt.ts";
import { renderCompacted, renderOwnerMessages } from "../../../src/agents/roles/index.ts";
import { runResearchTrial } from "../../../src/harness/agents/research/worker.ts";
import { type CompactionLink, runTrial } from "../../../src/harness/agents/worker/index.ts";
import { prepareWorkspace } from "../../../src/harness/agents/workspace.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../helpers/judge-env.ts";

const laneTool = [
  process.execPath,
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  fileURLToPath(new URL("../../../src/harness/agents/lanetool.ts", import.meta.url)),
];

type Sent = { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }[];

/** Whether a request is the compaction's summary call (its fixed prompt). */
const isSummary = (messages: Sent) =>
  JSON.stringify(messages[0]?.content ?? "").includes("You summarize an agent's work so far");

const textOf = (m: Sent[number]) =>
  typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");

/** Every tool call in a request has its result, and every result its call. */
function pairsWhole(messages: Sent): boolean {
  const calls = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant")
      for (const c of (m.tool_calls as { id: string }[] | undefined) ?? []) calls.add(c.id);
    if (m.role === "tool" && !calls.delete(String(m.tool_call_id))) return false;
  }
  return calls.size === 0;
}

/** A place to keep the conversations, as the harness API does: a file per compaction. */
function keeper() {
  const dir = mkdtempSync(join(tmpdir(), "thermite-compaction-"));
  const kept: { n: number; markdown: string }[] = [];
  const reports: CompactionReport[] = [];
  const link: CompactionLink = {
    keep: async (n, markdown) => {
      kept.push({ n, markdown });
      const path = join(dir, "compactions", `t-${n}.md`);
      mkdirSync(join(dir, "compactions"), { recursive: true });
      writeFileSync(path, markdown);
      return { path, rel: `compactions/t-${n}.md` };
    },
    done: async (r) => {
      reports.push(r);
    },
  };
  return { link, kept, reports };
}

async function codeTrial(o: {
  script: Parameters<typeof startFakeModel>[0];
  contextWindow: number;
  compactAt?: number;
  brief?: string | Section[];
  link?: CompactionLink | undefined;
}) {
  const env = makeJudgeEnv();
  await env.service.applyCommand(env.assign);
  const runner = new LocalRunner(env.paths.scratchDir);
  const champion = env.ledger.champions.current("js-1");
  const ws = await prepareWorkspace({
    runner,
    scratchDir: env.paths.scratchDir,
    mirror: env.service.mirrorFor("proj"),
    commit: champion.commit_sha,
    lane: "lane-1",
  });
  const fake = await startFakeModel(o.script);
  try {
    return await runTrial(
      {
        trialId: "t-compact",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: o.brief ?? "Make work() faster without changing its result.",
        wallMs: 120_000,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: fake.url,
          model: "test",
          apiKey: "k",
          contextWindow: o.contextWindow,
          compactAt: o.compactAt,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
        compaction: o.link,
      },
    );
  } finally {
    await fake.close();
  }
}

describe("compaction in Pi (goal 070)", () => {
  test("a conversation that crosses the compaction point is kept, summarized and goes on to submit; nobody is told to submit early", async () => {
    const k = keeper();
    const agentCalls: Sent[] = [];
    let summaries = 0;
    let replies = 0;
    const r = await codeTrial({
      contextWindow: 32_000,
      link: k.link,
      script: ({ messages }) => {
        const m = messages as Sent;
        if (isSummary(m)) {
          summaries++;
          // The summary call reads the conversation: the brief and the tools' results are in it.
          assert.match(textOf(m[1] as Sent[number]), /Make work\(\) faster/);
          return { text: "SUMMARY-ONE: the kernel idles in Atomics.wait; remove it next." };
        }
        agentCalls.push(m);
        replies++;
        // Three reads, each reply's usage climbing past 80% of 32,000 (25,600) on the third.
        if (replies <= 3)
          return {
            toolCalls: [{ name: "read_file", args: { path: "src/kernel/work.mjs" } }],
            usage: { prompt: [4000, 12_000, 26_000][replies - 1] as number, completion: 50 },
          };
        if (replies === 4)
          return {
            toolCalls: [
              { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
            ],
          };
        if (replies === 5)
          return {
            toolCalls: [
              { name: "submit", args: { hypothesis: "remove the wait", known_flaws: [] } },
            ],
          };
        return { text: "done" };
      },
    });
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.equal(r.compactions, 1);
    assert.equal(summaries, 1);
    // The snapshot: every message and tool result, in order.
    assert.equal(k.kept.length, 1);
    const md = k.kept[0]?.markdown ?? "";
    assert.match(md, /Trial t-compact \(lane-1\): the conversation before compaction 1/);
    assert.match(md, /## 1\. System/);
    assert.match(md, /Make work\(\) faster/);
    assert.equal((md.match(/Tool call `read_file`/g) ?? []).length, 3);
    assert.equal((md.match(/Tool result: read_file/g) ?? []).length, 3);
    assert.match(md, /Atomics\.wait/, "the tool results' text is in it");
    // The call after the compaction: the brief, the summary with the document's path, the most
    // recent turns, each tool call with its result.
    const after = agentCalls[3] as Sent;
    const users = after.filter((m) => m.role === "user").map(textOf);
    assert.match(users[0] ?? "", /Make work\(\) faster/);
    assert.match(users[1] ?? "", /SUMMARY-ONE/);
    assert.match(users[1] ?? "", /compaction 1/);
    // A code trial's agent reads it with its shell, outside the project's tree.
    assert.match(
      users[1] ?? "",
      /compactions\/t-1\.md\. Read it with the run tool when you need a detail/,
    );
    assert.ok(pairsWhole(after), JSON.stringify(after));
    assert.ok(
      after.some((m) => m.role === "tool"),
      "the most recent turn is kept",
    );
    // No request ever asked for an early submission.
    for (const call of agentCalls)
      for (const m of call)
        assert.doesNotMatch(
          textOf(m),
          /close to the model's context limit|submit your best working change now/,
        );
    // The report: tokens before and after, the summary and the path.
    assert.equal(k.reports.length, 1);
    const rep = k.reports[0] as CompactionReport;
    assert.equal(rep.how, "summary");
    assert.equal(rep.number, 1);
    assert.ok(rep.tokensBefore >= 25_600, String(rep.tokensBefore));
    assert.ok(rep.tokensAfter < rep.tokensBefore, JSON.stringify(rep));
    assert.match(String(rep.summary), /SUMMARY-ONE/);
    assert.match(String(rep.path), /t-1\.md$/);
  });

  test("a failed summary call leaves out the oldest tool results' bodies, and the trial goes on", async () => {
    const k = keeper();
    const agentCalls: Sent[] = [];
    let replies = 0;
    const big = "x".repeat(30_000);
    const r = await codeTrial({
      contextWindow: 12_000,
      compactAt: 50,
      link: k.link,
      script: ({ messages }) => {
        const m = messages as Sent;
        if (isSummary(m)) return { fail: 400, failMessage: "the summary model is down" };
        agentCalls.push(m);
        replies++;
        // Each run prints about 1,700 tokens; the conversation passes half of 12,000 on the
        // fourth, and must be cut to half the window again.
        if (replies <= 4)
          return {
            toolCalls: [{ name: "run", args: { command: `printf '%s' ${big.slice(0, 5900)}` } }],
            usage: { prompt: [1000, 2000, 3000, 9000][replies - 1] as number, completion: 50 },
          };
        if (replies === 5)
          return {
            toolCalls: [
              { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
            ],
          };
        if (replies === 6)
          return {
            toolCalls: [
              { name: "submit", args: { hypothesis: "remove the wait", known_flaws: [] } },
            ],
          };
        return { text: "done" };
      },
    });
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.equal(r.compactions, 1);
    assert.equal(k.reports[0]?.how, "trimmed");
    assert.match(String(k.reports[0]?.error), /the summary failed/);
    const after = agentCalls[4] as Sent;
    const tools = after.filter((m) => m.role === "tool").map(textOf);
    // Every result is still there, the oldest as one-line stubs naming the kept conversation.
    assert.equal(tools.length, 4);
    assert.match(
      tools[0] ?? "",
      /left out to save room: .* characters from run\. It is in .*t-1\.md/,
    );
    assert.doesNotMatch(tools.at(-1) ?? "", /left out to save room/);
    assert.ok(pairsWhole(after));
    assert.match(
      after
        .filter((m) => m.role === "user")
        .map(textOf)
        .join("\n"),
      /bodies of older tool results were left out/,
    );
  });

  test("a provider's context error compacts the conversation, and the trial goes on", async () => {
    const k = keeper();
    let replies = 0;
    let failed = false;
    const r = await codeTrial({
      // An unknown window: only the provider can say the context is full.
      contextWindow: 0,
      link: k.link,
      script: ({ messages }) => {
        const m = messages as Sent;
        if (isSummary(m)) return { text: "SUMMARY-TWO: read the kernel twice." };
        if (!failed && m.filter((x) => x.role === "tool").length === 2) {
          failed = true;
          return { fail: 400, failMessage: "This model's maximum context length is 8192 tokens" };
        }
        replies++;
        if (replies <= 2)
          // Long outputs, which fill the context the provider will not name.
          return {
            toolCalls: [{ name: "run", args: { command: `printf '%s' ${"y".repeat(5900)}` } }],
          };
        if (replies === 3) {
          assert.ok(
            m.some((x) => textOf(x).includes("SUMMARY-TWO")),
            "the call after the error carries the summary",
          );
          return {
            toolCalls: [
              { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
            ],
          };
        }
        if (replies === 4)
          return {
            toolCalls: [
              { name: "submit", args: { hypothesis: "remove the wait", known_flaws: [] } },
            ],
          };
        return { text: "done" };
      },
    });
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.equal(r.compactions, 1);
    assert.equal(k.kept.length, 1);
  });

  test("only a conversation that cannot fit even compacted ends the trial, as context, in words", async () => {
    const k = keeper();
    let calls = 0;
    let summaries = 0;
    const r = await codeTrial({
      contextWindow: 4096,
      link: k.link,
      // An owner's message far larger than the window: the first message's cut to the window
      // keeps it whole (goal 166), and no compaction can make it fit.
      brief: [
        { id: "brief", source: "assignment", text: "Make work() faster." },
        ...renderOwnerMessages([`Background. ${"Background. ".repeat(2000)}`], []),
      ],
      script: ({ messages }) => {
        if (isSummary(messages as Sent)) {
          summaries++;
          return { text: "SUMMARY: nothing done yet." };
        }
        calls++;
        return { fail: 400, failMessage: "This model's maximum context length is 4096 tokens" };
      },
    });
    assert.equal(r.stopped, "context");
    assert.match(
      String(r.error),
      /does not fit the model's context window of 4,096 tokens even after compaction/,
    );
    // The estimate alone never ends a trial: the provider said the context is full, and the
    // compaction tried then could not make it fit.
    assert.equal(calls, 1);
    assert.equal(summaries, 1);
    assert.equal(r.compactions, undefined, "no compaction was applied");
  });

  test("a compaction the owner asks for (the Pi view's /compact) comes at the next request, whatever its size, and never ends the trial", async () => {
    const stops: string[] = [];
    const reports: CompactionReport[] = [];
    const c = new Compactor({
      window: 200,
      convert: (m) => m as never,
      // A summary larger than the window: the compacted conversation still does not fit.
      summarize: async () => "SUMMARY ".repeat(400),
      keep: async () => ({ path: "compactions/t-1.md" }),
      done: async (r) => {
        reports.push(r);
      },
      stop: (why) => stops.push(why),
      title: "Trial t-1 (lane-1)",
      after: (x) => renderCompacted({ role: "worker", turn: 1, ...x }),
    });
    const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
    const assistant = (text: string) => ({
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
      timestamp: 0,
    });
    const messages = [user("the brief"), assistant("a reply"), user("go on"), assistant("more")];
    const agent = { state: { messages } };
    const hook = c.hook(agent as never);
    const request = () =>
      hook({ context: { messages } as never, model: {} as never, thinkingLevel: "off" });
    // Small, under the point: no compaction until asked.
    assert.equal(await request(), undefined);
    c.force("asked");
    assert.ok(await request(), "compacted at the next request");
    assert.equal(c.count, 1);
    assert.deepEqual(stops, [], "left to the provider, not ended");
    assert.equal(reports.length, 1);
    assert.equal(await request(), undefined, "once");
  });

  test("an estimate over the window alone sends the request: the provider decides", async () => {
    let calls = 0;
    const r = await codeTrial({
      contextWindow: 4096,
      // Over the window, and kept whole by the first message's cut: an owner's message.
      brief: [
        { id: "brief", source: "assignment", text: "Make work() faster." },
        ...renderOwnerMessages([`Background. ${"Background. ".repeat(2000)}`], []),
      ],
      script: ({ messages }) => {
        if (isSummary(messages as Sent)) return { text: "SUMMARY: a change is written." };
        calls++;
        return calls === 1
          ? {
              toolCalls: [
                { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
              ],
            }
          : { toolCalls: [{ name: "submit", args: { hypothesis: "less work", known_flaws: [] } }] };
      },
    });
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
  });

  test("a research trial compacts the same way and goes on until it ends", async () => {
    const k = keeper();
    const agentCalls: Sent[] = [];
    let replies = 0;
    const page = "The harness archived 42 pages. ".repeat(300);
    const fake = await startFakeModel(({ messages }) => {
      const m = messages as Sent;
      if (isSummary(m)) return { text: "SUMMARY-THREE: fetched the page three times." };
      agentCalls.push(m);
      replies++;
      if (replies <= 3)
        return {
          toolCalls: [{ name: "fetch", args: { url: `https://example.com/${replies}` } }],
          usage: { prompt: [4000, 12_000, 27_000][replies - 1] as number, completion: 50 },
        };
      return { text: "I have recorded what I found." };
    });
    try {
      const r = await runResearchTrial(
        {
          trialId: "t-research",
          run: "r-1",
          lane: "lane-1",
          brief: "Find out how many pages the harness archived.",
          wallMs: 60_000,
        },
        {
          model: {
            baseUrl: fake.url,
            model: "test",
            apiKey: "k",
            contextWindow: 32_000,
            maxTokens: 2000,
          },
          call: async (op) => (op === "fetch" ? { source: "s-1", text: page } : {}),
          compaction: k.link,
        },
      );
      assert.equal(r.stopped, "finished", JSON.stringify(r));
      assert.equal(r.compactions, 1);
      assert.match(k.kept[0]?.markdown ?? "", /Research trial t-research \(lane-1\)/);
      assert.equal((k.kept[0]?.markdown.match(/Tool result: fetch/g) ?? []).length, 3);
      const after = agentCalls[3] as Sent;
      const summary = after.filter((m) => m.role === "user").map(textOf)[1] ?? "";
      assert.match(summary, /SUMMARY-THREE/);
      // A research worker reads it with its own file tools, by its path in the research folder.
      assert.match(summary, /read_file \(path compactions\/t-1\.md\)/);
      assert.ok(pairsWhole(after));
      assert.equal(k.reports[0]?.how, "summary");
    } finally {
      await fake.close();
    }
  });
});
