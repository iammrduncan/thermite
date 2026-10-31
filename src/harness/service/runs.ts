import { type Ledger, LedgerError } from "../ledger/index.ts";

/** A run as the service's operations take it: one that exists, is open, or may still be decided. */

/**
 * Why a closed run's waiting decision is refused, by kind (goal 087; the owner, 2026-10-22: a
 * closed run's decisions leave Needs you, and approvals of them are refused). A closed run is
 * finished: none of its changes becomes the champion, and nothing in it is decided again.
 */
const CLOSED_RUN_REFUSALS = {
  approve_promotion: "none of its changes can become the champion",
  decline_promotion: "its changes stay as they were when it closed",
  accept_review: "its goals are not checked again",
  conclude: "it can't end as not possible or go on",
} as const;

export function requireRun(ledger: Ledger, id: string) {
  const inst = ledger.runs.get(id);
  if (!inst) throw new LedgerError("not_found", `no run ${id}`);
  return inst;
}

/**
 * A run whose waiting decisions the owner may still take: one that exists and is not closed
 * (goal 087). Refused in words, by the command's kind.
 */
export function decidingRun(ledger: Ledger, id: string, kind: keyof typeof CLOSED_RUN_REFUSALS) {
  const inst = requireRun(ledger, id);
  if (inst.status === "closed")
    throw new LedgerError("invalid", `run ${id} is closed: ${CLOSED_RUN_REFUSALS[kind]}`);
  return inst;
}

/** A run whose queue may still change: one that exists and is not closed. */
export function openRun(ledger: Ledger, id: string) {
  const inst = requireRun(ledger, id);
  if (inst.status === "closed")
    throw new LedgerError("invalid", `run ${id} is closed: its queue and rules no longer change`);
  return inst;
}

export function pauseOthers(ledger: Ledger, run: string, by: string): void {
  for (const other of ledger.runs.list()) {
    if (other.status === "running" && other.id !== run) {
      ledger.runs.setStatus(other.id, "paused", `replaced by ${run}`, by);
    }
  }
}
