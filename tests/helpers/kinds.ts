import type { AppendEvent } from "../../src/core/events/bodies.ts";
import type { EventKind } from "../../src/core/events/kinds.ts";

/** A kind outside Thermite's list, which a test records on purpose: an older or newer rig's. */
export const otherKind = (kind: string): EventKind => kind as EventKind;

/** Records an event of such a kind, with any body: its id. */
export function appendOther(
  ledger: { appendEvent: AppendEvent },
  actor: string,
  kind: string,
  subject: string | null,
  body: unknown,
): number {
  const append = ledger.appendEvent as (
    a: string,
    k: string,
    s: string | null,
    b: unknown,
  ) => number;
  return append(actor, kind, subject, body);
}
