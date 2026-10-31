import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseContract } from "../../../../src/core/contract.ts";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import {
  AdvisorsConfig,
  Opportunity,
  opportunityExperiment,
  teacherRound,
} from "../../../../src/supervisor/advisors/index.ts";
import {
  type AdviseConfig,
  adviseOnce,
  emptyAdviseState,
  teachersCalled,
} from "../../../../src/supervisor/advisors/pass/index.ts";
import { serveAdvisorTools } from "../../../../src/supervisor/advisors/tools/mcp.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { researchFixture } from "../../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../../helpers/harness-env.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../../helpers/judge-env.ts";

/**
 * Goal 081: the teachers put ideas first. Their main product is a portfolio of opportunities,
 * written to the run's queue as experiments; two teachers' portfolios merge without dropping a
 * distinct idea; rules come second, and code refuses one that freezes the queue's size or pins
 * an experiment; the teachers read the run's code and evidence; and a queue below its target
 * starts their round at once.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
type Env = ReturnType<typeof makeJudgeEnv>;

function config(env: Env, advisors: AdvisorsConfig, lines: string[]): AdviseConfig {
  const api = createHarnessApi(env.service, tokens);
  return {
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
    advisors,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
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

const events = (env: Env, kind: string) =>
  env.ledger.eventsAfter(0, 5000).events.filter((e) => e.kind === kind);

/** An opportunity with every part, and its citations. */
const opp = (title: string, more: Record<string, unknown> = {}) => ({
  title,
  family: "memory",
  mechanism: `${title}: reads dominate the profile`,
  gain_bound: "up to 10% on the big cell",
  experiment: `${title} on the inner loop only`,
  control: "the champion, measured in the same blocks",
  stop: "no gain above noise after two tries",
  new_because: "the last round had no memory idea",
  citations: ["a-1"],
  ...more,
});

const answer = (args: unknown) => ({ toolCalls: [{ name: "answer", args }] });

