import { registrableDomain } from "../../../agents/tools/index.ts";
import type { ResearchContract } from "../../../core/contract.ts";
import { MEASURES_NOTHING, questionLabel } from "../../../core/research-check.ts";
import type { Ledger } from "../../ledger/index.ts";
import { type CardGap, cardsOf, rubricOf } from "../cards.ts";
import { itemsState, requiredHypotheses } from "./items.ts";
import { clip, listOf } from "./shared.ts";

/**
 * What the review panel gets for a research review (goal 117): the run's items, with the claims
 * they cite, shortened in steps it states when it would be too long.
 */

/** The most characters of a research review's package (the reviewers read the rest with tools). */
export const RESEARCH_PACKAGE_MAX = 200_000;
/** The most characters of each quote a package shows, and the most quotes of each claim. */
export const PACKAGE_QUOTE_MAX = 400;
export const PACKAGE_QUOTES = 3;

/** What every reviewer is asked to check, the same for every research run. */
export const RESEARCH_CRITERIA = [
  "Decide only the items in decide: each question there, by its index, and each hypothesis there, by its id. The other items have a decision of the review panel that stands; they are shown for context.",
  "A question is answered when the verified claims, together, give a direct answer to it, judged against its rubric. Give its certainty: high when verified claims from independent domains agree and answer it directly; moderate when they answer it from one domain, or leave small gaps; low when they answer it only in part, or disagree. An answered question cites the claims its answer rests on.",
  "A question is insufficient when its claims give the best answer that sources allow and what is still missing could come only from a measurement: give that best answer, and name what is missing in next_experiments.",
  "A question is open when a source could still close a gap in its evidence: name each such gap in gaps, with the kind of source that could close it.",
  "An answer uses only what the claims it cites say. Every number in an answer must be in those claims, in their text or in their quotes.",
  "A hypothesis is supported or refuted only by the claims a verdict cites. When the claims do not decide it, it is undecided: say why.",
  "A claim from fewer independent domains than the run asks for is weaker evidence. Say so when an answer rests on such claims alone.",
  `${MEASURES_NOTHING} So what only a measurement could settle, such as a test on the hardware the question is about or a benchmark, is a next experiment, never an evidence gap: a question whose only gaps are measurements is insufficient, not open.`,
  "Each item is decided by the verdict that more than half of the reviewers give whose answer passes the harness's check; without such a majority it is open (a hypothesis: undecided), and the other reviewers' verdicts are kept as dissent. A decision stands until the question's answer card changes.",
];

export interface PackageClaim {
  id: string;
  text: string;
  /** Its quotes, each cut to PACKAGE_QUOTE_MAX characters (a cut ends with "…"). */
  quotes: string[];
  /** Quotes of the claim left out (more than PACKAGE_QUOTES, or to keep the package short). */
  quotes_not_shown?: number;
  /** The registrable domains its quotes' sources come from (docs.example.com: example.com). */
  domains: string[];
  /** From at least the contract's number of independent domains. */
  corroborated: boolean;
}

/** An item's decision that stands, as a package shows it. */
export interface PackageStanding {
  decision: string;
  certainty: string | null;
  review: number;
  card_version: number | null;
  decided_at: string;
}

/** One question in a research review's package: its newest card, with the claims it cites. */
export interface PackageQuestion {
  index: number;
  /** "Question 1 (index 0)". */
  label: string;
  text: string;
  /** What an answer must cover: the contract's rubric, else the question. */
  rubric: string;
  /** To decide in this review: it has no standing decision. */
  decide: boolean;
  /** The newest answer card; null: none (a package asked before every question had one). */
  card: {
    version: number;
    answer: string;
    certainty: string;
    gaps: CardGap[];
    created_at: string;
  } | null;
  /** The verified claims the card cites. */
  claims: PackageClaim[];
  /** Claims the card cites left out to keep the package short. */
  claims_not_shown?: number;
  /** All the question's verified claims (read the others with the tools). */
  verified_claims: number;
  /** The decision that stands, when the question has one. */
  standing?: PackageStanding;
}

/** One required hypothesis in a research review's package. */
export interface PackageHypothesis {
  id: string;
  text: string;
  status: string;
  /** The question it is about, an index from 0; null: the whole run. */
  question: number | null;
  /** To decide in this review: it has no standing decision. */
  decide: boolean;
  supporting: PackageClaim[];
  supporting_not_shown?: number;
  standing?: PackageStanding;
}

