import type { Ledger } from "../../ledger/index.ts";
import { checkCited, numbersIn, withoutReferences } from "../checks.ts";
import { CITE, clip, FENCE, fold, HEADING, LIST_ITEM, TABLE_ROW } from "./markdown.ts";
import type { PaperFigures } from "./request.ts";

/** Code's checks of a research paper's text, in code the writer cannot change. */

/** The parts code appends to an accepted paper: the writer writes none of them. */
const APPENDED = ["references", "bibliography", "appendix", "review panel"];

/** A problem code found in a paper, at its line (1 first), or for the whole paper (null). */
export interface PaperProblem {
  line: number | null;
  problem: string;
}

const VERDICT = /^\s*(?:[-*+]\s*)?[*_]*verdict[*_]*\s*:\s*[*_]*(supported|refuted|undecided)\b/i;
const VERDICT_WORD = /^[*_\s]*(supported|refuted|undecided)[*_.\s]*$/i;

/** A table row's cells, without the outer pipes; a separator row (|---|) has none. */
function cellsOf(row: string): string[] {
  const t = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = t.split(/(?<!\\)\|/).map((c) => c.trim());
  return cells.every((c) => /^:?-{3,}:?$/.test(c)) ? [] : cells;
}

/** Whether a text names a record id as a whole word: h-a1 is not in h-a12. */
const names = (text: string, id: string) =>
  new RegExp(
    `(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`,
  ).test(text);

/** The claim ids a text cites, in order, each once. */
export function citationsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITE))
    for (const id of (m[1] as string).split(/[,;]/).map((x) => x.trim()))
      if (id && !out.includes(id)) out.push(id);
  return out;
}

/**
 * A paragraph's text with what is not a stated number taken out: its citations, record ids
 * (c-…, h-…, f-…), question numbers ("question 2", "Q2") and a list item's own number.
 */
function forNumbers(text: string): string {
  return withoutReferences(text.replace(CITE, " "));
}

/** A number as it may be written: 1200 and 1,200. */
const spellings = (n: number) => [String(n), n.toLocaleString("en-US")];

/** What a paper is checked against: the run's questions, required hypotheses and standing verdicts. */
export interface PaperBasis {
  review: number;
  questions: string[];
  /** Questions (indexes) with no verified claim: the paper need not cite evidence for them. */
  bare?: number[] | undefined;
  hypotheses: { id: string; text: string }[];
  /** Each hypothesis's standing verdict (goal 117). */
  verdicts: Map<string, Set<string>>;
  figures: PaperFigures;
  /**
   * Each question's evidence, by index (goal 117): its card's claims and the verified claims of the
   * question. The paper answers a question when it cites one of them. Without it, not checked.
   */
  evidence?: Set<string>[] | undefined;
  /** The hypotheses the run proposed that need no verdict, and get none (goal 117). */
  proposed?: { id: string; text: string }[] | undefined;
}

interface Line {
  n: number;
  text: string;
  fence: boolean;
  heading?: { level: number; text: string } | undefined;
}

interface Unit {
  line: number;
  text: string;
  heading: boolean;
}

/**
 * Code's checks of a paper (goal 112), with each problem at its line: its title, no part that code
 * appends, every question with a verified claim answered somewhere (the paper cites its evidence),
 * every cited id a verified claim of the run, every number in a paragraph in the claims it cites or
 * among the figures, and every verdict it gives a hypothesis one the review panel gave. The writer
 * chooses the paper's parts (owner, 2026-10-24); code does not check them. No problem: the paper
 * holds.
 */