describe("the teachers put ideas first (goal 081)", () => {
  test("the prompts: a portfolio first with no count, rules second, never a frozen queue", async (t: TestContext) => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const seen: { system: string; tools: string[]; schema: string }[] = [];
    const fake = await startFakeModel(({ messages, tools }) => {
      const system = JSON.stringify(messages.find((m) => m.role === "system")?.content ?? "");
      seen.push({
        system,
        tools: tools.map((x) => x.function.name),
        schema: JSON.stringify(tools.find((x) => x.function.name === "answer")),
      });
      return system.includes("You merge the advice")
        ? answer({ portfolio: [] })
        : answer({ summary: "s", portfolio: [] });
    });
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({
      teachers: [runtime(fake.url, "teacher-a"), runtime(fake.url, "teacher-b")],
      merged_by: runtime(fake.url, "merged-by"),
    });
    await adviseOnce(config(env, advisors, []), emptyAdviseState());
    const teacher = seen.find((s) => s.system.includes("You review an automated research"));
    assert.ok(teacher);
    assert.match(
      teacher.system,
      /Your main product each round is a portfolio of\\nnew opportunities/,
    );
    assert.match(teacher.system, /as many as are distinct and evidenced, with no\\nfixed count/);
    assert.match(
      teacher.system,
      /Rules come second\. Recommend a rule only when new evidence calls for one/,
    );
    assert.match(
      teacher.system,
      /A rule may never freeze the queue's size \(\\"do not add queue entries\\"/,
    );
    assert.match(teacher.system, /The target drives ideas; it is not a cap/);
    // Its answer's shape: each opportunity's parts, and rules optional.
    for (const part of [
      "mechanism",
      "gain_bound",
      "experiment",
      "control",
      "stop",
      "new_because",
      "citations",
    ])
      assert.ok(teacher.schema.includes(`"${part}"`), part);
    // The teachers read the code and the evidence; the merged by model has no tools.
    assert.deepEqual(teacher.tools.filter((x) => x !== "answer").sort(), [
      "brief",
      "list_files",
      "read_diff",
      "read_evidence",
      "read_file",
    ]);
    const merged = seen.find((s) => s.system.includes("You merge the advice"));
    assert.ok(merged);
    assert.match(merged.system, /drop no distinct idea/);
    assert.match(
      merged.system,
      /Code adds back any\\nteacher's opportunity that no merged one holds/,
    );
    assert.deepEqual(merged.tools, ["answer"]);
  });

  test("a teacher's portfolio becomes experiments in the queue; one without evidence is left out, with why", async (t: TestContext) => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const fake = await startFakeModel(() =>
      answer({
        summary: "the loads",
        portfolio: [
          opp("Wider loads"),
          opp("Prefetch the next block", { family: "prefetch" }),
          opp("Unproven idea", { citations: [] }),
        ],
      }),
    );
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-a")] });
    const lines: string[] = [];
    const cfg = config(env, advisors, lines);
    await adviseOnce(cfg, emptyAdviseState());
    const queued = env.service.queue.queued("js-1");
    assert.deepEqual(
      queued.map((x) => [x.title, x.added_by, x.family]),
      [
        ["Wider loads", "teacher", "memory"],
        ["Prefetch the next block", "teacher", "prefetch"],
      ],
    );
    assert.equal(
      queued[0]?.details,
      [
        "Mechanism: Wider loads: reads dominate the profile",
        "Expected gain, at most: up to 10% on the big cell",
        "Smallest discriminating experiment: Wider loads on the inner loop only",
        "Matched control: the champion, measured in the same blocks",
        "Stop when: no gain above noise after two tries",
        "Evidence: a-1",
      ].join("\n"),
    );
    assert.equal(
      queued[0]?.why,
      "New since the teachers' last round: the last round had no memory idea",
    );
    assert.equal(events(env, "experiment_added").at(-1)?.actor, "supervisor:teacher");
    assert.match(
      lines.join("\n"),
      /js-1 text: the teachers added to the queue: Wider loads; Prefetch the next block/,
    );
    // The supervisor's record of the round says why the third was left out.
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = join(cfg.home, "advisors");
    const rec = readFileSync(
      join(dir, readdirSync(dir).find((f) => f.includes("teachers-js-1")) as string),
      "utf8",
    );
    assert.match(rec, /teacher-a's opportunity 3 \(\\"Unproven idea\\"\): citations: /);
    // The next round sees them as the teachers' earlier ideas; a repeat is refused, in words.
    const brief = (await (
      await createHarnessApi(env.service, tokens).request("/v1/brief?run=js-1", {
        headers: { authorization: `Bearer ${tokens.supervisor}` },
      })
    ).json()) as { teacher_ideas: { title: string; state: string }[] };
    assert.deepEqual(
      brief.teacher_ideas.map((x) => [x.title, x.state]),
      [
        ["Prefetch the next block", "queued"],
        ["Wider loads", "queued"],
      ],
    );
    lines.length = 0;
    await adviseOnce(cfg, emptyAdviseState());
    assert.equal(env.service.queue.queued("js-1").length, 2, "no repeats");
    assert.match(
      lines.join("\n"),
      /refused: add "Wider loads": it repeats x-[0-9a-f]{12} \(up next\); add "Prefetch the next block": it repeats x-/,
    );
  });

  test("an opportunity is one experiment with all its parts, cut to the queue's limits", () => {
    const x = opportunityExperiment(
      opp("Long", { mechanism: "m".repeat(2000), experiment: "e".repeat(2000) }),
    );
    assert.ok((x.details ?? "").length <= 4000);
    assert.match(x.details ?? "", /^Mechanism: m+/);
    assert.equal(x.family, "memory");
  });

  test("a part longer than its limit is cut, not refused: the opportunity is kept", () => {
    const o = Opportunity.parse(
      opp("Reuse", { gain_bound: "g".repeat(400), citations: ["c".repeat(600)] }),
    );
    assert.equal(o.gain_bound.length, 300);
    assert.equal(o.citations[0]?.length, 500);
    assert.equal(o.title, "Reuse");
  });

  test("the merged by model drops no distinct idea: code adds back what it left out", async (t: TestContext) => {
    const a = await startFakeModel(() =>
      answer({ summary: "a", portfolio: [opp("Wider loads"), opp("Fuse the two loops")] }),
    );
    const b = await startFakeModel(() =>
      answer({ summary: "b", portfolio: [opp("wider loads!"), opp("Use a lookup table")] }),
    );
    let reviews = "";
    const m = await startFakeModel(({ messages }) => {
      reviews = JSON.stringify(messages);
      // It merges the two "wider loads" and keeps the table, and forgets "Fuse the two loops".
      return answer({
        portfolio: [
          opp("Wider loads", { from: ["teacher-a#1", "teacher-b#1"] }),
          opp("Use a lookup table", { from: ["teacher-b#2"] }),
        ],
      });
    });
    t.after(async () => {
      await a.close();
      await b.close();
      await m.close();
    });
    const two = await teacherRound({
      config: AdvisorsConfig.parse({
        teachers: [runtime(a.url, "teacher-a"), runtime(b.url, "teacher-b")],
        merged_by: runtime(m.url, "merged-by"),
      }),
      run: "r",
      brief: { run: "r" },
      tools: {},
    });
    // The merged by model saw each teacher's opportunities with their ids.
    assert.match(reviews, /teacher-a#2/);
    assert.match(reviews, /teacher-b#2/);
    assert.deepEqual(
      two.portfolio.map((o) => o.title),
      ["Wider loads", "Use a lookup table", "Fuse the two loops"],
    );
    assert.deepEqual(two.kept, [
      "the merged by model left out teacher-a#2: kept, since distinct ideas are never dropped",
    ]);
    assert.deepEqual(
      two.experiments.map((x) => x.title),
      ["Wider loads", "Use a lookup table", "Fuse the two loops"],
    );
    // Without a merged by model, every teacher's distinct ideas are kept; repeats once.
    const none = await teacherRound({
      config: AdvisorsConfig.parse({
        teachers: [runtime(a.url, "teacher-a"), runtime(b.url, "teacher-b")],
      }),
      run: "r",
      brief: { run: "r" },
      tools: {},
    });
    assert.deepEqual(
      none.portfolio.map((o) => o.title),
      ["Wider loads", "Fuse the two loops", "Use a lookup table"],
    );
  });

  test("rules that freeze the queue or pin an experiment are refused, by the supervisor and the rig", async (t: TestContext) => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const fake = await startFakeModel(() =>
      answer({
        summary: "s",
        recommendations: [
          {
            kind: "note",
            value: "Do not add queue entries",
            rationale: "steady",
            citations: ["a-1"],
          },
          {
            kind: "priority",
            value: "x-0123456789ab",
            rationale: "keep the retried one first",
            citations: ["a-2"],
          },
          { kind: "avoid", family: "loop tiling", rationale: "null twice", citations: ["a-3"] },
        ],
      }),
    );
    t.after(() => fake.close());
    const lines: string[] = [];
    await adviseOnce(
      config(env, AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-a")] }), lines),
      emptyAdviseState(),
    );
    // Only the avoid rule reached the rig; the supervisor said why it dropped the others.
    const rules = env.ledger.directives.active("js-1").map((d) => d.body as { kind: string });
    assert.deepEqual(
      rules.map((r) => r.kind),
      ["avoid"],
    );
    const said = lines.join("\n");
    assert.match(
      said,
      /Dropped: note: a rule may not freeze the queue's size \("Do not add queue entries"\)/,
    );
    assert.match(said, /priority: a rule may not pin an experiment \(x-0123456789ab\)/);
    // The rig refuses them too, on its own: left out, each with why, and recorded.
    const api = createHarnessApi(env.service, tokens);
    const r = await api.request("/v1/directives", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.supervisor}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        run: "js-1",
        directives: [
          { kind: "note", value: "keep the queue unchanged", rationale: "r", citations: ["a-1"] },
          { kind: "try", family: "memory", rationale: "r", citations: ["a-1"] },
        ],
      }),
    });
    assert.equal(r.status, 200);
    const out = (await r.json()) as { ids: number[]; left_out: { rule: string; why: string }[] };
    assert.equal(out.ids.length, 1);
    assert.equal(out.left_out[0]?.rule, 'note "keep the queue unchanged"');
    assert.match(out.left_out[0]?.why ?? "", /a rule may not freeze the queue's size/);
    const left = events(env, "directives_left_out").at(-1);
    assert.equal((left?.body as { reason?: string } | undefined)?.reason, "freezes_queue");
  });

  test("the teachers read the champion's code, a diff and the judge's findings through their tools", async (t: TestContext) => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const attempt = (
      await env.service.submitAttempt(
        {
          run: "js-1",
          patch_base64: env.patch(FAST_KERNEL),
          hypothesis: "no wait",
          known_flaws: [],
        },
        "test",
      )
    ).attempt;
    await env.drain();
    const results: string[] = [];
    const fake = await startFakeModel(({ messages }) => {
      const done = messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      results.splice(0, results.length, ...done);
      if (done.length === 0) return { toolCalls: [{ name: "list_files", args: { path: "src" } }] };
      if (done.length === 1)
        return { toolCalls: [{ name: "read_file", args: { path: "src/kernel/work.mjs" } }] };
      if (done.length === 2) return { toolCalls: [{ name: "read_diff", args: { attempt } }] };
      if (done.length === 3) return { toolCalls: [{ name: "read_evidence", args: { attempt } }] };
      return answer({ summary: "read", portfolio: [] });
    });
    t.after(() => fake.close());
    await adviseOnce(
      config(env, AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-a")] }), []),
      emptyAdviseState(),
    );
    assert.match(results[0] ?? "", /src\/kernel\/work\.mjs \(\d+ bytes\)/);
    assert.match(results[1] ?? "", /1\\texport function work\(n\)/);
    assert.match(results[2] ?? "", /- {2}Atomics\.wait/);
    assert.match(results[3] ?? "", /"hypothesis":"no wait"/);

    // Teachers that may fetch any web page read no code: said once in the run's live view.
    const open = await startFakeModel(({ tools }) => {
      assert.ok(!tools.some((x) => x.function.name === "read_file"));
      return answer({ summary: "s", portfolio: [] });
    });
    t.after(() => open.close());
    const lines: string[] = [];
    const cfg = config(
      env,
      AdvisorsConfig.parse({
        teachers: [runtime(open.url, "teacher-a")],
        fetch_domains: ["*"],
      }),
      lines,
    );
    let state = await adviseOnce(cfg, emptyAdviseState());
    state = await adviseOnce(cfg, { ...state, lastTeacherAt: {} });
    assert.equal(
      lines.filter((l) => l.includes("so they read no code, diffs or the judge's full findings"))
        .length,
      1,
    );
  });

  test("a research run's teachers get no code tools: it has no repository for Git to read", async (t: TestContext) => {
    const env = makeHarnessEnv("rig-r");
    const parsed = parseContract(researchFixture);
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
    const offered: string[][] = [];
    const results: string[] = [];
    // A teacher that reads the code whenever it is offered the tool, as goal 081 asks.
    const fake = await startFakeModel(({ messages, tools }) => {
      const names = tools.map((x) => x.function.name);
      offered.push(names);
      const done = messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      results.push(...done);
      if (names.includes("list_files") && done.length === 0)
        return { toolCalls: [{ name: "list_files", args: {} }] };
      return answer({ summary: "read", portfolio: [] });
    });
    t.after(() => fake.close());
    const asked: string[] = [];
    const cfg = config(
      env as unknown as Env,
      AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-a")] }),
      [],
    );
    const inner = cfg.fetchImpl as typeof fetch;
    cfg.fetchImpl = async (input, init) => {
      asked.push(new URL(String(input)).pathname);
      return inner(input, init);
    };
    await adviseOnce(cfg, emptyAdviseState());
    assert.ok(offered.length > 0, "the teachers reviewed the run");
    for (const names of offered)
      for (const code of ["list_files", "read_file", "read_diff", "read_evidence"])
        assert.ok(!names.includes(code), `${code} offered: ${names.join(", ")}`);
    assert.ok(!asked.some((p) => p.startsWith("/v1/code/")), asked.join(", "));
    assert.ok(!results.some((r) => /spawn|ENOENT/.test(r)), results.join("\n"));
  });

  test("in Claude Code, OpenCode and Codex the code tools are served on localhost, read only", async () => {
    const asked: string[] = [];
    const server = await serveAdvisorTools({
      code: {
        listFiles: async (p) => {
          asked.push(`list ${p}`);
          return { files: ["src/a.c (10 bytes)"] };
        },
        readFile: async (p, o, l) => {
          asked.push(`read ${p} ${o} ${l}`);
          return { content: "1\tint main;" };
        },
        readDiff: async (a, o) => {
          asked.push(`diff ${a} ${o}`);
          return { diff: "+x" };
        },
        evidence: async (a) => {
          asked.push(`evidence ${a}`);
          return { attempts: [] };
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
        "mcp__thermite__list_files",
        "mcp__thermite__read_file",
        "mcp__thermite__read_diff",
        "mcp__thermite__read_evidence",
      ]);
      const client = new Client({ name: "test", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: entry.headers },
        }),
      );
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((x) => [x.name, x.annotations?.readOnlyHint]).sort(), [
        ["list_files", true],
        ["read_diff", true],
        ["read_evidence", true],
        ["read_file", true],
      ]);
      const r = await client.callTool({
        name: "read_file",
        arguments: { path: "src/a.c", offset: 2, limit: 5 },
      });
      await client.callTool({ name: "read_diff", arguments: { attempt: "a-1" } });
      await client.callTool({ name: "read_evidence", arguments: {} });
      await client.callTool({ name: "list_files", arguments: {} });
      await client.close();
      assert.match(JSON.stringify(r.content), /int main/);
      assert.deepEqual(asked, [
        "read src/a.c 2 5",
        "diff a-1 undefined",
        "evidence undefined",
        "list ",
      ]);
    } finally {
      await server.close();
    }
  });

  test("a queue below its target starts the teachers' round at once, once for each low round", async (t: TestContext) => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    let briefs = 0;
    let head = "";
    const fake = await startFakeModel(({ messages }) => {
      briefs++;
      head = JSON.stringify(messages.find((m) => m.role === "user")?.content ?? "").slice(0, 300);
      return answer({ summary: "s", portfolio: [opp("Wider loads")] });
    });
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-a")] });
    const lines: string[] = [];
    const cfg = config(env, advisors, lines);
    // A round just ran: the clock says wait an hour.
    const waiting = { ...emptyAdviseState(), lastTeacherAt: { "js-1": new Date().toISOString() } };
    assert.equal(await teachersCalled(cfg, waiting), false);
    let state = await adviseOnce(cfg, waiting);
    assert.equal(briefs, 0, "on the clock: no round yet");
    // The planner's round left the queue below its target.
    env.ledger.appendEvent("planner", "queue_low", "js-1", {
      round: 3,
      ready: 0,
      target: 4,
      lanes: 2,
      source: "planner",
    });
    assert.equal(await teachersCalled(cfg, state), true);
    state = await adviseOnce(cfg, state);
    assert.equal(briefs, 1);
    assert.match(
      lines.join("\n"),
      /js-1 status: the teachers review js-1 now: its queue has 0 of its target of 4 experiments ready: ideas are wanted now/,
    );
    assert.match(head, /Brief of run js-1 \(its queue has 0 of its target of 4 experiments ready/);
    // One low round starts one teacher round.
    assert.equal(await teachersCalled(cfg, state), false);
    state = await adviseOnce(cfg, state);
    assert.equal(briefs, 1);
    // A new low round starts another; a queue at its target starts none.
    env.ledger.appendEvent("planner", "queue_low", "js-1", {
      round: 4,
      ready: 1,
      target: 4,
      lanes: 2,
      source: "planner",
    });
    assert.equal(await teachersCalled(cfg, state), true);
    for (const title of ["b", "c", "d"]) env.service.queue.add("js-1", { title, by: "owner" }, "o");
    assert.equal(env.service.queueLow("js-1"), null, "4 of 4 ready");
    assert.equal(await teachersCalled(cfg, state), false);
  });

  test("the planner's round and the teachers count ready ideas alike: none an AVOID rule names, none handed out", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const run = "js-1";
    const { target } = env.service.queueState(run);
    assert.ok(target >= 2, String(target));
    const add = (title: string, family?: string) =>
      env.service.queue.add(run, { title, ...(family ? { family } : {}), by: "owner" }, "o");
    // Enough queued to meet the target, but two are in a direction an AVOID rule names, and one
    // was handed out to a lane in the newest round: neither is a ready idea.
    const plain = Array.from({ length: target }, (_, i) => add(`plain ${i}`));
    add("tile by 32", "tiling");
    add("tile by 64", "tiling");
    env.ledger.directives.addSet(
      run,
      "supervisor",
      [{ kind: "avoid", family: "tiling", rationale: "null twice", citations: ["a-1"] }],
      true,
    );
    env.ledger.appendEvent("planner", "planner_handout", run, {
      round: 1,
      assignments: [{ lane: "lane-1", experiment: String(plain[0]?.id), why: "first" }],
      notes: "n",
    });
    assert.equal(env.service.queueState(run).ready, target - 1);
    env.ledger.appendEvent("planner", "queue_low", run, {
      round: 1,
      ready: target - 1,
      target,
      lanes: 2,
      source: "planner",
    });
    assert.equal(env.service.queueLow(run)?.ready, target - 1, "still below its target");
    const brief = env.service.brief(run) as { queue_target: { ready: number; below: boolean } };
    assert.deepEqual(
      { ready: brief.queue_target.ready, below: brief.queue_target.below },
      { ready: target - 1, below: true },
    );
    // One more plain idea meets it.
    add("plain more");
    assert.equal(env.service.queueLow(run), null);
  });
});