/** What the review panel gets for a research review: the run's items, with no lane or model. */
export interface ResearchPackage {
  kind: "research";
  title: string;
  topic: string;
  criteria: string[];
  /** The items to decide: those with no standing decision. The others stand. */
  decide: { questions: number[]; hypotheses: string[] };
  corpus: {
    sources: number;
    domains: number;
    verified_claims: number;
    corroborated_claims: number;
    findings: number;
    min_independent_domains: number;
  };
  /** Said when claims or quotes were left out to fit. */
  shortened?: string;
  /** Every question, in order. */
  questions: PackageQuestion[];
  /** The required hypotheses (the author's and promoted ones), those to decide first. */
  hypotheses: PackageHypothesis[];
}

/** Each source's registrable domain in a run, by its id. */
function sourceDomains(ledger: Ledger, run: string): Map<string, string> {
  return new Map(
    ledger.sources
      .ofRun(run)
      .map((s) => [s.id, s.domain ? registrableDomain(s.domain) : ""] as const),
  );
}

export interface ClaimRow {
  id: string;
  question: number | null;
  text: string;
  quotes: { source: string; quote: string }[];
  domains: string[];
  corroborated: boolean;
}

/** A run's verified claims, by id, with their sources' registrable domains. */
export function verifiedClaims(ledger: Ledger, run: string, min: number): Map<string, ClaimRow> {
  const domains = sourceDomains(ledger, run);
  return new Map(
    ledger.claims.verified(run).map((c) => {
      const quotes = listOf<{ source: string; quote: string }>(c.quotes);
      const ds = [...new Set(quotes.map((q) => domains.get(String(q.source)) ?? ""))].filter(
        Boolean,
      );
      return [
        c.id,
        {
          id: c.id,
          question: c.question,
          text: c.text,
          quotes,
          domains: ds,
          corroborated: ds.length >= min,
        },
      ];
    }),
  );
}

/** How much of each claim a package shows (the shorter forms keep it within RESEARCH_PACKAGE_MAX). */
interface Shown {
  /** Quotes of the claims of items whose decision stands. */
  standingQuotes: boolean;
  /** Claims of items whose decision stands. */
  standingClaims: boolean;
  /** Quotes of the claims of items to decide. */
  quotes: boolean;
  /** The most claims each item to decide shows. */
  perItem: number;
}

/**
 * The package of a research review (goal 117): the topic, the criteria, which items to decide,
 * the run's figures, every question with its newest card, the claims the card cites (their text,
 * quotes cut to PACKAGE_QUOTE_MAX characters, their sources' domains and whether they are
 * corroborated), its rubric and its standing decision, and every required hypothesis with its
 * supporting claims and standing decision, those to decide first. Nothing about which lane or
 * model wrote what. When it would be longer than RESEARCH_PACKAGE_MAX characters, the claims of
 * the items that stand lose their quotes and then go, then every claim loses its quotes, and then
 * each item shows fewer claims; `shortened` says so, and each item says how many it left out.
 */
