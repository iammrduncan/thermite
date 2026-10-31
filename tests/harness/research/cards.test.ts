import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import type { ResearchTrialSpec } from "../../../src/harness/agents/research/worker.ts";
import { Scheduler } from "../../../src/harness/agents/scheduler/index.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import {
  BRIEF_ANSWER_CHARS,
  CARD_ANSWER_MAX,
  CARD_GAP_MAX,
  CARD_PACE,
  CARDS_PACKAGE_MAX,
  type CardInput,
  Cards,
  type CardsPackage,
  cardHistory,
  cardOf,
  cardsOf,
} from "../../../src/harness/research/cards.ts";
import type { Research } from "../../../src/harness/research/research/index.ts";
import { briefText } from "../../helpers/brief-text.ts";
import {
  DOMAINS,
  SIX_QUESTIONS,
  SIX_RUBRICS,
  seedClaims,
  seededNumber,
  seedSources,
} from "../../helpers/research-cards.ts";
import { fillResearch, makeResearchRun } from "../../helpers/research-run.ts";

/**
 * Goal 117, answer cards: the harness keeps one card per question as versions, lists the
 * questions whose evidence changed since their card for the supervisor's synthesizer, and checks
 * each card it posts in code: kept as the next version, or refused with each problem in words,
 * which go back with the next request. The cards lead the worker's brief, the research folder
 * (cards/q<index>.md and INDEX.md), the report's Answers and the teachers' brief.
 */

const RUN = "r-1";
const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const DAY = 24 * 3_600_000;

const done = {
  stopped: "no_submission" as const,
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
};

/**
 * A research run on six questions with rubrics, and a thousand claims, as a long run has:
 * question 1 has 600 verified claims, question 2 300 (from one domain), question 3 60, question 4
 * 5, question 5 none and question 6 one; 30 name no question; and 20 drafts of question 1.
 */
