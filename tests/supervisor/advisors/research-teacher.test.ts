import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { parseContract } from "../../../src/core/contract.ts";
import { MEASURES_NOTHING } from "../../../src/core/research-check.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import {
  AdvisorsConfig,
  ResearchOpportunity,
  researchOpportunityExperiment,
  teacherRound,
} from "../../../src/supervisor/advisors/index.ts";
import {
  type AdviseConfig,
  adviseOnce,
  emptyAdviseState,
} from "../../../src/supervisor/advisors/pass/index.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { researchFixture } from "../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/**
 * Goal 117: a research run's teachers get a research prompt and schema. Each task names the
 * question it serves, one evidence gap, the kind of source to read, a title, details and why, and
 * no gain, control or measured experiment; it is queued with its question, and the harness refuses
 * one that asks for a measurement or names no question. A hill climb's teachers keep theirs.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const answer = (args: unknown) => ({ toolCalls: [{ name: "answer", args }] });

function runtime(url: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
  writeFileSync(join(dir, "key"), "test-key\n");
  return { name, runtime: "openai", base_url: url, model: name, api_key_file: join(dir, "key") };
}

/** A research task with every part. */
const task = (question: number, title: string, more: Record<string, unknown> = {}) => ({
  question,
  gap: "the vendor's documentation of the bank layout",
  source_kind: "the vendor's programming guide",
  title,
  details: "Start at the chapter on shared memory.",
  why: "the card names this gap, and no task closes it yet",
  citations: ["cards/q1.md"],
  kind: "primary",
  ...more,
});

async function researchRun() {
  const env = makeHarnessEnv("rig-r");
  const parsed = parseContract({
    ...researchFixture,
    questions: ["Which memory spaces exist?", "How are shared memory banks laid out?"],
  });
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
  return env;
}

function config(
  env: ReturnType<typeof makeHarnessEnv>,
  advisors: AdvisorsConfig,
  lines: string[],
): AdviseConfig {
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

describe("a research run's teachers (goal 117)", () => {
  test("the research prompt and schema; tasks queued with their question and gap; a measurement refused; a bad question left out", async (t: TestContext) => {
    const env = await researchRun();
    const seen: { system: string; schema: string; user: string }[] = [];
    const fake = await startFakeModel(({ messages, tools }) => {
      const system = JSON.stringify(messages.find((m) => m.role === "system")?.content ?? "");
      seen.push({
        system,
        schema: JSON.stringify(tools.find((x) => x.function.name === "answer")),
        user: JSON.stringify(messages.find((m) => m.role === "user")?.content ?? ""),
      });
      return answer({
        summary: "the second question lacks primary sources",
        portfolio: [
          task(1, "Bank layout in the guide"),
          task(0, "Kernel timing", { gap: "Time each kernel on the card", kind: undefined }),
          { question: -1, gap: "g", source_kind: "s", title: "Bad index", why: "w" },
          task(0, "Question 1 (index 0): the vendor's memory overview", { kind: "survey" }),
        ],
      });
    });
    t.after(() => fake.close());
    const lines: string[] = [];
    const cfg = config(
      env,
      AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-a")] }),
      lines,
    );
    await adviseOnce(cfg, emptyAdviseState());
    const teacher = seen[0];
    assert.ok(teacher, "the teacher reviewed the run");
    assert.match(teacher.system, /You review an automated research run that reads sources/);
    assert.ok(teacher.system.includes(MEASURES_NOTHING.slice(0, 80)));
    assert.match(
      teacher.system,
      /none for a\\n?\s?question the review panel decided or one that is saturated/,
    );
    assert.doesNotMatch(teacher.system, /gain_bound|matched control/);
    for (const part of ["question", "gap", "source_kind", "title", "details", "why", "citations"])
      assert.ok(teacher.schema.includes(`"${part}"`), part);
    for (const part of ["gain_bound", "mechanism", "control", "new_because"])
      assert.ok(!teacher.schema.includes(`"${part}"`), part);
    // Its brief says where each question stands for the plan.
    assert.match(teacher.user, /question_state/);
    // Queued with its question, its title labelled, its gap first in its details.
    const queued = env.service.queue.queued("r-1");
    assert.deepEqual(
      queued.map((x) => [x.title, x.question, x.family, x.added_by]),
      [
        ["Question 2 (index 1): Bank layout in the guide", 1, "primary", "teacher"],
        ["Question 1 (index 0): the vendor's memory overview", 0, "", "teacher"],
      ],
    );
    assert.equal(
      queued[0]?.details,
      [
        "Evidence gap to close: the vendor's documentation of the bank layout",
        "What to read: the vendor's programming guide",
        "Start at the chapter on shared memory.",
        "Evidence: cards/q1.md",
      ].join("\n"),
    );
    assert.equal(queued[0]?.why, "the card names this gap, and no task closes it yet");
    // The measurement was refused by the rig, in words; the task with no question was left out.
    assert.match(
      lines.join("\n"),
      /refused: add "Question 1 \(index 0\): Kernel timing": this asks for a measurement \("Time each"\)/,
    );
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = join(cfg.home, "advisors");
    const rec = readFileSync(
      join(dir, readdirSync(dir).find((f) => f.includes("teachers-r-1")) as string),
      "utf8",
    );
    assert.match(rec, /teacher-a's opportunity 3 \(\\"Bad index\\"\): question: /);
  });

  test("two teachers and a merged by model: the research merge, and no distinct task dropped", async (t: TestContext) => {
    const systems: string[] = [];
    const fake = await startFakeModel(({ messages }) => {
      const system = JSON.stringify(messages.find((m) => m.role === "system")?.content ?? "");
      systems.push(system);
      if (system.includes("You merge the advice of two teachers"))
        return answer({
          portfolio: [{ ...task(1, "Bank layout in the guide"), from: ["teacher-a#1"] }],
        });
      return answer({
        summary: "s",
        portfolio: [task(1, "Bank layout in the guide"), task(0, "Memory spaces in the manual")],
      });
    });
    t.after(() => fake.close());
    const run = await teacherRound({
      config: AdvisorsConfig.parse({
        teachers: [runtime(fake.url, "teacher-a"), runtime(fake.url, "teacher-b")],
        merged_by: runtime(fake.url, "merged-by"),
      }),
      run: "r",
      brief: { run: "r", mode: "research" },
      tools: {},
      research: true,
    });
    assert.ok(
      systems.some((x) => x.includes("reviewed an automated research run that reads sources")),
    );
    assert.deepEqual(
      run.experiments.map((x) => [x.title, x.question]),
      [
        ["Question 2 (index 1): Bank layout in the guide", 1],
        ["Question 1 (index 0): Memory spaces in the manual", 0],
      ],
    );
    assert.match(run.kept.join(" "), /the merged by model left out teacher-a#2/);
  });

  test("a research task is one queue task, cut to the queue's limits; a bad kind is dropped, not the task", () => {
    const o = ResearchOpportunity.parse(
      task(3, "t".repeat(300), { details: "d".repeat(5000), kind: "survey", citations: "x" }),
    );
    assert.equal(o.title.length, 200);
    assert.equal(o.kind, undefined);
    assert.deepEqual(o.citations, []);
    const x = researchOpportunityExperiment(o);
    assert.ok(x.title.length <= 200);
    assert.ok((x.details ?? "").length <= 4000);
    assert.match(x.title, /^Question 4 \(index 3\): t+/);
    assert.equal(x.family, undefined);
    assert.equal(x.question, 3);
  });
});
