import type { ClaimRow, Ledger } from "../ledger/index.ts";

/**
 * The checks research text shares (goal 112): a finding a worker records and an answer the review
 * panel gives are both held to them. Code runs them; the agents cannot.
 */

/** The typographic marks a quote is compared without: each class, and the plain mark for it. */
const PLAIN_MARKS: readonly (readonly [RegExp, string])[] = [
  [/[‘’‛′]/g, "'"],
  [/[“”‟″]/g, '"'],
  [/[‐-―−]/g, "-"],
  [/ /g, " "],
];

/** Whitespace folded, typographic quotes and dashes made plain: "verbatim" up to layout. */
export function normalizeQuote(s: string): string {
  let out = s;
  for (const [marks, plain] of PLAIN_MARKS) out = out.replace(marks, plain);
  return out.replace(/\s+/g, " ").trim();
}

/**
 * A text as normalizeQuote makes it, with where each of its characters is in the text: the same
 * rules, one character at a time.
 */
export function normalizedWithPlaces(text: string): { text: string; at: number[] } {
  const one = PLAIN_MARKS.map(([marks, plain]) => [new RegExp(marks.source), plain] as const);
  const out: string[] = [];
  const at: number[] = [];
  let space = -1;
  for (let i = 0; i < text.length; i++) {
    let c = text[i] as string;
    for (const [marks, plain] of one) if (marks.test(c)) c = plain;
    if (/\s/.test(c)) {
      if (space < 0) space = i;
      continue;
    }
    // A run of whitespace is one space, none at the start or the end.
    if (space >= 0 && out.length) {
      out.push(" ");
      at.push(space);
    }
    space = -1;
    out.push(c);
    at.push(i);
  }
  return { text: out.join(""), at };
}

/**
 * Where a quote is in a text as add_claim checks it (normalizeQuote on both): each place, in the
 * text's own characters, from `start` to `end`, the first `max`. None when the quote is not there.
 */
export function quotePlaces(
  text: string,
  quote: string,
  max: number,
): { start: number; end: number }[] {
  const q = normalizeQuote(quote);
  if (!q) return [];
  const n = normalizedWithPlaces(text);
  const out: { start: number; end: number }[] = [];
  for (let i = n.text.indexOf(q); i >= 0 && out.length < max; i = n.text.indexOf(q, i + 1))
    out.push({ start: n.at[i] as number, end: (n.at[i + q.length - 1] as number) + 1 });
  return out;
}

/**
 * A text's words for telling a repeat (claims, findings, notes and hypotheses, goal 117): quotes,
 * dashes and spaces made plain, lowercase, punctuation taken out, one space between words.
 */
export function foldText(s: string): string {
  return normalizeQuote(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Numbers as written (1,200 and 3.5 and 42), for checking claims, findings and answers. */
export function numbersIn(s: string): string[] {
  return [...s.matchAll(/\d[\d,.]*\d|\d/g)].map((m) => m[0]);
}

/**
 * A text with what is not a stated number taken out: record ids (c-…, h-…, f-…), question
 * references ("question 2", "questions 1 and 3", "Q2"), a list item's own number, and digits that
 * are part of a name (sm_50, V100, M10). A number followed by its unit (4GB, 10x) stays.
 */
export function withoutReferences(text: string): string {
  return withoutNames(
    text
      .replace(/\b[a-z]-(?=[0-9a-z]*\d)[0-9a-z]{6,}\b/g, " ")
      .replace(/\bquestions?\s+\d+(?:\s*(?:,|and|or|to|–|-)\s*\d+)*/gi, " ")
      .replace(/\bQ\d+\b/g, " ")
      .replace(/^\s*(?:[-*+]\s+)?\d+[.)]\s+/gm, " "),
  );
}

/** A text without the digits that are part of a name (sm_50, V100, M10): they state no number. */
export function withoutNames(text: string): string {
  return text.replace(/(?<=[A-Za-z_])\d[\d.]*/g, " ");
}

/** The numbers a text states, as checks read them: numbersIn after withoutReferences. */
export function statedNumbers(text: string): string[] {
  return numbersIn(withoutReferences(text));
}

/** Every number a verified claim states: in its text or in its quotes. */
export function claimNumbers(claims: Pick<ClaimRow, "text" | "quotes">[]): Set<string> {
  return new Set(
    claims.flatMap((cl) => [
      ...numbersIn(cl.text),
      ...(JSON.parse(cl.quotes) as { quote: string }[]).flatMap((q) => numbersIn(q.quote)),
    ]),
  );
}

/**
 * Text that cites claims, checked: every cited id must be a verified claim of the run, and every
 * number in the texts must appear in those claims (their text or their quotes), or in `also`: the
 * numbers the harness itself gives the text's writer, such as a research paper's corpus figures.
 * Returns the verified claims cited and each problem in words; no problem means the text holds.
 */
export function checkCited(
  ledger: Ledger,
  run: string,
  cited: string[],
  texts: string[],
  also: Iterable<string> = [],
): { claims: ClaimRow[]; problems: string[] } {
  const problems: string[] = [];
  const claims: ClaimRow[] = [];
  for (const id of [...new Set(cited)]) {
    const cl = ledger.claims.get(run, id);
    if (!cl) problems.push(`no claim ${id}`);
    else if (!cl.verified) problems.push(`claim ${id} is a draft, not verified`);
    else claims.push(cl);
  }
  const known = claimNumbers(claims);
  for (const n of also) known.add(n);
  for (const num of new Set(texts.flatMap(statedNumbers))) {
    if (!known.has(num)) problems.push(`the number ${num} is not in the claims it cites`);
  }
  return { claims, problems };
}
