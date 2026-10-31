import { registrableDomain } from "../../agents/tools/index.ts";
import {
  CARD_ANSWER_MAX,
  CARD_CLAIMS_MAX,
  CARD_GAP_MAX,
  CARD_GAPS_MAX,
  CARD_WHY_MAX,
  CardInput,
  type CardSubmission,
  CERTAINTIES,
  type Certainty,
  GAP_KINDS,
  type GapKind,
} from "../../core/api/harness/research.ts";
import type { ResearchContract } from "../../core/contract.ts";
import { MEASURES_NOTHING, questionLabel } from "../../core/research-check.ts";
import { type CardRow, type ClaimRow, type Ledger, LedgerError } from "../ledger/index.ts";
import { checkCited } from "./checks.ts";

/** A card's wire words and limits (their home: core/api/harness/research.ts). */
export { CARD_ANSWER_MAX, CARD_GAP_MAX, CardInput, type CardSubmission, questionLabel };

/**
 * Answer cards (goal 117): the harness keeps one card for each question of a research run, as
 * versions in `question_card` (ledger migration 21; append-only, the newest version is the card).
 * A card holds the current answer in a few paragraphs, its certainty, the verified claims it
 * cites and its open gaps, each a gap in the evidence (a kind of source could close it) or a
 * measurement (a next experiment for a goal or hill-climb run: research does not close it).
 *
 * The supervisor's synthesizer writes the cards. The harness lists, for each running research
 * run, the questions whose evidence changed since their card (`pending`), and checks each card
 * the synthesizer posts (`submit`), in code the synthesizer cannot change: every claim it cites is
 * a verified claim of the run and of that question (or the card says why it borrows it), every
 * number in its answer is in those claims, its certainty is one of the scale's words, its gaps
 * have a kind and bounded words, and its answer is bounded. A card that fails is not kept: the
 * old version stands, and the problems go back with the next request. Workers read the cards in
 * their brief and in the research folder (cards/q<index>.md); they never write them.
 *
 * Which claims are new to a card: each card records the newest claim of its question it was given
 * (`through`, in its `card_written` event), and every verified claim of the question recorded
 * after that one, by time and then id, is new. Claims recorded while the synthesizer worked are
 * new to the next request, never lost; claims cut from a request to keep it short come in the
 * next one.
 */

/** The most characters of one run's request for cards (the synthesizer reads the rest with tools). */
export const CARDS_PACKAGE_MAX = 150_000;
/** The most characters of a card's answer that a worker's brief shows (the card file is whole). */
export const BRIEF_ANSWER_CHARS = 1200;

/** The events: a card the harness kept, and one it refused, with its problems. */
export const CARD_WRITTEN = "card_written";
export const CARD_REFUSED = "card_refused";

/** Each certainty in words: the synthesizer rates by them, and the pages say them. */
export const CERTAINTY_WORDS: Record<Certainty, string> = {
  high: "verified claims from independent domains agree, and together they answer the question directly",
  moderate:
    "verified claims answer the question, but they come from one domain, or they leave small gaps",
  low: "verified claims answer the question only in part, or they disagree",
  insufficient:
    "the best answer the sources allow: what is missing cannot come from a source, only from a measurement, named as a gap of kind measurement",
  none: "no verified claim answers the question yet",
};

/** The rules a card is checked against, in words: the synthesizer's request carries them. */
export const CARD_RULES = [
  "Write one card for each question in this request, by its index. A card replaces the question's current card; the current card and the question's new verified claims are what you rewrite it from.",
  `answer: the current best answer to the question, in a few paragraphs (at most ${CARD_ANSWER_MAX.toLocaleString("en-US")} characters), judged against the question's rubric, from the verified claims you cite only.`,
  `certainty: one of ${CERTAINTIES.join(", ")}. A certainty other than none cites at least one claim.`,
  `claims: the ids of the verified claims the answer rests on (c-…), at most ${CARD_CLAIMS_MAX}. Each must be a verified claim of the run, recorded for this question. A claim recorded for another question, or for none, may be cited too: give its id and why it bears on this question in borrowed (at most ${CARD_WHY_MAX} characters).`,
  "Every number in the answer must be in the claims it cites, in their text or their quotes. Record ids (c-…) and question numbers are not checked.",
  `gaps: what the answer still lacks, at most ${CARD_GAPS_MAX}, each {kind, text} with at most ${CARD_GAP_MAX} characters. kind evidence: a source could close it; say which kind of source. kind measurement: only a measurement could settle it; say the next experiment, for a goal or hill-climb run.`,
  MEASURES_NOTHING,
];