async function sixQuestions(t: TestContext) {
  const r = await makeResearchRun(RUN, {
    contract: { questions: SIX_QUESTIONS, rubrics: SIX_RUBRICS },
  });
  t.after(() => r.close());
  const ledger = r.env.service.ledger;
  const src = seedSources(ledger, RUN);
  const all = [...src.values()];
  const one = [src.get(DOMAINS[0] as string) as string];
  const from = Date.now() - DAY;
  const ids = {
    q0: seedClaims(ledger, RUN, { question: 0, n: 600, sources: all, from, tag: "qa" }),
    q1: seedClaims(ledger, RUN, { question: 1, n: 300, sources: one, from, tag: "qb" }),
    q2: seedClaims(ledger, RUN, { question: 2, n: 60, sources: all, from, tag: "qc" }),
    q3: seedClaims(ledger, RUN, { question: 3, n: 5, sources: one, from, tag: "qd" }),
    q5: seedClaims(ledger, RUN, { question: 5, n: 1, sources: all, from, tag: "qf" }),
    none: seedClaims(ledger, RUN, { question: null, n: 30, sources: all, from, tag: "qx" }),
    drafts: seedClaims(ledger, RUN, {
      question: 0,
      n: 20,
      sources: all,
      from,
      tag: "qz",
      verified: false,
    }),
  };
  const api = createHarnessApi(r.env.service, tokens);
  const call = async (method: string, path: string, body?: unknown, token = tokens.supervisor) => {
    const res = await api.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const events = (kind: string) =>
    ledger.db
      .prepare("select body from event where kind = ? and subject = ? order by id")
      .all(kind, RUN)
      .map((e) => JSON.parse(String((e as { body: string }).body)) as Record<string, unknown>);
  const pending = async () =>
    ((await call("GET", "/v1/research/cards/pending")).body.runs ?? []) as CardsPackage[];
  return { ...r, ledger, ids, src, call, events, pending };
}

/** A card that holds, for question `q`, citing `claims` and stating the numbers of `ks`. */
function card(
  q: number,
  claims: string[],
  ks: number[],
  over: Partial<CardInput> = {},
): Partial<CardInput> {
  return {
    question: q,
    answer: `The sources report ${ks.map(seededNumber).join(" and ")} MB/s for the cases they measured (${claims[0]}).`,
    certainty: "moderate",
    claims,
    gaps: [
      { kind: "evidence", text: "A vendor's documentation of the same case." },
      { kind: "measurement", text: "Run the kernel on the card itself." },
    ],
    ...over,
  };
}

describe("answer cards are checked by code and kept as versions (goal 117)", () => {
  test("a card that holds is kept as version 1, then 2; the newest is the card, its history stays; card_written says it", async (t) => {
    const s = await sixQuestions(t);
    const post = (cards: Partial<CardInput>[]) =>
      s.call("POST", `/v1/research/cards/${RUN}`, { synthesizer: "teacher-1", cards });
    const r1 = await post([card(0, [s.ids.q0[0] as string, s.ids.q0[1] as string], [0, 1])]);
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body.results, [{ question: 0, accepted: true, version: 1 }]);
    const r2 = await post([
      card(0, [s.ids.q0[2] as string], [2], {
        certainty: "high",
        gaps: [],
        answer: "  The newest source reports 1002 MB/s for its case.  ",
      }),
    ]);
    assert.deepEqual(r2.body.results, [{ question: 0, accepted: true, version: 2 }]);
    const c = cardOf(s.ledger, RUN, 0);
    assert.equal(c?.version, 2);
    assert.equal(c?.certainty, "high");
    assert.equal(c?.answer, "The newest source reports 1002 MB/s for its case.");
    assert.deepEqual(c?.claims, [s.ids.q0[2]]);
    assert.equal(c?.by, "teacher-1");
    assert.deepEqual(
      cardHistory(s.ledger, RUN, 0).map((h) => [h.version, h.certainty]),
      [
        [1, "moderate"],
        [2, "high"],
      ],
    );
    assert.deepEqual(
      cardsOf(s.ledger, RUN).map((x) => [x.question, x.version]),
      [[0, 2]],
    );
    const written = s.events("card_written");
    assert.equal(written.length, 2);
    assert.deepEqual(
      {
        question: written[0]?.question,
        version: written[0]?.version,
        certainty: written[0]?.certainty,
        claims: written[0]?.claims,
        gaps: written[0]?.gaps,
        by: written[0]?.by,
      },
      { question: 0, version: 1, certainty: "moderate", claims: 2, gaps: 2, by: "teacher-1" },
    );
    assert.deepEqual(written[0]?.gap_list, [
      { kind: "evidence", text: "A vendor's documentation of the same case." },
      { kind: "measurement", text: "Run the kernel on the card itself." },
    ]);
    // The table is append-only: a version cannot be changed or taken out.
    assert.throws(
      () => s.ledger.db.prepare("update question_card set answer = 'x'").run(),
      /append-only/,
    );
    assert.throws(() => s.ledger.db.prepare("delete from question_card").run(), /append-only/);
  });

  test("a card that fails is refused with each problem in words, not kept, and its problems go back with the next request", async (t) => {
    const s = await sixQuestions(t);
    const q0 = s.ids.q0;
    const post = async (c: Partial<CardInput>) => {
      const r = await s.call("POST", `/v1/research/cards/${RUN}`, {
        synthesizer: "teacher-1",
        cards: [c],
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [res] = r.body.results as { accepted: boolean; problems?: string[] }[];
      assert.equal(res?.accepted, false, JSON.stringify(res));
      return res?.problems ?? [];
    };
    const has = (ps: string[], re: RegExp) =>
      assert.ok(
        ps.some((p) => re.test(p)),
        `no problem matches ${re}: ${JSON.stringify(ps)}`,
      );
    // A draft, an unknown id, and a number no cited claim holds.
    has(
      await post(card(0, [s.ids.drafts[0] as string], [0])),
      /^claim c-qz000000 is a draft, not verified$/,
    );
    has(await post(card(0, ["c-nosuchclaim1"], [0])), /^no claim c-nosuchclaim1$/);
    has(
      await post(card(0, [q0[0] as string], [0], { answer: "It reports 7777 MB/s (c-qa000000)." })),
      /^the number 7777 is not in the claims it cites$/,
    );
    // The certainty's word, and a card that cites nothing.
    has(
      await post(card(0, [q0[0] as string], [0], { certainty: "very high" })),
      /^the certainty "very high" is not one of high, moderate, low, insufficient, none$/,
    );
    has(
      await post(card(0, [], [], { answer: "Nothing is known yet." })),
      /cites at least one verified claim; with no claim to cite, its certainty is none/,
    );
    // The answer's bounds.
    has(await post(card(0, [q0[0] as string], [0], { answer: "   " })), /^the answer is empty$/);
    has(
      await post(card(0, [q0[0] as string], [0], { answer: "a".repeat(CARD_ANSWER_MAX + 1) })),
      /^the answer has 6,001 characters: a card's answer has at most 6,000, a few paragraphs$/,
    );
    // The gaps: a kind each, words, and bounds.
    const gaps = await post(
      card(0, [q0[0] as string], [0], {
        gaps: [
          { kind: "data", text: "More data." },
          { kind: "evidence", text: "" },
          { kind: "evidence", text: "x".repeat(CARD_GAP_MAX + 1) },
        ],
      }),
    );
    has(gaps, /^gap 1's kind "data" is not evidence .* or measurement/);
    has(gaps, /^gap 2 has no words$/);
    has(gaps, /^gap 3 has 501 characters: at most 500$/);
    has(
      await post(
        card(0, [q0[0] as string], [0], {
          gaps: Array.from({ length: 13 }, () => ({ kind: "evidence", text: "A source." })),
        }),
      ),
      /^the card names 13 gaps: at most 12$/,
    );
    // A claim of another question, or of none, needs why; borrowed must name a cited claim.
    has(
      await post(card(0, [s.ids.q1[0] as string], [0])),
      /^claim c-qb000000 is recorded for question 2 \(index 1\): say in borrowed why this card cites it$/,
    );
    has(
      await post(card(0, [s.ids.none[0] as string], [0])),
      /^claim c-qx000000 is recorded for no question: say in borrowed why this card cites it$/,
    );
    has(
      await post(
        card(0, [q0[0] as string], [0], { borrowed: [{ claim: "c-qb000001", why: "Same case." }] }),
      ),
      /^borrowed names claim c-qb000001, which the card does not cite$/,
    );
    // The through the request gave must be a verified claim of this question.
    has(
      await post(card(0, [q0[0] as string], [0], { through: s.ids.q1[0] as string })),
      /^through c-qb000000 is not a verified claim of question 1 \(index 0\)/,
    );
    assert.equal(cardOf(s.ledger, RUN, 0), undefined, "nothing was kept");
    assert.equal(s.events("card_refused").length, 13);
    // The newest refusal goes back with the question's next request, until a card is kept.
    const [pkg] = await s.pending();
    const item = pkg?.questions.find((q) => q.index === 0);
    assert.match(item?.last_refusal?.problems[0] ?? "", /^through c-qb000000/);
    // A borrowed claim with why holds; a kept card clears the refusal from the request.
    const ok = await s.call("POST", `/v1/research/cards/${RUN}`, {
      synthesizer: "teacher-1",
      cards: [
        card(0, [q0[0] as string, s.ids.q1[0] as string], [0], {
          borrowed: [{ claim: s.ids.q1[0] as string, why: "It measures the same tiled case." }],
          through: q0[0] as string,
        }),
      ],
    });
    assert.deepEqual(ok.body.results, [{ question: 0, accepted: true, version: 1 }]);
    const [after] = await s.pending();
    assert.equal(after?.questions.find((q) => q.index === 0)?.last_refusal, undefined);
  });

  test("a question the run does not have, and a second card for one question, are refused; a closed run takes none", async (t) => {
    const s = await sixQuestions(t);
    const r = await s.call("POST", `/v1/research/cards/${RUN}`, {
      synthesizer: "teacher-1",
      cards: [
        card(6, [s.ids.q0[0] as string], [0]),
        card(3, [s.ids.q3[0] as string], [0]),
        card(3, [s.ids.q3[1] as string], [1]),
      ],
    });
    assert.deepEqual(r.body.results, [
      {
        question: 6,
        accepted: false,
        problems: ["there is no question with index 6: the run has 6 (index 0 to 5)"],
      },
      { question: 3, accepted: true, version: 1 },
      {
        question: 3,
        accepted: false,
        problems: ["a second card for question 4 (index 3) in this request"],
      },
    ]);
    // Only the second card of question 4 is a refusal of the run's: question 7 does not exist.
    assert.deepEqual(
      s.events("card_refused").map((e) => e.question),
      [3],
    );
    s.ledger.runs.setStatus(RUN, "paused", "test", "owner");
    const paused = await s.call("POST", `/v1/research/cards/${RUN}`, {
      synthesizer: "teacher-1",
      cards: [card(3, [s.ids.q3[0] as string], [0])],
    });
    assert.equal(paused.status, 400);
    assert.match(String(paused.body.error), /run r-1 is paused/);
  });

  test("the routes take the supervisor's token only, and a malformed body is refused", async (t) => {
    const s = await sixQuestions(t);
    assert.equal(
      (await s.call("GET", "/v1/research/cards/pending", undefined, tokens.proposer)).status,
      401,
    );
    assert.equal(
      (
        await s.call(
          "POST",
          `/v1/research/cards/${RUN}`,
          { synthesizer: "x", cards: [card(0, [s.ids.q0[0] as string], [0])] },
          tokens.proposer,
        )
      ).status,
      401,
    );
    assert.equal(
      (await s.call("POST", `/v1/research/cards/${RUN}`, { cards: [card(0, [], [])] })).status,
      400,
    );
    assert.equal(
      (await s.call("POST", `/v1/research/cards/${RUN}`, { synthesizer: "x", cards: [] })).status,
      400,
    );
  });
});

describe("the synthesizer's request: the questions whose evidence changed since their card (goal 117)", () => {
  test("at scale: each question with verified claims and no card, bounded, cut with a note, the oldest new claims first", async (t) => {
    const s = await sixQuestions(t);
    const runs = await s.pending();
    assert.equal(runs.length, 1);
    const pkg = runs[0] as CardsPackage;
    assert.equal(pkg.kind, "cards");
    assert.equal(pkg.run, RUN);
    // Question 5 (index 4) has no verified claim: nothing to write yet.
    assert.deepEqual(
      pkg.questions.map((q) => q.index),
      [0, 1, 2, 3, 5],
    );
    assert.ok(JSON.stringify(pkg).length <= CARDS_PACKAGE_MAX, "bounded");
    assert.match(pkg.shortened ?? "", /Some claims are not shown, to keep this request short/);
    const q0 = pkg.questions[0];
    assert.equal(q0?.label, "Question 1 (index 0)");
    assert.equal(q0?.rubric, SIX_RUBRICS[0]);
    assert.equal(q0?.card, null);
    assert.equal(q0?.verified_claims, 600);
    assert.equal(q0?.new_claims_total, 600);
    const shown = q0?.new_claims.length ?? 0;
    assert.ok(shown > 0 && shown < 600, `shown ${shown}`);
    assert.equal(q0?.new_claims_not_shown, 600 - shown);
    // The oldest first, so what is cut comes in the next request; the drafts are never shown.
    assert.deepEqual(
      q0?.new_claims.map((c) => c.id),
      s.ids.q0.slice(0, shown),
    );
    assert.equal(q0?.through, s.ids.q0[shown - 1]);
    // Each claim with its words, its sources' domains and whether it is corroborated.
    // Registrable domains, not hosts (goal 162).
    assert.deepEqual(q0?.new_claims[0]?.domains.sort(), [
      "example.com",
      "example.net",
      "example.org",
    ]);
    assert.equal(q0?.new_claims[0]?.corroborated, true);
    const q1 = pkg.questions[1];
    assert.equal(q1?.new_claims[0]?.corroborated, false, "one domain only");
    // A small question is whole.
    const q3 = pkg.questions.find((q) => q.index === 3);
    assert.equal(q3?.new_claims.length, 5);
    assert.equal(q3?.new_claims_not_shown, undefined);
    // The rules and the scale in words.
    assert.ok(pkg.rules.some((r) => /at most 6,000 characters/.test(r)));
    assert.match(pkg.certainty.insufficient, /only from a measurement/);
  });

  test("after a card: only claims recorded after its through are new, those cut come next, those recorded while it was written are not lost", async (t) => {
    const s = await sixQuestions(t);
    const [first] = await s.pending();
    const at = (i: number) => first?.questions.find((q) => q.index === i);
    const shown0 = at(0)?.new_claims.length ?? 0;
    // While the synthesizer works, question 4 (index 3) gets 5 new claims: enough to be asked
    // again at once (CARD_PACE).
    const late = seedClaims(s.ledger, RUN, {
      question: 3,
      n: 5,
      sources: [...s.src.values()],
      from: Date.now(),
      tag: "qlate",
    });
    // It posts every card of the request, each with the through it was given.
    const cards = (first?.questions ?? []).map((q) =>
      card(q.index, [q.new_claims[0]?.id as string], [0], { through: q.through }),
    );
    const posted = await s.call("POST", `/v1/research/cards/${RUN}`, {
      synthesizer: "teacher-1",
      cards,
    });
    assert.ok(
      (posted.body.results as { accepted: boolean }[]).every((r) => r.accepted),
      JSON.stringify(posted.body),
    );
    const [next] = await s.pending();
    const now = (i: number) => next?.questions.find((q) => q.index === i);
    // Question 1: the rest of its claims, from the one after the through.
    assert.equal(now(0)?.new_claims_total, 600 - shown0);
    assert.equal(now(0)?.new_claims[0]?.id, s.ids.q0[shown0]);
    assert.equal(now(0)?.card?.version, 1);
    assert.deepEqual(
      now(0)?.card_claims.map((c) => c.id),
      [s.ids.q0[0]],
    );
    // Question 4: the claims recorded while its card was written.
    assert.deepEqual(
      now(3)?.new_claims.map((c) => c.id),
      late,
    );
    // Questions whose card saw every claim are not asked again.
    assert.equal(now(5), undefined);
    assert.equal(now(2), undefined);
  });

  test("a card is written again once 5 new claims came, or once it is 30 minutes old; not on every new claim", async (t) => {
    const s = await sixQuestions(t);
    const [first] = await s.pending();
    const cards = (first?.questions ?? []).map((q) =>
      card(q.index, [q.new_claims[0]?.id as string], [0], { through: q.through }),
    );
    await s.call("POST", `/v1/research/cards/${RUN}`, { synthesizer: "teacher-1", cards });
    const fresh = (n: number, tag: string) =>
      seedClaims(s.ledger, RUN, {
        question: 5,
        n,
        sources: [...s.src.values()],
        from: Date.now(),
        tag,
      });
    const asked = (pkgs: CardsPackage[]) =>
      pkgs.flatMap((p) => p.questions).some((q) => q.index === 5);
    fresh(1, "pace1");
    assert.equal(asked(await s.pending()), false, "one new claim: not yet");
    const cardsNow = new Cards(s.ledger, (run) => s.env.service.contractFor(run));
    assert.equal(
      asked(cardsNow.pending(Date.now() + CARD_PACE.ms + 1000)),
      true,
      "its card is old",
    );
    fresh(CARD_PACE.claims - 1, "pace2");
    assert.equal(asked(await s.pending()), true, "5 new claims: at once");
  });

  test("claims recorded in the same millisecond are ordered by id: none is skipped", async (t) => {
    const s = await sixQuestions(t);
    const when = Date.now() + 60_000;
    const add = (id: string) =>
      s.ledger.db
        .prepare(
          "insert into claim (id, run, lane, question, text, quotes, verified, problems, created_at) values (?, ?, 'lane-1', 5, 'The same moment holds 1000 MB/s.', ?, 1, '[]', ?)",
        )
        .run(
          id,
          RUN,
          JSON.stringify([{ source: [...s.src.values()][0], quote: "x".repeat(20) }]),
          new Date(when).toISOString(),
        );
    add("c-same000001");
    add("c-same000002");
    // A card given through the first of the two: the second is still new.
    const ok = await s.call("POST", `/v1/research/cards/${RUN}`, {
      synthesizer: "teacher-1",
      cards: [card(5, ["c-same000001"], [0], { through: "c-same000001" })],
    });
    assert.deepEqual(ok.body.results, [{ question: 5, accepted: true, version: 1 }]);
    // Asked once the card is old enough (CARD_PACE), as one new claim alone does not ask again.
    const cards = new Cards(s.ledger, (run) => s.env.service.contractFor(run));
    const [pkg] = cards.pending(when + CARD_PACE.ms + 1000);
    assert.deepEqual(
      pkg?.questions.find((q) => q.index === 5)?.new_claims.map((c) => c.id),
      ["c-same000002"],
    );
  });
});

describe("the cards in the brief, the folder, the report and the teachers' brief (goal 117)", () => {
  /** The fixture's run (two questions) with a card for question 1 (index 0) in two versions. */
  async function withCard(t: TestContext) {
    const r = await makeResearchRun(RUN, {
      contract: { rubrics: ["How many pages, and from which run.", "What keeps it honest."] },
    });
    t.after(() => r.close());
    const ids = await fillResearch(r);
    const svc = r.env.service;
    const base = {
      question: 0,
      claims: [ids.claims.verified],
      borrowed: [],
      gaps: [
        { kind: "evidence", text: "A second site that counts the pages." },
        { kind: "measurement", text: "Count the pages of a new run on the rig." },
      ],
      through: ids.claims.verified,
    };
    svc.submitCards(
      RUN,
      {
        synthesizer: "teacher-1",
        cards: [{ ...base, answer: "The first run archived 42 pages.", certainty: "low" }],
      },
      "supervisor",
    );
    const long = `The first run archived 42 pages. ${"It kept every page it read. ".repeat(80)}`;
    const out = svc.submitCards(
      RUN,
      { synthesizer: "teacher-1", cards: [{ ...base, answer: long, certainty: "moderate" }] },
      "supervisor",
    );
    assert.deepEqual(out.results, [{ question: 0, accepted: true, version: 2 }]);
    return { ...r, ids, long };
  }

  test("a research worker's brief shows each card's answer, certainty and open evidence gaps; a long answer is cut and says where the rest is", async (t) => {
    const s = await withCard(t);
    const briefs: string[] = [];
    const sch = new Scheduler({
      service: s.env.service,
      runner: new LocalRunner(s.env.service.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "s",
      research: s.research as Research,
      runTrial: async () => done,
      runResearchTrial: async (spec: ResearchTrialSpec) => {
        briefs.push(briefText(spec.brief));
        return done;
      },
      maxConcurrent: 1,
    });
    await sch.tick();
    await sch.idle();
    const brief = briefs.at(-1) ?? "";
    assert.match(brief, /Answer cards: the run's current answer to each question/);
    assert.match(
      brief,
      /- Question 1 \(index 0\), certainty moderate \(card version 2\): The first run archived 42 pages\./,
    );
    assert.match(brief, /\(cut here: the whole answer is in cards\/q0\.md\)/);
    assert.ok(!brief.includes(s.long.replace(/\s+/g, " ").trim()), "the long answer is cut");
    assert.match(brief, / {2}Open evidence gap: A second site that counts the pages\./);
    assert.ok(!brief.includes("Count the pages of a new run"), "no measurement gap for workers");
    assert.match(brief, /- Question 2 \(index 1\): no card yet \(1 verified claims so far\)\./);
    // The cards come before the corpus's counts.
    assert.ok(brief.indexOf("Answer cards:") < brief.indexOf("Corpus:"));
    const cut = /certainty moderate \(card version 2\): (.*)$/m.exec(brief)?.[1] ?? "";
    assert.ok(cut.length <= BRIEF_ANSWER_CHARS + 80, `${cut.length}`);
  });

  test("the research folder holds cards/q<index>.md for each question, and INDEX.md links them", async (t) => {
    const s = await withCard(t);
    const root = s.folder.sync(RUN);
    const q0 = readFileSync(join(root, "cards", "q0.md"), "utf8");
    assert.match(q0, /^# Question 1 \(index 0\)\n\nHow much did the first run archive\?/);
    assert.match(q0, /Rubric \(what an answer must cover\): How many pages, and from which run\./);
    assert.match(q0, /## Answer card: version 2, certainty moderate/);
    assert.match(q0, /Written .* by teacher-1\./);
    assert.ok(q0.includes(s.long.trim()), "the answer whole");
    assert.match(
      q0,
      new RegExp(
        `- ${s.ids.claims.verified} \\(claims/${s.ids.claims.verified}\\.md\\): The first run archived 42 pages\\.`,
      ),
    );
    assert.match(q0, /- Evidence: A second site that counts the pages\./);
    assert.match(
      q0,
      /- Measurement \(a next experiment for a goal or hill-climb run\): Count the pages of a new run on the rig\./,
    );
    assert.match(
      q0,
      /## Earlier versions\n\n- version 1, certainty low, .* by teacher-1: The first run archived 42 pages\./,
    );
    const q1 = readFileSync(join(root, "cards", "q1.md"), "utf8");
    assert.match(q1, /^# Question 2 \(index 1\)/);
    assert.match(q1, /No card yet\. The question has 1 verified claims so far\./);
    assert.ok(!existsSync(join(root, "cards", "q2.md")));
    const index = readFileSync(join(root, "INDEX.md"), "utf8");
    assert.match(index, /- cards\/: one answer card for each question/);
    assert.match(
      index,
      /## Answer cards\n\n.*\n\n- Question 1 \(index 0\): cards\/q0\.md, certainty moderate \(version 2\), 1 open evidence gaps\n- Question 2 \(index 1\): cards\/q1\.md, no card yet \(1 verified claims\)/,
    );
  });

  test("the report opens with ## Answers, each question's card for people; then the rest as before", async (t) => {
    const s = await withCard(t);
    const { body } = s.research.report(RUN, "digest");
    const at = (w: string) => body.indexOf(w);
    assert.ok(at("## Answers") > 0);
    assert.ok(at("## Answers") < at("## Questions"));
    assert.ok(at("## Questions") < at("## Findings"));
    assert.match(
      body,
      /### Question 1: How much did the first run archive\?\n\nCertainty: moderate\. Card version 2, written .* by teacher-1\.\n\nThe first run archived 42 pages\./,
    );
    assert.match(body, new RegExp(`Cites: ${s.ids.claims.verified}\\.`));
    assert.match(
      body,
      /Open gaps:\n- Evidence: A second site that counts the pages\.\n- Measurement/,
    );
    assert.match(
      body,
      /### Question 2: What keeps a long campaign honest\?\n\nNo answer card yet \(1 verified claims\)\./,
    );
    // The Answers section is for people: "Question 1" alone. The questions list after it, which
    // workers read too, names both numbers.
    const answers = body.slice(at("## Answers"), at("## Questions"));
    assert.ok(!/\(index \d+\)/.test(answers), "people read Question 1 alone");
  });

  test("the teachers' brief carries each card, and their file tool reads a card whole", async (t) => {
    const s = await withCard(t);
    const summary = s.env.service.runResearch.summary(RUN) as {
      cards?: {
        question: number;
        label: string;
        file: string;
        card: { version: number; certainty: string; answer: string; answer_chars: number } | null;
      }[];
    };
    assert.equal(summary.cards?.length, 2);
    assert.deepEqual(
      [summary.cards?.[0]?.label, summary.cards?.[0]?.file, summary.cards?.[0]?.card?.version],
      ["Question 1 (index 0)", "cards/q0.md", 2],
    );
    assert.equal(summary.cards?.[0]?.card?.answer_chars, s.long.trim().length);
    assert.ok((summary.cards?.[0]?.card?.answer.length ?? 0) <= 2000);
    assert.equal(summary.cards?.[1]?.card, null);
    const file = s.env.service.runResearch.file(RUN, "cards/q0.md") as {
      text?: string;
      by?: string;
    };
    assert.equal(file.by, "teacher-1");
    assert.match(String(JSON.stringify(file)), /Answer card: version 2, certainty moderate/);
    assert.throws(
      () => s.env.service.runResearch.file(RUN, "cards/q9.md"),
      /no question with index 9/,
    );
  });
});

describe("an answer card's claims count registrable domains (goal 162)", () => {
  test("two hosts of one owner are one domain, so a claim citing both is not corroborated", async (t) => {
    const r = await makeResearchRun(RUN);
    t.after(() => r.close());
    const ledger = r.env.service.ledger;
    const src = seedSources(ledger, RUN, ["docs.example.com", "blog.example.com"]);
    seedClaims(ledger, RUN, {
      question: 0,
      n: 1,
      sources: [...src.values()],
      from: Date.now(),
      tag: "rd",
    });
    const api = createHarnessApi(r.env.service, tokens);
    const res = await api.request("/v1/research/cards/pending", {
      headers: { authorization: `Bearer ${tokens.supervisor}` },
    });
    const [pkg] = ((await res.json()) as { runs: CardsPackage[] }).runs;
    const claim = pkg?.questions[0]?.new_claims[0];
    assert.deepEqual(claim?.domains, ["example.com"]);
    assert.equal(claim?.corroborated, false);
  });
});
