import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import { cardOf, cardsOf } from "../../../../src/harness/research/cards.ts";
import {
  AdvisorsConfig,
  SynthesizerAnswer,
  synthesisProblems,
} from "../../../../src/supervisor/advisors/index.ts";
import {
  type AdviseConfig,
  type AdviseState,
  adviseOnce,
  emptyAdviseState,
} from "../../../../src/supervisor/advisors/pass/index.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import {
  SIX_QUESTIONS,
  SIX_RUBRICS,
  seedClaims,
  seededNumber,
  seedSources,
} from "../../../helpers/research-cards.ts";
import { makeResearchRun } from "../../../helpers/research-run.ts";

/**
 * Goal 117: the supervisor's synthesizer, on the first teacher's model, rewrites the answer card
 * of each question of a running research run whose evidence changed since its card. It reads the
 * run's research with the teachers' research tools, its answer is read leniently, and in Pi what
 * the supervisor can check goes back to it within its call; the harness checks the rest, and keeps
 * or refuses each card. A refused card, a question that got no card and a failed call are tried
 * again at the next round, with no cap. Its model usage is recorded as the synthesizer's.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const RUN = "r-1";
const RESEARCH_TOOLS = ["list_research", "read_source", "read_research_file", "search_research"];

/** A research run on six questions with a thousand verified claims spread over five of them. */
async function sixQuestions(t: TestContext) {
  const r = await makeResearchRun(RUN, {
    contract: { questions: SIX_QUESTIONS, rubrics: SIX_RUBRICS },
  });
  t.after(() => r.close());
  const ledger = r.env.service.ledger;
  const src = [...seedSources(ledger, RUN).values()];
  const from = Date.now() - 24 * 3_600_000;
  const n = [500, 300, 150, 40, 0, 10];
  const ids = n.map((count, q) =>
    seedClaims(ledger, RUN, {
      question: q,
      n: count,
      sources: src,
      from,
      tag: `q${"abcdef"[q]}`,
    }),
  );
  const events = (kind: string) =>
    ledger.db
      .prepare("select body from event where kind = ? and subject = ? order by id")
      .all(kind, RUN)
      .map((e) => JSON.parse(String((e as { body: string }).body)) as Record<string, unknown>);
  return { ...r, ledger, ids, src, events };
}

function config(
  s: Awaited<ReturnType<typeof sixQuestions>>,
  advisors: AdvisorsConfig,
  live?: string[],
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
    ...(live ? { live: (l) => live.push(l.text) } : {}),
  };
}

function runtime(url: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
  writeFileSync(join(dir, "key"), "test-key\n");
  return { name, runtime: "openai", base_url: url, model: name, api_key_file: join(dir, "key") };
}

/** The teachers' round is not due: only the synthesizer works in these rounds. */
const state = () => ({ ...emptyAdviseState(), lastTeacherAt: { [RUN]: new Date().toISOString() } });

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => String((p as { text?: unknown }).text ?? "")).join("")
      : "";

interface Asked {
  index: number;
  label: string;
  rubric: string;
  new_claims: { id: string; text: string }[];
  through?: unknown;
  last_refusal?: { problems: string[] };
}

/** The request in the synthesizer's prompt (its user message). */
function requestOf(messages: { role: string; content?: unknown }[]): {
  kind: string;
  questions: Asked[];
} {
  const user = textOf(messages.find((m) => m.role === "user")?.content);
  return JSON.parse(user.slice(user.indexOf("{")));
}

/** A card that holds for a question of the request: its first new claim, and that claim's number. */
function goodCard(q: Asked) {
  const first = q.new_claims[0] as { id: string; text: string };
  const num = /reports (\d+) MB\/s/.exec(first.text)?.[1] ?? seededNumber(0);
  return {
    question: q.index,
    answer: `The first source reports ${num} MB/s for its case [${first.id}].`,
    certainty: "Moderate",
    claims: [first.id],
    gaps: [
      { kind: "Evidence", text: "A vendor's documentation of the case." },
      { kind: "measurement", text: "Run the kernel on the card." },
    ],
  };
}