export interface CardGap {
  kind: GapKind;
  text: string;
}

/** A card as the harness keeps it. */
export interface Card {
  question: number;
  version: number;
  answer: string;
  certainty: Certainty;
  claims: string[];
  gaps: CardGap[];
  by: string;
  created_at: string;
}

const list = <T>(json: unknown): T[] => {
  try {
    const v = JSON.parse(String(json ?? "[]")) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const cardOfRow = (r: CardRow): Card => ({
  question: Number(r.question),
  version: Number(r.version),
  answer: String(r.answer),
  certainty: String(r.certainty) as Certainty,
  claims: list<string>(r.claims).map(String),
  gaps: list<CardGap>(r.gaps),
  by: String(r.by),
  created_at: String(r.created_at),
});

/** A question's rubric: the contract's `rubrics` entry, else the question itself. */
export function rubricOf(contract: Pick<ResearchContract, "questions" | "rubrics">, i: number) {
  return contract.rubrics?.[i] ?? contract.questions[i] ?? "";
}

/** The newest card of each question of a run that has one, by question. */
export function cardsOf(ledger: Ledger, run: string): Card[] {
  return ledger.cards.newestOfEach(run).map(cardOfRow);
}

/** A question's card: its newest version, if it has one. */
/**
 * When a question's card is written again: once this many new verified claims came since it, or
 * once it is this old and any came. A question with no card is asked at once. Without it the
 * synthesizer would be called in nearly every supervisor round while claims arrive.
 */
export const CARD_PACE = { claims: 5, ms: 30 * 60_000 };

export function cardOf(ledger: Ledger, run: string, question: number): Card | undefined {
  const r = ledger.cards.newest(run, question);
  return r ? cardOfRow(r) : undefined;
}

/** Every version of a question's card, the first first. */
export function cardHistory(ledger: Ledger, run: string, question: number): Card[] {
  return ledger.cards.history(run, question).map(cardOfRow);
}

/** A claim as a request for cards shows it: its words, its sources' domains, and when. */
export interface CardClaim {
  id: string;
  text: string;
  domains: string[];
  /** From at least the contract's number of independent domains. */
  corroborated: boolean;
  at: string;
}

/** One question in the synthesizer's request: its card, what is new since, and its rubric. */
export interface CardsQuestion {
  index: number;
  /** "Question 1 (index 0)". */
  label: string;
  text: string;
  /** What an answer must cover: the contract's rubric, else the question. */
  rubric: string;
  /** The current card; null: the question has none yet. */
  card: Omit<Card, "question"> | null;
  /** The claims the current card cites, with their words. */
  card_claims: CardClaim[];
  /** Claims the current card cites that are left out here to keep the request short. */
  card_claims_not_shown?: number;
  /** The newest refusal of a card for this question since its current card: fix these first. */
  last_refusal?: { at: string; problems: string[] };
  /** All the question's verified claims. */
  verified_claims: number;
  /** The question's verified claims recorded since its card was written, the oldest first. */
  new_claims: CardClaim[];
  /** How many new claims there are; those not shown come in the next request. */
  new_claims_total: number;
  new_claims_not_shown?: number;
  /** The newest new claim shown: the supervisor posts it back with the card. */
  through: string | null;
}

/** What the synthesizer gets for one run: each question whose evidence changed since its card. */
export interface CardsPackage {
  kind: "cards";
  run: string;
  title: string;
  topic: string;
  rules: string[];
  certainty: Record<Certainty, string>;
  min_independent_domains: number;
  questions: CardsQuestion[];
  /** Said when claims were left out to keep the request short. */
  shortened?: string;
}

/** The answer for each card posted: kept, with its version, or refused, with its problems. */
export type CardResult =
  | { question: number; accepted: true; version: number }
  | { question: number; accepted: false; problems: string[] };

/** A card checked by code, before it is kept: each problem in words, none when the card holds. */
export function checkCard(ledger: Ledger, run: string, c: CardInput): string[] {
  const problems: string[] = [];
  const answer = c.answer.trim();
  if (!answer) problems.push("the answer is empty");
  if (c.answer.length > CARD_ANSWER_MAX)
    problems.push(
      `the answer has ${c.answer.length.toLocaleString("en-US")} characters: a card's answer has at most ${CARD_ANSWER_MAX.toLocaleString("en-US")}, a few paragraphs`,
    );
  if (!(CERTAINTIES as readonly string[]).includes(c.certainty))
    problems.push(
      `the certainty "${clip(c.certainty, 40)}" is not one of ${CERTAINTIES.join(", ")}`,
    );
  const cited = [...new Set(c.claims)];
  if (cited.length > CARD_CLAIMS_MAX)
    problems.push(`the card cites ${cited.length} claims: at most ${CARD_CLAIMS_MAX}`);
  if (c.certainty !== "none" && cited.length === 0)
    problems.push(
      `a card with certainty ${clip(c.certainty, 40)} cites at least one verified claim; with no claim to cite, its certainty is none`,
    );
  // Every cited claim a verified claim of the run, and every number of the answer in them.
  const checked = checkCited(ledger, run, cited, [c.answer]);
  problems.push(...checked.problems);
  // Of this question, or borrowed with why.
  const why = new Map(c.borrowed.map((b) => [b.claim, b.why.trim()]));
  for (const cl of checked.claims) {
    const id = String(cl.id);
    if (cl.question !== null && Number(cl.question) === c.question) continue;
    const reason = why.get(id);
    const of =
      cl.question === null
        ? "is recorded for no question"
        : `is recorded for question ${Number(cl.question) + 1} (index ${Number(cl.question)})`;
    if (!reason) problems.push(`claim ${id} ${of}: say in borrowed why this card cites it`);
    else if (reason.length > CARD_WHY_MAX)
      problems.push(
        `why the card borrows claim ${id} has ${reason.length} characters: at most ${CARD_WHY_MAX}`,
      );
  }
  for (const b of c.borrowed)
    if (!cited.includes(b.claim))
      problems.push(`borrowed names claim ${clip(b.claim, 60)}, which the card does not cite`);
  // The gaps: a kind each, and bounded words.
  if (c.gaps.length > CARD_GAPS_MAX)
    problems.push(`the card names ${c.gaps.length} gaps: at most ${CARD_GAPS_MAX}`);
  c.gaps.forEach((g, i) => {
    const which = `gap ${i + 1}`;
    if (!(GAP_KINDS as readonly string[]).includes(g.kind))
      problems.push(
        `${which}'s kind "${clip(g.kind, 40)}" is not evidence (a source could close it) or measurement (only a measurement could settle it)`,
      );
    if (!g.text.trim()) problems.push(`${which} has no words`);
    else if (g.text.length > CARD_GAP_MAX)
      problems.push(`${which} has ${g.text.length} characters: at most ${CARD_GAP_MAX}`);
  });
  // The newest claim the card's request gave: a verified claim of this question.
  if (c.through !== null) {
    const t = ledger.claims.get(run, c.through);
    if (!t?.verified || t.question === null || t.question !== c.question)
      problems.push(
        `through ${clip(c.through, 60)} is not a verified claim of question ${c.question + 1} (index ${c.question}): post back the through the request gave`,
      );
  }
  return problems;
}

/** A card without its question's index, as a request shows it under its question. */
const withoutQuestion = (c: Card): Omit<Card, "question"> => ({
  version: c.version,
  answer: c.answer,
  certainty: c.certainty,
  claims: c.claims,
  gaps: c.gaps,
  by: c.by,
  created_at: c.created_at,
});

/** A claim of the run, with its sources' domains, for a request. */
function claimFor(ledger: Ledger, run: string, cl: ClaimRow, min: number): CardClaim {
  const ids = [...new Set(list<{ source: string }>(cl.quotes).map((q) => q.source))];
  const domains = new Set<string>();
  for (const id of ids) {
    const d = ledger.sources.get(run, id)?.domain;
    // Registrable domains, as the review package and the report count them: one owner, one domain.
    if (d) domains.add(registrableDomain(d));
  }
  return {
    id: cl.id,
    text: cl.text,
    domains: [...domains],
    corroborated: domains.size >= min,
    at: cl.created_at,
  };
}

/** A research run's answer cards: the synthesizer's request, and each card it posts checked by code. */
export class Cards {
  private readonly ledger: Ledger;
  private readonly contractFor: (run: string) => unknown;

  constructor(ledger: Ledger, contractFor: (run: string) => unknown) {
    this.ledger = ledger;
    this.contractFor = contractFor;
  }

  private contract(run: string): ResearchContract {
    const c = this.contractFor(run) as ResearchContract | undefined;
    if (c?.mode !== "research") throw new LedgerError("invalid", `${run} is not a research run`);
    return c;
  }

  /**
   * Where a question's new claims start: the newest claim a kept card of it was given (by time,
   * then id), or nothing when no card was given one: then every verified claim is new.
   */
  private cursor(run: string, question: number): { at: string; id: string } | undefined {
    const written = this.ledger.events.newest(CARD_WRITTEN, {
      subject: run,
      body: { question },
      has: ["through"],
    });
    if (!written) return undefined;
    const through = String(written.body.through);
    const cl = this.ledger.claims.get(run, through);
    return cl ? { at: cl.created_at, id: through } : undefined;
  }

  /** A question's verified claims after its cursor, the oldest first. */
  private newClaims(run: string, question: number): ClaimRow[] {
    return this.ledger.claims.verifiedAfter(run, question, this.cursor(run, question));
  }

  /** The newest refusal of a card for a question, when it came after the question's card. */
  lastRefusal(run: string, question: number): { at: string; problems: string[] } | undefined {
    const q = { subject: run, body: { question } };
    const refused = this.ledger.events.newest(CARD_REFUSED, q);
    if (!refused) return undefined;
    const written = this.ledger.events.newest(CARD_WRITTEN, q);
    if (written && written.id > refused.id) return undefined;
    const p = refused.body.problems;
    return { at: refused.at, problems: (Array.isArray(p) ? p : []).map(String) };
  }

  /** The questions of a run whose evidence changed since their card, as one request. */
  package(run: string, now = Date.now()): CardsPackage | undefined {
    const contract = this.contract(run);
    const min = contract.quality.min_independent_sources;
    const counts = this.ledger.claims.verifiedByQuestion(run);
    const items = contract.questions.flatMap((text, index) => {
      const fresh = this.newClaims(run, index);
      if (!fresh.length) return [];
      const card = cardOf(this.ledger, run, index);
      // Paced (CARD_PACE): a card is written again once enough new claims came, or once it is old
      // enough; a question with no card yet is asked at once.
      if (
        card &&
        fresh.length < CARD_PACE.claims &&
        now - Date.parse(card.created_at) < CARD_PACE.ms
      )
        return [];
      const cited = card
        ? card.claims.flatMap((id) => {
            const cl = this.ledger.claims.get(run, id);
            return cl ? [claimFor(this.ledger, run, cl, min)] : [];
          })
        : [];
      return [
        {
          index,
          text,
          card,
          cited,
          fresh: fresh.map((cl) => claimFor(this.ledger, run, cl, min)),
          refusal: this.lastRefusal(run, index),
          verified: counts.get(index) ?? 0,
        },
      ];
    });
    if (!items.length) return undefined;
    const build = (perNew: number, perCited: number): CardsPackage => {
      const cut = items.some((q) => q.fresh.length > perNew || q.cited.length > perCited);
      return {
        kind: "cards",
        run,
        title: contract.title,
        topic: contract.topic,
        rules: CARD_RULES,
        certainty: CERTAINTY_WORDS,
        min_independent_domains: min,
        questions: items.map((q): CardsQuestion => {
          const fresh = q.fresh.slice(0, perNew);
          const cited = q.cited.slice(0, perCited);
          return {
            index: q.index,
            label: questionLabel(q.index),
            text: q.text,
            rubric: rubricOf(contract, q.index),
            card: q.card ? withoutQuestion(q.card) : null,
            card_claims: cited,
            ...(cited.length < q.cited.length
              ? { card_claims_not_shown: q.cited.length - cited.length }
              : {}),
            ...(q.refusal ? { last_refusal: q.refusal } : {}),
            verified_claims: q.verified,
            new_claims: fresh,
            new_claims_total: q.fresh.length,
            ...(fresh.length < q.fresh.length
              ? { new_claims_not_shown: q.fresh.length - fresh.length }
              : {}),
            through: fresh.at(-1)?.id ?? null,
          };
        }),
        ...(cut
          ? {
              shortened:
                "Some claims are not shown, to keep this request short. A question's new claims are shown the oldest first: those not shown (new_claims_not_shown) come in the next request, once this card is kept. Claims its card cites that are not shown (card_claims_not_shown) are in the card's claims. Read any claim with the tools when you have them: list_research with kind claim and the question's index, or search_research.",
            }
          : {}),
      };
    };
    const mostNew = Math.max(1, ...items.map((q) => q.fresh.length));
    const mostCited = Math.max(0, ...items.map((q) => q.cited.length));
    let perNew = Number.POSITIVE_INFINITY;
    let perCited = Number.POSITIVE_INFINITY;
    let pkg = build(perNew, perCited);
    while (JSON.stringify(pkg).length > CARDS_PACKAGE_MAX) {
      if (perNew > 1) perNew = Math.max(1, Math.ceil(Math.min(perNew, mostNew) / 2));
      else if (perCited > 0) perCited = Math.floor(Math.min(perCited, mostCited) / 2);
      else break;
      pkg = build(perNew, perCited);
    }
    return pkg;
  }

  /** For each running research run whose evidence changed since a card, its request. */
  pending(now = Date.now()): CardsPackage[] {
    return this.ledger.runs.ids("research", "running").flatMap((id) => {
      const pkg = this.package(id, now);
      return pkg ? [pkg] : [];
    });
  }

  /**
   * The cards the supervisor posts for a running research run, each checked by code on its own:
   * kept as the question's next version (`card_written`), or refused with its problems
   * (`card_refused`, which the question's next request carries). A card for a question the run
   * does not have is answered with its problem and recorded nowhere.
   */
  submit(run: string, input: CardSubmission, by: string): { results: CardResult[] } {
    const inst = this.ledger.runs.get(run);
    if (!inst) throw new LedgerError("not_found", `no run ${run}`);
    if (inst.status !== "running") throw new LedgerError("invalid", `run ${run} is ${inst.status}`);
    const contract = this.contract(run);
    const n = contract.questions.length;
    const seen = new Set<number>();
    const results = input.cards.map((c): CardResult => {
      if (c.question < 0 || c.question >= n)
        return {
          question: c.question,
          accepted: false,
          problems: [
            `there is no question with index ${c.question}: the run has ${n} (index 0 to ${n - 1})`,
          ],
        };
      const problems = seen.has(c.question)
        ? [`a second card for question ${c.question + 1} (index ${c.question}) in this request`]
        : checkCard(this.ledger, run, c);
      seen.add(c.question);
      if (problems.length) {
        this.ledger.appendEvent(by, CARD_REFUSED, run, {
          question: c.question,
          by: input.synthesizer,
          count: problems.length,
          problems: problems.slice(0, 20).map((p) => clip(p, 300)),
        });
        return { question: c.question, accepted: false, problems };
      }
      const claims = [...new Set(c.claims)];
      const gaps = c.gaps.map((g) => ({ kind: g.kind as GapKind, text: g.text.trim() }));
      const version = this.ledger.tx(() => {
        const v = this.ledger.cards.add({
          run,
          question: c.question,
          answer: c.answer.trim(),
          certainty: c.certainty,
          claims,
          gaps,
          by: input.synthesizer,
          at: new Date().toISOString(),
        });
        // The card whole (it is bounded), so control and the run's history have it from events.
        this.ledger.appendEvent(by, CARD_WRITTEN, run, {
          question: c.question,
          version: v,
          certainty: c.certainty,
          claims: claims.length,
          gaps: gaps.length,
          by: input.synthesizer,
          through: c.through,
          answer: c.answer.trim(),
          cited: claims,
          gap_list: gaps,
        });
        return v;
      });
      return { question: c.question, accepted: true, version };
    });
    return { results };
  }
}

/** A gap in words, as the brief, the card file and the report name it. */
export const gapWords = (g: CardGap) =>
  g.kind === "measurement"
    ? `Measurement (a next experiment for a goal or hill-climb run): ${g.text}`
    : `Evidence: ${g.text}`;

/**
 * The cards in a research worker's brief: each question's answer, certainty and open evidence
 * gaps (a measurement gap is never a worker's task). An answer longer than BRIEF_ANSWER_CHARS is
 * cut, and says where the whole card is.
 */
export function briefCards(
  ledger: Ledger,
  run: string,
  contract: Pick<ResearchContract, "questions">,
): string {
  const cards = new Map(cardsOf(ledger, run).map((c) => [c.question, c]));
  const counts = ledger.claims.verifiedByQuestion(run);
  const lines = [
    "Answer cards: the run's current answer to each question, which the synthesizer writes from verified claims and code checks. You add claims; you never edit a card. Fill a card's open evidence gaps first. Each card is whole in cards/q<index>.md of the research folder.",
  ];
  contract.questions.forEach((_, i) => {
    const c = cards.get(i);
    if (!c) {
      lines.push(
        `- ${questionLabel(i)}: no card yet (${counts.get(i) ?? 0} verified claims so far).`,
      );
      return;
    }
    const answer = c.answer.replace(/\s+/g, " ").trim();
    const shown =
      answer.length > BRIEF_ANSWER_CHARS
        ? `${answer.slice(0, BRIEF_ANSWER_CHARS - 1)}… (cut here: the whole answer is in cards/q${i}.md)`
        : answer;
    const open = c.gaps.filter((g) => g.kind === "evidence");
    lines.push(
      `- ${questionLabel(i)}, certainty ${c.certainty} (card version ${c.version}): ${shown}`,
      ...(open.length
        ? open.map((g) => `  Open evidence gap: ${g.text.replace(/\s+/g, " ").trim()}`)
        : ["  Open evidence gaps: none named."]),
    );
  });
  return lines.join("\n");
}

/**
 * A question's card file in the research folder (cards/q<index>.md): the question, its rubric,
 * the card whole with the claims it cites, its gaps, and its earlier versions. `claimText` names
 * a claim's words by its id, when the run has it.
 */
export function cardFile(
  contract: Pick<ResearchContract, "questions" | "rubrics">,
  index: number,
  history: Card[],
  verified: number,
  claimText: (id: string) => string | undefined,
): string {
  const c = history.at(-1);
  const head = [
    `# ${questionLabel(index)}`,
    "",
    (contract.questions[index] ?? "").trim(),
    "",
    `Rubric (what an answer must cover): ${rubricOf(contract, index).replace(/\s+/g, " ").trim()}`,
    "",
  ];
  if (!c)
    return [
      ...head,
      "## Answer card",
      "",
      `No card yet. The question has ${verified} verified claims so far. The supervisor's synthesizer writes its card from them, and code checks it.`,
      "",
    ].join("\n");
  return [
    ...head,
    `## Answer card: version ${c.version}, certainty ${c.certainty}`,
    "",
    `Written ${c.created_at} by ${c.by}. The synthesizer writes this card from the run's verified claims, and code checked it: every claim it cites is verified, and every number in the answer is in those claims. Workers add claims; they never edit a card. Certainty ${c.certainty}: ${CERTAINTY_WORDS[c.certainty] ?? ""}.`,
    "",
    c.answer,
    "",
    "## Claims it cites",
    "",
    ...(c.claims.length
      ? c.claims.map(
          (id) =>
            `- ${id} (claims/${id}.md): ${clip(claimText(id) ?? "(not in the run's records)", 300)}`,
        )
      : ["None."]),
    "",
    "## Open gaps",
    "",
    ...(c.gaps.length ? c.gaps.map((g) => `- ${gapWords(g)}`) : ["None named."]),
    "",
    ...(history.length > 1
      ? [
          "## Earlier versions",
          "",
          ...history
            .slice(0, -1)
            .reverse()
            .map(
              (h) =>
                `- version ${h.version}, certainty ${h.certainty}, ${h.created_at} by ${h.by}: ${clip(h.answer, 200)}`,
            ),
          "",
        ]
      : []),
  ].join("\n");
}

/**
 * The report's "## Answers" section: each question's card for people ("Question 1"), with its
 * certainty, its answer, the claims it cites and its open gaps. `fence` keeps the synthesizer's
 * words from making their own headings.
 */
export function answersSection(
  ledger: Ledger,
  run: string,
  contract: Pick<ResearchContract, "questions">,
  fence: (s: string) => string,
): string[] {
  const cards = new Map(cardsOf(ledger, run).map((c) => [c.question, c]));
  const counts = ledger.claims.verifiedByQuestion(run);
  const lines = [
    "## Answers",
    "",
    "Each question's answer card: the synthesizer writes it from the run's verified claims, and code checks it before it is kept (every claim it cites is a verified claim of this run, and every number in the answer is in those claims).",
    "",
  ];
  contract.questions.forEach((text, i) => {
    lines.push(`### Question ${i + 1}: ${fence(text).replace(/\n+/g, " ")}`, "");
    const c = cards.get(i);
    if (!c) {
      lines.push(`No answer card yet (${counts.get(i) ?? 0} verified claims).`, "");
      return;
    }
    lines.push(
      `Certainty: ${c.certainty}. Card version ${c.version}, written ${c.created_at} by ${c.by}.`,
      "",
      fence(c.answer),
      "",
      `Cites: ${c.claims.join(", ") || "no claim"}.`,
      "",
      ...(c.gaps.length
        ? ["Open gaps:", ...c.gaps.map((g) => `- ${fence(gapWords(g)).replace(/\n+/g, " ")}`), ""]
        : ["Open gaps: none named.", ""]),
    );
  });
  return lines;
}
