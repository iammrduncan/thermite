import type { Ledger } from "./ledger/index.ts";

/**
 * A run's status changes after an event id, oldest first, under every name the event was
 * recorded with (core/names.ts: run_status was instance_status before 2026-10-15), so no reader
 * keeps its own copy of the rename (goal 163).
 */
export function statusEvents(
  ledger: Ledger,
  run: string,
  afterId = 0,
): { id: number; at: string; status: string }[] {
  return ledger.events
    .list("run_status", { subject: run, after: afterId })
    .map((e) => ({ id: e.id, at: e.at, status: e.body.status }));
}
