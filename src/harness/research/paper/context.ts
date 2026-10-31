import type { ResearchContract } from "../../../core/contract.ts";
import { type Ledger, LedgerError } from "../../ledger/index.ts";

export type Row = Record<string, unknown>;

/**
 * What the parts of a run's papers share, built once by Papers (paper.ts): the ledger, and a
 * run's research contract. Each part is a module of this folder whose functions take it as `ctx`.
 */
export interface PapersContext {
  ledger: Ledger;
  contract(run: string): ResearchContract;
}

/** The papers' context, for a ledger and how to read a run's contract (paper.ts's constructor). */
export function papersContext(
  ledger: Ledger,
  contractFor: (run: string) => unknown,
): PapersContext {
  return {
    ledger,
    contract(run: string): ResearchContract {
      const c = contractFor(run) as ResearchContract | undefined;
      if (c?.mode !== "research") throw new LedgerError("invalid", `${run} is not a research run`);
      return c;
    },
  };
}
