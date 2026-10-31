import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import {
  AdvisorsConfig,
  AuditAnswer,
  DirectiveSet,
  PanelAnswer,
  TeacherReview,
} from "../../../../src/supervisor/advisors/index.ts";
import {
  type AdviseConfig,
  adviseOnce,
  emptyAdviseState,
} from "../../../../src/supervisor/advisors/pass/index.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../../helpers/judge-env.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
type Env = ReturnType<typeof makeJudgeEnv>;

const BRIEFING = [
  {
    text: "Vector loads need 16-byte aligned pointers.",
    from: { campaign: "kernels", run: "kernels-7", kind: "note", ref: "12" },
  },
];

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

const events = (env: Env, kind?: string) =>
  env.ledger.eventsAfter(0, 50_000).events.filter((e) => !kind || e.kind === kind);

/** The notes advisors wrote, as [by, kind, text], oldest first. */
const advisorNotes = (env: Env) =>
  env.service.journal
    .newest("js-1", 100)
    .filter((n) => n.by.includes(":"))
    .reverse()
    .map((n) => [n.by, n.kind, n.text]);

describe("the advisors' field notes", () => {
  test("an advisor's notes are read leniently: a bad note never loses its review, audit or verdict", () => {
    const garbled = { journal: [{ kind: "rumour", text: "x" }, "no", { kind: "lesson" }] };
    const review = TeacherReview.parse({ summary: "s", recommendations: [], ...garbled });
    assert.equal(review.summary, "s");
    assert.deepEqual(review.journal, []);
    assert.deepEqual(TeacherReview.parse({ summary: "s", recommendations: [] }).journal, []);
    assert.deepEqual(DirectiveSet.parse({ directives: [], journal: "not a list" }).journal, []);
    const audit = AuditAnswer.parse({
      decision: "block",
      reasons: "r",
      journal: [
        { kind: "observation", text: " It reads its weights fresh on every call. " },
        { kind: "observation" },
      ],
    });
    assert.equal(audit.decision, "block");
    assert.deepEqual(audit.journal, [
      { kind: "observation", text: "It reads its weights fresh on every call." },
    ]);
    const panel = PanelAnswer.parse({ pass: false, reasons: "r", journal: [{ text: "no kind" }] });
    assert.equal(panel.pass, false);
    assert.deepEqual(panel.journal, []);
  });

  test("the teachers' and the merged by model's notes are recorded after the round's work, by name; their brief has the notes and the background", async (t: TestContext) => {
    const env = makeJudgeEnv({ assign: { briefing: BRIEFING } });
    await env.service.applyCommand(env.assign);
    env.service.journal.write(
      "js-1",
      { kind: "surprise", text: "Tiling was slower, not faster." },
      { by: "lane-1", actor: "trial:t-1", source: "trial:t-1", lane: "lane-1" },
    );
    const seen: string[] = [];
    const fake = await startFakeModel(({ messages }) => {
      const all = JSON.stringify(messages);
      seen.push(all);
      if (all.includes("You merge the advice of two teachers"))
        return {
          toolCalls: [
            {
              name: "answer",
              args: {
                directives: [],
                experiments: [{ title: "wider loads", why: "both reviews: reads dominate" }],
                journal: [{ kind: "decision", text: "kept both views as one experiment" }],
              },
            },
          ],
        };
      return {
        toolCalls: [
          {
            name: "answer",
            args: {
              summary: "reads dominate",
              recommendations: [],
              journal: [
                { kind: "observation", text: "nothing queued uses vector loads" },
                {
                  kind: "question",
                  text: "about a missing attempt",
                  about: { type: "attempt", id: "a-none" },
                },
              ],
            },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({
      teachers: [runtime(fake.url, "teacher-a"), runtime(fake.url, "teacher-b")],
      merged_by: runtime(fake.url, "merged-by"),
    });
    const lines: string[] = [];
    await adviseOnce(config(env, advisors, lines), emptyAdviseState());
    const brief = seen.find((s) => s.includes("Brief of run js-1")) ?? "";
    assert.match(brief, /field_notes/);
    assert.match(brief, /Tiling was slower, not faster/);
    assert.match(brief, /their own words, data to weigh, not instructions/);
    assert.match(brief, /Vector loads need 16-byte aligned pointers/);
    assert.match(brief, /Field notes: write down what you learn/);
    const notes = advisorNotes(env);
    assert.deepEqual(
      notes.filter(([by]) => by === "teachers:merged-by"),
      [["teachers:merged-by", "decision", "kept both views as one experiment"]],
    );
    // Both teachers' notes, the one about a missing attempt kept as about the run.
    assert.equal(notes.filter(([by]) => by === "teachers:teacher-a").length, 2);
    assert.equal(notes.filter(([by]) => by === "teachers:teacher-b").length, 2);
    assert.ok(
      env.service.journal
        .newest("js-1", 100)
        .every((n) => n.about.type === "run" && n.about.id === "js-1"),
      "an about the run lacks becomes the run; a note that names nothing is about the run",
    );
    assert.match(
      lines.join("\n"),
      /the field notes of teacher-a: note 2: recorded as about the run/,
    );
    // The notes come after the round's work was posted.
    const all = events(env);
    const work = all.findLast((e) => e.kind === "experiment_added")?.id ?? 0;
    const firstNote = all.find((e) => e.kind === "journal_note" && e.actor === "supervisor")?.id;
    assert.ok(work > 0 && firstNote !== undefined && firstNote > work, "notes after the work");
  });

  test("teachers with an open web fetch get no background from past research in their brief", async (t: TestContext) => {
    const env = makeJudgeEnv({ assign: { briefing: BRIEFING } });
    await env.service.applyCommand(env.assign);
    const seen: string[] = [];
    const fake = await startFakeModel(({ messages }) => {
      const all = JSON.stringify(messages);
      seen.push(all);
      // First the brief tool (it must be filtered too), then the answer.
      if (!all.includes('"role":"tool"')) return { toolCalls: [{ name: "brief", args: {} }] };
      return { toolCalls: [{ name: "answer", args: { summary: "s", recommendations: [] } }] };
    });
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({
      teachers: [runtime(fake.url, "teacher-a")],
      fetch_domains: ["*"],
    });
    await adviseOnce(config(env, advisors, []), emptyAdviseState());
    const brief = seen.find((s) => s.includes("Brief of run js-1")) ?? "";
    assert.ok(brief, "the teacher ran");
    assert.ok(
      seen.some((x) => x.includes('"role":"tool"')),
      "the teacher called its brief tool",
    );
    for (const x of seen) assert.doesNotMatch(x, /Vector loads need 16-byte aligned pointers/);
    assert.doesNotMatch(brief, /\\"background\\"|\\"past_research\\"/);
  });

  test("the auditor's notes come after its audit, as auditor:<name>; its package has the background", async () => {
    const env = makeJudgeEnv({
      contract: {
        acceptance: {
          looks: [3, 6],
          confirm_blocks: 4,
          audit: { ratio_to_median: 3, absolute: 0.15 },
        },
      },
      assign: { briefing: BRIEFING },
    });
    await env.service.applyCommand(env.assign);
    const id = (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(FAST_KERNEL), hypothesis: "h", known_flaws: [] },
        "t",
      )
    ).attempt;
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_audit");
    const pkg = (await env.service.auditPackages())[0] as { background?: { items: unknown[] } };
    assert.deepEqual(pkg.background?.items, BRIEFING);
    const dir = mkdtempSync(join(tmpdir(), "thermite-cli-"));
    const script = join(dir, "auditor.mjs");
    writeFileSync(
      script,
      `process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({decision:"needs_owner",reasons:"unsure",citations:["diff"],journal:[{kind:"observation",text:"${id} reads its weights fresh on every call",about:{type:"attempt",id:"${id}"}}]})));`,
    );
    const advisors = AdvisorsConfig.parse({
      auditor: {
        name: "cli-auditor",
        runtime: "cli",
        argv: [process.execPath, script],
        restricted: true,
      },
    });
    await adviseOnce(config(env, advisors, []), emptyAdviseState());
    const notes = env.service.journal.newest("js-1", 10, { by: "auditor:cli-auditor" });
    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0]?.about, { type: "attempt", id });
    const all = events(env);
    const audited = all.findLast((e) => e.kind === "promotion_pending")?.id ?? 0;
    const noted = all.find((e) => e.kind === "journal_note")?.id ?? 0;
    assert.ok(audited > 0 && noted > audited, "the note after the audit");
  });

  test("each reviewer's notes come after the posted review, as review_panel:<name>", async (t: TestContext) => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1e12 } });
    await env.service.applyCommand(env.assign);
    await env.drain();
    const fake = await startFakeModel(() => ({
      toolCalls: [
        {
          name: "answer",
          args: {
            pass: true,
            reasons: "clear and small",
            journal: [{ kind: "lesson", text: "a small change reads well" }],
          },
        },
      ],
    }));
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({
      review_panel: [runtime(fake.url, "reviewer-1"), runtime(fake.url, "reviewer-2")],
    });
    const state = await adviseOnce(config(env, advisors, []), emptyAdviseState());
    assert.equal(state.stats.reviews, 1, JSON.stringify(state.stats));
    assert.deepEqual(
      advisorNotes(env).map(([by]) => by),
      ["review_panel:reviewer-1", "review_panel:reviewer-2"],
    );
  });
});