export function checkPaper(
  ledger: Ledger,
  run: string,
  basis: PaperBasis,
  markdown: string,
): { problems: PaperProblem[]; cited: string[] } {
  const problems: PaperProblem[] = [];
  const say = (line: number | null, problem: string) => problems.push({ line, problem });
  let inFence = false;
  const lines: Line[] = markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((text, i) => {
      if (FENCE.test(text)) {
        inFence = !inFence;
        return { n: i + 1, text, fence: true };
      }
      if (inFence) return { n: i + 1, text, fence: true };
      const h = HEADING.exec(text);
      return {
        n: i + 1,
        text,
        fence: false,
        ...(h ? { heading: { level: (h[1] as string).length, text: h[2] as string } } : {}),
      };
    });

  // The title, and no part that code appends.
  const first = lines.find((l) => l.text.trim());
  if (first?.heading?.level !== 1)
    say(first?.n ?? 1, "the paper starts with its title, as a level-1 heading: # Title");
  for (const l of lines.filter((x) => x.heading?.level === 1 && x !== first))
    say(l.n, "only the title is a level-1 heading (#): use ## for a part, ### under it");
  for (const l of lines) {
    if (l.heading?.level !== 2) continue;
    const words = fold(l.heading.text);
    if (APPENDED.some((a) => words.startsWith(a)))
      say(
        l.n,
        `leave out the "## ${clip(l.heading.text, 80)}" part: code appends the References and the appendices (the review panel's decisions, and the claims the paper cites)`,
      );
  }

  // Its paragraphs (a list item or a table row each its own).
  const units: Unit[] = [];
  let cur: Unit | undefined;
  const flush = () => {
    if (cur) units.push(cur);
    cur = undefined;
  };
  for (const l of lines) {
    if (l.heading) {
      flush();
      units.push({ line: l.n, text: l.text, heading: true });
      continue;
    }
    if (!l.text.trim()) {
      flush();
      continue;
    }
    if (!l.fence && (LIST_ITEM.test(l.text) || TABLE_ROW.test(l.text))) flush();
    if (cur) cur.text += `\n${l.text}`;
    else cur = { line: l.n, text: l.text, heading: false };
  }
  flush();

  // Citations and numbers, paragraph by paragraph. The numbers of the run's own questions and
  // hypotheses may be written anywhere: they are its words, not facts the paper states.
  const figures = Object.values(basis.figures).flatMap(spellings);
  const own = [
    ...basis.questions.flatMap(numbersIn),
    ...[...basis.hypotheses, ...(basis.proposed ?? [])].flatMap((h) => numbersIn(h.text)),
  ];
  const cited: string[] = [];
  const idSaid = new Set<string>();
  for (const u of units) {
    const ids = citationsIn(u.text);
    for (const id of ids) if (!cited.includes(id)) cited.push(id);
    const r = checkCited(ledger, run, ids, u.heading ? [] : [forNumbers(u.text)], [
      ...figures,
      ...own,
    ]);
    for (const p of r.problems) {
      const num = /^the number (\S+) is not in the claims it cites$/.exec(p);
      if (!num) {
        // A bad id once, at its first line.
        if (!idSaid.has(p)) say(u.line, p);
        idSaid.add(p);
        continue;
      }
      say(
        u.line,
        ids.length
          ? `the number ${num[1]} is not in the claims this paragraph cites (${ids.join(", ")}) or in the figures`
          : `the number ${num[1]} has no claim cited beside it: cite the claims it comes from in this paragraph, as [c-…]`,
      );
    }
  }
  if (!cited.length) say(null, "the paper cites no claim");

  // Every question answered somewhere: the paper cites some of its evidence (goal 117).
  basis.questions.forEach((text, i) => {
    const evidence = basis.evidence?.[i];
    if (basis.bare?.includes(i) || !evidence?.size || cited.some((id) => evidence.has(id))) return;
    const ids = [...evidence];
    say(
      null,
      `question ${i + 1} is not answered: the paper cites none of its evidence (${clip(text, 120)}). Answer it, and cite the claims of its card or other verified claims of question ${i + 1}: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? `, and ${ids.length - 8} more` : ""}`,
    );
  });

  // Hypotheses: a verdict the paper gives (a table row whose first cell names the hypothesis, or
  // a "Verdict: …" line under a heading that names it) is one the review panel gave (goal 117).
  const rows = lines
    .filter((l) => !l.fence && TABLE_ROW.test(l.text))
    .map((l) => ({ l, cells: cellsOf(l.text) }))
    .filter((r) => r.cells.length > 0);
  const verdictOf = (id: string): { line: number; said: string } | undefined => {
    for (const row of rows.filter((r) => names(r.cells[0] ?? "", id))) {
      const cell = row.cells.slice(1).find((c) => VERDICT_WORD.test(c));
      const m = cell ? VERDICT_WORD.exec(cell) : null;
      if (m) return { line: row.l.n, said: (m[1] as string).toLowerCase() };
    }
    for (const [i, l] of lines.entries()) {
      if (!l.heading || l.heading.level < 3 || !names(l.heading.text, id)) continue;
      const level = l.heading.level;
      for (const x of lines.slice(i + 1)) {
        if (x.heading && x.heading.level <= level) break;
        const m = x.fence ? null : VERDICT.exec(x.text);
        if (m) return { line: x.n, said: (m[1] as string).toLowerCase() };
      }
    }
    return undefined;
  };
  for (const h of basis.hypotheses) {
    const v = verdictOf(h.id);
    if (!v) continue;
    const gave = basis.verdicts.get(h.id) ?? new Set<string>();
    const allowed = gave.size ? gave : new Set(["undecided"]);
    if (!allowed.has(v.said))
      say(
        v.line,
        gave.size
          ? `the verdict "${v.said}" on hypothesis ${h.id} is not one the review panel gave: it gave ${[...gave].join(" or ")}`
          : `the review panel has no verdict on hypothesis ${h.id}: write "undecided"`,
      );
  }
  // A hypothesis the run proposed has no verdict: the review panel did not judge it.
  for (const h of basis.proposed ?? []) {
    const v = verdictOf(h.id);
    if (v?.said === "supported" || v?.said === "refuted")
      say(
        v.line,
        `hypothesis ${h.id} was proposed by the run, and the review panel did not judge it: give it no verdict`,
      );
  }

  problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { problems, cited };
}
