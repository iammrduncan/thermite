import { readFileSync } from "node:fs";
import type { Fetcher } from "../../../agents/tools/index.ts";
import { log } from "../../../common/env.ts";
import { errorText } from "../../../common/errors.ts";
import type { ResearchContract } from "../../../core/contract.ts";
import { type Ledger, LedgerError, type SourceRow } from "../../ledger/index.ts";
import { foldText } from "../checks.ts";
import { Refusals } from "../refusals.ts";

/**
 * What the research service's parts share, built once by Research (research.ts): the ledger, the
 * research folders' root, each run's fetcher and its lasting refusals, the fetch settings, what
 * to tell after a change, and a run's research contract. Each part is a module of this folder
 * whose functions take it as `ctx`.
 */
export interface ResearchContext {
  ledger: Ledger;
  stateDir: string;
  /** Each run's fetcher, made at its first fetch (sources.ts). */
  fetchers: Map<string, Fetcher>;
  refusals: Refusals;
  allowPrivate: boolean;
  maxCorpusBytes: number;
  /** A change is recorded: the folder follows; a failure there never fails the change. */
  changed(run: string): void;
  contract(run: string): ResearchContract;
}

/** The research service's context (research.ts's constructor). */
export function researchContext(
  ledger: Ledger,
  stateDir: string,
  opts: { allowPrivate?: boolean; maxCorpusBytes?: number },
  changed: (run: string) => void,
): ResearchContext {
  return {
    ledger,
    refusals: new Refusals(ledger),
    stateDir,
    fetchers: new Map<string, Fetcher>(),
    allowPrivate: opts.allowPrivate ?? false,
    // No cap on the corpus unless one is configured (the owner's direction, 2026-10-15).
    maxCorpusBytes: opts.maxCorpusBytes ?? Number.POSITIVE_INFINITY,
    changed,
    contract(run: string): ResearchContract {
      const inst = ledger.runs.get(run);
      if (!inst) throw new LedgerError("not_found", `no run ${run}`);
      const c = ledger.contracts.get(inst.campaign, inst.version);
      if (c?.mode === "research") return c;
      throw new LedgerError("invalid", `${run} is not a research campaign`);
    },
  };
}

/** A text cut to n characters, ending with "…" when it was longer. */
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A claim's identity for deduplication: its words, case and punctuation folded. */
export const claimKey = foldText;

/** An archived source's text: not_found, naming only the source, when it can't be read. */
export function sourceText(source: SourceRow): string {
  try {
    return readFileSync(source.text_path, "utf8");
  } catch (err) {
    const why = { source: source.id, error: errorText(err) };
    log("harness", "a source's text can't be read", why, "warn");
    throw new LedgerError("not_found", `the text of source ${source.id} can't be read on this rig`);
  }
}

/** A question's index as a claim or a hypothesis takes it: one of the contract's, or a refusal. */
export function questionOf(
  ctx: ResearchContext,
  run: string,
  q: number | null | undefined,
): number | null {
  if (q === undefined || q === null) return null;
  const n = ctx.contract(run).questions.length;
  if (!Number.isInteger(q) || q < 0 || q >= n)
    throw new LedgerError(
      "invalid",
      `no question ${q}: "question" is the index of one of the campaign's ${n} questions, from 0 to ${n - 1}`,
    );
  return q;
}
