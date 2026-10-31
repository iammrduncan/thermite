import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import { cardOf } from "../../../../src/harness/research/cards.ts";
import type { HarnessService } from "../../../../src/harness/service/index.ts";
import {
  type AdvisorRuntime,
  AdvisorsConfig,
  type RunningAdvisors,
} from "../../../../src/supervisor/advisors/index.ts";
import {
  type AdviseConfig,
  adviseOnce,
  emptyAdviseState,
} from "../../../../src/supervisor/advisors/pass/index.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import {
  cardsUpToDate,
  SIX_QUESTIONS,
  SIX_RUBRICS,
  seedClaims,
  seedSources,
} from "../../../helpers/research-cards.ts";
import { answeredResearchRun, goodPaper } from "../../../helpers/research-paper.ts";
import { makeResearchRun } from "../../../helpers/research-run.ts";

/**
 * The synthesizer and the final writer on models of their own (goal 166): each runs on its own
 * model when control gives it one, in place of the first teacher's, with no teacher at all too,
 * and its calls are recorded under its own name.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const RUN = "r-1";

function config(service: HarnessService, advisors: RunningAdvisors, live: string[]): AdviseConfig {
  const api = createHarnessApi(service, tokens);
  return {
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
    advisors,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      return api.request(`${url.pathname}${url.search}`, init as RequestInit);
    },
    live: (l) => live.push(l.text),
  };
}

function runtime(url: string, name: string): AdvisorRuntime {
  const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
  writeFileSync(join(dir, "key"), "test-key\n");
  return AdvisorsConfig.parse({
    auditor: {
      name,
      runtime: "openai",
      base_url: url,
      model: name,
      api_key_file: join(dir, "key"),
    },
  }).auditor as AdvisorRuntime;
}

/** The teachers' round is not due: only the synthesizer or the final writer works. */
const state = () => ({ ...emptyAdviseState(), lastTeacherAt: { [RUN]: new Date().toISOString() } });

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => String((p as { text?: unknown }).text ?? "")).join("")
      : "";

const eventsOf = (service: HarnessService, kind: string) =>
  service.ledger.db
    .prepare("select body from event where kind = ? and subject = ? order by id")
    .all(kind, RUN)
    .map((e) => JSON.parse(String((e as { body: string }).body)) as Record<string, unknown>);

describe("the synthesizer and the final writer on their own models (goal 166)", () => {
  test("the synthesizer's own model writes the cards, in place of the first teacher's and with no teacher", async (t) => {
    const r = await makeResearchRun(RUN, {
      contract: { questions: SIX_QUESTIONS, rubrics: SIX_RUBRICS },
    });
    t.after(() => r.close());
    const ledger = r.env.service.ledger;
    const src = [...seedSources(ledger, RUN).values()];
    seedClaims(ledger, RUN, { question: 4, n: 3, sources: src, from: Date.now(), tag: "qown" });
    const calls = { teacher: 0, synthesizer: 0 };
    const answer = (who: keyof typeof calls) =>
      startFakeModel(({ messages }) => {
        calls[who]++;
        const user = textOf(messages.find((m) => m.role === "user")?.content);
        const req = JSON.parse(user.slice(user.indexOf("{"))) as {
          questions: { index: number; new_claims: { id: string; text: string }[] }[];
        };
        const cards = req.questions.map((q) => {
          const first = q.new_claims[0] as { id: string; text: string };
          const num = /reports (\d+) MB\/s/.exec(first.text)?.[1] ?? "0";
          return {
            question: q.index,
            answer: `The page reports ${num} MB/s for its case [${first.id}].`,
            certainty: "moderate",
            claims: [first.id],
            gaps: [],
          };
        });
        return { toolCalls: [{ name: "answer", args: { cards } }] };
      });
    const teacher = await answer("teacher");
    const synth = await answer("synthesizer");
    t.after(() => teacher.close());
    t.after(() => synth.close());
    const live: string[] = [];
    // No teacher at all: the synthesizer's own model still writes the cards.
    const alone: RunningAdvisors = {
      ...AdvisorsConfig.parse({}),
      synthesizer: runtime(synth.url, "synthesizer"),
    };
    await adviseOnce(config(r.env.service, alone, live), state());
    assert.equal(calls.synthesizer, 1);
    assert.equal(cardOf(ledger, RUN, 4)?.version, 1);
    assert.ok(
      live.some((l) => /^the synthesizer \(synthesizer\) writes the answer card/.test(l)),
      live.join("\n"),
    );
    const usage = eventsOf(r.env.service, "model_call");
    assert.ok(usage.length >= 1);
    assert.ok(usage.every((u) => u.agent === "synthesizer" && u.model === "synthesizer"));
    // With a teacher too, the synthesizer's own model is the one called.
    seedClaims(ledger, RUN, {
      question: 4,
      n: 5,
      sources: src,
      from: Date.now() + 60_000,
      tag: "qmore",
    });
    const both: RunningAdvisors = {
      ...AdvisorsConfig.parse({}),
      teachers: [runtime(teacher.url, "teacher-1")],
      synthesizer: runtime(synth.url, "synthesizer"),
    };
    await adviseOnce(config(r.env.service, both, live), state());
    assert.deepEqual(calls, { teacher: 0, synthesizer: 2 });
    assert.equal(cardOf(ledger, RUN, 4)?.version, 2);
  });

  test("the final writer's own model writes the paper, in place of the first teacher's", async (t) => {
    const s = await answeredResearchRun(RUN);
    t.after(() => s.close());
    await s.env.service.setAdvisors(
      { auditor: false, review_panel: 0, writer: true },
      "supervisor",
    );
    assert.ok(s.env.service.papers.request(RUN, "s"));
    cardsUpToDate(s.env.service, RUN);
    const calls = { teacher: 0, writer: 0 };
    const answer = (who: keyof typeof calls) =>
      startFakeModel(() => {
        calls[who]++;
        return {
          toolCalls: [{ name: "answer", args: { paper: goodPaper(s.ids), experiments: [] } }],
        };
      });
    const teacher = await answer("teacher");
    const writer = await answer("writer");
    t.after(() => teacher.close());
    t.after(() => writer.close());
    const live: string[] = [];
    const advisors: RunningAdvisors = {
      ...AdvisorsConfig.parse({}),
      teachers: [runtime(teacher.url, "teacher-1")],
      final_writer: runtime(writer.url, "final-writer"),
    };
    const out = await adviseOnce(config(s.env.service, advisors, live), state());
    assert.equal(out.stats.papers, 1, JSON.stringify(out.stats));
    assert.deepEqual(calls, { teacher: 0, writer: 1 });
    assert.ok(
      live.some((l) => /^the final writer \(final-writer\) writes the research paper/.test(l)),
      live.join("\n"),
    );
    const accepted = eventsOf(s.env.service, "research_paper_accepted")[0];
    assert.equal(accepted?.writer, "final-writer");
    const usage = eventsOf(s.env.service, "model_call");
    assert.ok(usage.every((u) => u.agent === "final_writer" && u.model === "final-writer"));
  });
});
