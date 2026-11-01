import { str } from "./kb-fields.ts";

/**
 * A run's research corpus, read (goal 125, T11): the one reading of the items its research
 * records, its claims with their quotes, its findings, hypotheses and notes, from the two places
 * they are kept. On the rig, the ledger's rows keep their lists as JSON; on control, the research
 * events carry them. The four renderers of the corpus take their items from here: the research
 * folder's files (harness/research/folder.ts), the teachers' reads (harness/run-research.ts), the
 * knowledge base's items (core/kb-index-research.ts) and control's view of a research run
 * (control/views/research.ts). It does no I/O: each renderer reads its own store, and this module
 * reads what the store gave it.
 */

/**
 * A list a row keeps as JSON. The ledger writes canonical JSON, so a row that holds anything else
 * is damaged: it reads as an empty list, so one bad row never fails every read of its run.
 */
export function storedList(json: unknown): unknown[] {
  try {
    const v = JSON.parse(String(json ?? "[]")) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** A list of ids, problems or sources a row keeps as JSON, each as text. */
const storedTexts = (json: unknown): string[] => storedList(json).map(String);

/** One quote of a claim: the source it names, its words, and what the worker cited, if not the id. */
interface CorpusQuote {
  source: string;
  quote: string;
  /** The address or file name the worker cited for an archived source (goal 117). */
  resolved_from?: string;
}

function quoteOf(x: unknown): CorpusQuote {
  const q = (x ?? {}) as Record<string, unknown>;
  return {
    source: String(q.source),
    quote: String(q.quote),
    ...(q.resolved_from ? { resolved_from: String(q.resolved_from) } : {}),
  };
}

/** A claim, from its row: its quotes and its problems (a draft's reasons) read. */
export function readClaim<T extends { quotes: string; problems: string }>(
  row: T,
): Omit<T, "quotes" | "problems"> & { quotes: CorpusQuote[]; problems: string[] } {
  return {
    ...row,
    quotes: storedList(row.quotes).map(quoteOf),
    problems: storedTexts(row.problems),
  };
}

/** A finding, from its row: the claims it cites and its problems read. */
export function readFinding<T extends { supporting: string; problems: string }>(
  row: T,
): Omit<T, "supporting" | "problems"> & { supporting: string[]; problems: string[] } {
  return { ...row, supporting: storedTexts(row.supporting), problems: storedTexts(row.problems) };
}

/** A hypothesis, from its row: the verified claims that support it read. */
export function readHypothesis<T extends { supporting: string }>(
  row: T,
): Omit<T, "supporting"> & { supporting: string[] } {
  return { ...row, supporting: storedTexts(row.supporting) };
}

/** A research note, from its row: the sources it names read. */
export function readNote<T extends { sources: string }>(
  row: T,
): Omit<T, "sources"> & { sources: string[] } {
  return { ...row, sources: storedTexts(row.sources) };
}

/** The change each kind of a hypothesis's events makes. */
const HYPOTHESIS_CHANGES = {
  hypothesis_added: "added",
  hypothesis_revised: "revised",
  hypothesis_merged: "merged",
  hypothesis_status: "status",
} as const;

/** What one of a hypothesis's events says of it. A field the event lacks is empty. */
interface HypothesisEvent {
  change: (typeof HYPOTHESIS_CHANGES)[keyof typeof HYPOTHESIS_CHANGES];
  id: string;
  text: string;
  /** The question it is about, an index from 0, or null for the whole run; none: not named. */
  question?: number | null;
  /** `merged` for a merge; else the event's status (author, pool, promoted, retired). */
  status: string;
  /** The hypothesis a merge put it into. */
  into: string;
  /** The verified claims that support it, when the event lists them. */
  supporting?: string[];
  /** The lane that proposed or changed it; none for the author's. */
  lane: string;
  /** A status change's: who made it and why. */
  by: string;
  reason: string;
  /** Where it came from: `brief` for the author's; a status change's earlier status. */
  from: string;
}

/** A hypothesis's event read; undefined for an event of another kind. */
export function hypothesisEvent(kind: string, body: unknown): HypothesisEvent | undefined {
  const change = HYPOTHESIS_CHANGES[kind as keyof typeof HYPOTHESIS_CHANGES];
  if (!change) return undefined;
  const b = (body ?? {}) as Record<string, unknown>;
  const question =
    "question" in b ? (typeof b.question === "number" ? b.question : null) : undefined;
  return {
    change,
    id: str(b.hypothesis),
    text: str(b.text),
    ...(question === undefined ? {} : { question }),
    status: change === "merged" ? "merged" : str(b.status),
    into: str(b.into),
    ...(Array.isArray(b.supporting) ? { supporting: b.supporting.map(String) } : {}),
    lane: str(b.lane),
    by: str(b.by),
    reason: str(b.reason),
    from: str(b.from),
  };
}