export function researchPackage(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
): ResearchPackage {
  const min = contract.quality.min_independent_sources;
  const n = contract.questions.length;
  const claims = verifiedClaims(ledger, run, min);
  const { standing, decide } = itemsState(ledger, run, n);
  const cards = new Map(cardsOf(ledger, run).map((c) => [c.question, c]));
  const hypotheses = requiredHypotheses(ledger, run);
  const standingOf = (key: string): PackageStanding | undefined => {
    const d = standing.get(key);
    return d
      ? {
          decision: d.decision,
          certainty: d.certainty,
          review: d.review,
          card_version: d.card_version,
          decided_at: d.decided_at,
        }
      : undefined;
  };
  const verifiedCount = new Map<number, number>();
  for (const c of claims.values())
    if (c.question !== null)
      verifiedCount.set(c.question, (verifiedCount.get(c.question) ?? 0) + 1);
  const toClaim = (c: ClaimRow, quotes: boolean): PackageClaim => {
    const shown = quotes ? c.quotes.slice(0, PACKAGE_QUOTES) : [];
    return {
      id: c.id,
      text: c.text,
      quotes: shown.map((q) => clip(q.quote, PACKAGE_QUOTE_MAX)),
      ...(shown.length < c.quotes.length
        ? { quotes_not_shown: c.quotes.length - shown.length }
        : {}),
      domains: c.domains,
      corroborated: c.corroborated,
    };
  };
  /** The claims of an item, as much as `s` shows; and how many of them it left out. */
  const claimsOf = (ids: string[], stands: boolean, s: Shown) => {
    const all = [...new Set(ids)].flatMap((id) => {
      const c = claims.get(id);
      return c ? [c] : [];
    });
    if (stands && !s.standingClaims) return { shown: [], not: all.length };
    const quotes = stands ? s.standingQuotes : s.quotes;
    const cut = stands ? all : all.slice(0, s.perItem);
    return { shown: cut.map((c) => toClaim(c, quotes)), not: all.length - cut.length };
  };
  const corpus = {
    sources: ledger.sources.count(run),
    domains: new Set([...sourceDomains(ledger, run).values()].filter(Boolean)).size,
    verified_claims: claims.size,
    corroborated_claims: [...claims.values()].filter((c) => c.corroborated).length,
    findings: ledger.claims.countFindings(run, true),
    min_independent_domains: min,
  };
  const build = (s: Shown, shortened: string | undefined): ResearchPackage => ({
    kind: "research",
    title: contract.title,
    topic: contract.topic,
    criteria: RESEARCH_CRITERIA,
    decide,
    corpus,
    ...(shortened ? { shortened } : {}),
    questions: contract.questions.map((text, index): PackageQuestion => {
      const card = cards.get(index);
      const st = standingOf(`question:${index}`);
      const toDecide = decide.questions.includes(index);
      const cl = claimsOf(card?.claims ?? [], !toDecide, s);
      return {
        index,
        label: questionLabel(index),
        text,
        rubric: rubricOf(contract, index),
        decide: toDecide,
        card: card
          ? {
              version: card.version,
              answer: card.answer,
              certainty: card.certainty,
              gaps: card.gaps,
              created_at: card.created_at,
            }
          : null,
        claims: cl.shown,
        ...(cl.not ? { claims_not_shown: cl.not } : {}),
        verified_claims: verifiedCount.get(index) ?? 0,
        ...(st ? { standing: st } : {}),
      };
    }),
    hypotheses: [
      ...hypotheses.filter((h) => decide.hypotheses.includes(h.id)),
      ...hypotheses.filter((h) => !decide.hypotheses.includes(h.id)),
    ].map((h): PackageHypothesis => {
      const st = standingOf(`hypothesis:${h.id}`);
      const toDecide = decide.hypotheses.includes(h.id);
      const cl = claimsOf(h.supporting, !toDecide, s);
      return {
        id: h.id,
        text: h.text,
        status: h.status,
        question: h.question,
        decide: toDecide,
        supporting: cl.shown,
        ...(cl.not ? { supporting_not_shown: cl.not } : {}),
        ...(st ? { standing: st } : {}),
      };
    }),
  });
  const most = Math.max(
    1,
    ...[...cards.values()].map((c) => c.claims.length),
    ...hypotheses.map((h) => h.supporting.length),
  );
  const steps: { s: Shown; said: string }[] = [
    {
      s: { standingQuotes: false, standingClaims: true, quotes: true, perItem: most },
      said: "the claims of the items whose decision stands are shown without their quotes",
    },
    {
      s: { standingQuotes: false, standingClaims: false, quotes: true, perItem: most },
      said: "the claims of the items whose decision stands are not shown (claims_not_shown and supporting_not_shown count them)",
    },
    {
      s: { standingQuotes: false, standingClaims: false, quotes: false, perItem: most },
      said: "the claims of the items whose decision stands are not shown, and the other claims are shown without their quotes",
    },
  ];
  for (let k = Math.ceil(most / 2); k >= 1; k = k === 1 ? 0 : Math.ceil(k / 2))
    steps.push({
      s: { standingQuotes: false, standingClaims: false, quotes: false, perItem: k },
      said: `the claims of the items whose decision stands are not shown, and each item to decide shows its first ${k} cited ${k === 1 ? "claim" : "claims"}, without quotes (claims_not_shown and supporting_not_shown count the rest)`,
    });
  let pkg = build(
    { standingQuotes: true, standingClaims: true, quotes: true, perItem: most },
    undefined,
  );
  for (const step of steps) {
    if (JSON.stringify(pkg).length <= RESEARCH_PACKAGE_MAX) break;
    pkg = build(
      step.s,
      `To keep this package short, ${step.said}. When you have the tools, read every claim, quote and source of the run with them.`,
    );
  }
  return pkg;
}

/** A question to decide in a package (one asked before goal 117 has no `decide`: all of them). */
export function toDecide(
  pkg: Partial<Pick<ResearchPackage, "decide">> & {
    questions?: { index: number }[];
    hypotheses?: { id: string }[];
  },
): { questions: number[]; hypotheses: string[] } {
  if (pkg.decide) return pkg.decide;
  return {
    questions: (pkg.questions ?? []).map((q) => q.index),
    hypotheses: (pkg.hypotheses ?? []).map((h) => h.id),
  };
}