describe("the synthesizer writes the answer cards (goal 117)", () => {
  test("one call per run: the request with its rules and rubrics, the research tools, cards posted with their through, usage as the synthesizer's", async (t) => {
    const s = await sixQuestions(t);
    const seen = { system: "", tools: [] as string[], kinds: [] as string[], asked: [] as Asked[] };
    const fake = await startFakeModel(({ messages, tools }) => {
      seen.system = textOf(messages.find((m) => m.role === "system")?.content);
      seen.tools = tools.map((x) => x.function.name);
      const req = requestOf(messages);
      seen.kinds.push(req.kind);
      seen.asked = req.questions;
      return { toolCalls: [{ name: "answer", args: { cards: req.questions.map(goodCard) } }] };
    });
    t.after(() => fake.close());
    const live: string[] = [];
    const out = await adviseOnce(
      config(s, AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-1")] }), live),
      state(),
    );
    assert.equal(fake.requests, 1, "one call for the run's five questions");
    assert.deepEqual(seen.kinds, ["cards"]);
    assert.match(seen.system, /You are the synthesizer of a research run/);
    assert.match(seen.system, /It has no target to measure/, "the run measures nothing");
    assert.match(
      seen.system,
      /A gap of kind measurement is one that only a measurement could settle/,
    );
    for (const name of RESEARCH_TOOLS) assert.ok(seen.tools.includes(name), name);
    assert.deepEqual(
      seen.asked.map((q) => [q.index, q.label]),
      [
        [0, "Question 1 (index 0)"],
        [1, "Question 2 (index 1)"],
        [2, "Question 3 (index 2)"],
        [3, "Question 4 (index 3)"],
        [5, "Question 6 (index 5)"],
      ],
    );
    assert.equal(seen.asked[0]?.rubric, SIX_RUBRICS[0]);
    assert.ok(
      seen.asked.every((q) => q.through === undefined),
      "the through stays with the supervisor",
    );
    // Kept, each with the through the harness gave: question 1's next request starts after it.
    assert.equal(out.stats.cards, 5, JSON.stringify(out.stats));
    assert.deepEqual(
      cardsOf(s.ledger, RUN).map((c) => [c.question, c.version, c.certainty]),
      [
        [0, 1, "moderate"],
        [1, 1, "moderate"],
        [2, 1, "moderate"],
        [3, 1, "moderate"],
        [5, 1, "moderate"],
      ],
    );
    assert.deepEqual(cardOf(s.ledger, RUN, 0)?.gaps[0], {
      kind: "evidence",
      text: "A vendor's documentation of the case.",
    });
    const written = s.events("card_written");
    assert.ok(written.every((e) => typeof e.through === "string"));
    const [next] = s.env.service.cardPackages();
    const q0 = next?.questions.find((q) => q.index === 0);
    assert.equal(q0?.new_claims[0]?.id, s.ids[0]?.[seen.asked[0]?.new_claims.length ?? 0]);
    // The model usage, as the synthesizer's.
    const calls = s.events("model_call");
    assert.ok(calls.length >= 1);
    assert.ok(
      calls.every((c) => c.agent === "synthesizer"),
      JSON.stringify(calls[0]),
    );
    assert.match(String(calls[0]?.round), /^cards /);
    assert.ok(
      live.some((l) =>
        /the synthesizer \(teacher-1\) writes the answer cards of questions 1, 2, 3, 4, 6/.test(l),
      ),
    );
    assert.ok(
      live.some((l) => /the harness kept the answer cards of questions 1, 2, 3, 4, 6/.test(l)),
    );
  });

  test("a refused card is written again at the next round, with the harness's problems in its request", async (t) => {
    const s = await sixQuestions(t);
    const refusals: (string[] | undefined)[] = [];
    const asked: number[] = [];
    let round = 0;
    const fake = await startFakeModel(({ messages }) => {
      const req = requestOf(messages);
      round++;
      refusals.push(req.questions.find((q) => q.index === 3)?.last_refusal?.problems);
      asked.push(req.questions.length);
      const cards = req.questions.map((q) =>
        q.index === 3 && round === 1
          ? { ...goodCard(q), answer: `A source reports 98765 MB/s [${q.new_claims[0]?.id}].` }
          : goodCard(q),
      );
      return { toolCalls: [{ name: "answer", args: { cards } }] };
    });
    t.after(() => fake.close());
    const live: string[] = [];
    const cfg = config(
      s,
      AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-1")] }),
      live,
    );
    let st = await adviseOnce(cfg, state());
    assert.equal(st.stats.cards, 4);
    assert.equal(cardOf(s.ledger, RUN, 3), undefined);
    assert.ok(
      live.some((l) =>
        /it refused question 4's \(the number 98765 is not in the claims it cites\): the synthesizer writes it again at the next round/.test(
          l,
        ),
      ),
      live.join("\n"),
    );
    // The next round: question 4's request carries the problem, and its card is kept.
    st = await adviseOnce(cfg, { ...st, lastTeacherAt: { [RUN]: new Date().toISOString() } });
    assert.deepEqual(refusals[1], ["the number 98765 is not in the claims it cites"]);
    assert.equal(cardOf(s.ledger, RUN, 3)?.version, 1);
    // Every card of the second request was kept too: question 4's and those whose claims were cut.
    assert.equal(st.stats.cards, 4 + (asked[1] ?? 0));
    assert.ok((asked[1] ?? 0) >= 2, "question 4 and the claims cut from question 1 came back");
  });

  test("in Pi, a card the supervisor can check goes back within the call; a question left out and a failed call are asked again at the next round", async (t) => {
    const s = await sixQuestions(t);
    const said: string[] = [];
    let fail = true;
    const fake = await startFakeModel(({ messages }) => {
      if (fail) return { fail: 500 };
      const req = requestOf(messages);
      const results = messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
      said.push(...results);
      if (!results.length)
        // First: a certainty off the scale, and question 6 left out.
        return {
          toolCalls: [
            {
              name: "answer",
              args: {
                cards: req.questions
                  .filter((q) => q.index !== 5)
                  .map((q) => ({ ...goodCard(q), certainty: q.index === 0 ? "certain" : "low" })),
              },
            },
          ],
        };
      // Then: the scale's words, but still without question 6 (it has no source for it).
      return {
        toolCalls: [
          {
            name: "answer",
            args: { cards: req.questions.filter((q) => q.index !== 5).map(goodCard) },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const live: string[] = [];
    const cfg = config(
      s,
      AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-1")] }),
      live,
    );
    // A failed call: an error line, nothing kept, and no wait before the next try.
    let st = await adviseOnce(cfg, state());
    assert.equal(st.stats.cards ?? 0, 0);
    assert.ok(st.stats.errors > 0);
    assert.ok(
      live.some((l) => /the answer cards of r-1 \(tried again at the next round\)/.test(l)),
    );
    fail = false;
    st = await adviseOnce(cfg, { ...st, lastTeacherAt: { [RUN]: new Date().toISOString() } });
    // Refused once within the call, with what the supervisor can check.
    assert.equal(said.filter((x) => x.startsWith("refused: ")).length, 1, said.join(" | "));
    assert.match(
      said[0] ?? "",
      /the card for index 0: the certainty is one of high, moderate, low, insufficient, none/,
    );
    assert.match(said[0] ?? "", /give a card for the question with index 5/);
    // Its next answer is taken: the other cards are kept, and question 6 is asked again next round.
    assert.equal(st.stats.cards, 4);
    assert.equal(cardOf(s.ledger, RUN, 0)?.certainty, "moderate");
    assert.equal(cardOf(s.ledger, RUN, 5), undefined);
    assert.ok(
      live.some((l) =>
        /the synthesizer gave no card for question 6: asked again at the next round/.test(l),
      ),
      live.join("\n"),
    );
    const [pkg] = s.env.service.cardPackages();
    assert.ok(pkg?.questions.some((q) => q.index === 5));
  });

  test("with no question whose evidence changed, the synthesizer is not called; without a teacher there is no synthesizer", async (t) => {
    const s = await sixQuestions(t);
    let calls = 0;
    const fake = await startFakeModel(({ messages }) => {
      calls++;
      const req = requestOf(messages);
      return { toolCalls: [{ name: "answer", args: { cards: req.questions.map(goodCard) } }] };
    });
    t.after(() => fake.close());
    // No teacher: no synthesizer, nothing asked.
    await adviseOnce(config(s, AdvisorsConfig.parse({})), state());
    assert.equal(calls, 0);
    // Cards for every question whose claims are all shown at once: question 1's claims come over
    // more requests, so the rounds go on until every card has seen every claim.
    const cfg = config(s, AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-1")] }));
    let st: AdviseState = state();
    for (let i = 0; i < 20 && s.env.service.cardPackages().length; i++)
      st = await adviseOnce(cfg, { ...st, lastTeacherAt: { [RUN]: new Date().toISOString() } });
    assert.deepEqual(s.env.service.cardPackages(), []);
    const before = calls;
    await adviseOnce(cfg, { ...st, lastTeacherAt: { [RUN]: new Date().toISOString() } });
    assert.equal(calls, before, "nothing changed: no call");
    // New claims of one question: one call, for that question alone.
    seedClaims(s.ledger, RUN, {
      question: 4,
      n: 2,
      sources: s.src,
      from: Date.now(),
      tag: "qnew",
    });
    await adviseOnce(cfg, { ...st, lastTeacherAt: { [RUN]: new Date().toISOString() } });
    assert.equal(calls, before + 1);
    assert.equal(cardOf(s.ledger, RUN, 4)?.version, 1);
  });
});

describe("the synthesizer's answer is read leniently and checked before it is posted (goal 117)", () => {
  test("a card that does not fit is left out; words are read whatever their case; nothing is cut", () => {
    const a = SynthesizerAnswer.parse({
      cards: [
        {
          question: "2",
          answer: "A.",
          certainty: " HIGH ",
          claims: ["c-1"],
          gaps: [{ kind: "Evidence", text: "x" }, { nope: 1 }],
        },
        { answer: "no question" },
        { question: 1, answer: "x".repeat(7000), certainty: "low", claims: [], gaps: [] },
      ],
      extra: true,
    });
    assert.equal(a.cards.length, 2);
    assert.deepEqual(a.cards[0], {
      question: 2,
      answer: "A.",
      certainty: "high",
      claims: ["c-1"],
      borrowed: [],
      gaps: [{ kind: "evidence", text: "x" }],
    });
    assert.equal(a.cards[1]?.answer.length, 7000, "not cut: the harness refuses it in words");
    assert.equal(
      synthesisProblems({ questions: [{ index: 1 }, { index: 2 }, { index: 3 }] }, a),
      "give a card for the question with index 3; the card for index 1: the answer has 7,000 characters, at most 6,000; the card for index 1: cite at least one verified claim, or give certainty none",
    );
  });
});
