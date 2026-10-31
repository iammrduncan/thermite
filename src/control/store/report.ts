/**
 * A rig's report as control keeps it: the events of one ledger after a cursor, which go on the
 * message bus's events stream, and the rig's summary, which its row keeps. The API checks its
 * shape and its signature first.
 */
export interface IngestReport {
  generated_at?: string | undefined;
  rig: string;
  ledger_id: string;
  cursor: number;
  next: number;
  events: {
    id: number;
    at: string;
    actor: string;
    kind: string;
    subject: string | null;
    body: unknown;
    /** The run it is about, as the rig's ledger recorded it (goal 170); none for the rig's own. */
    run?: string | null | undefined;
  }[];
  summary: unknown;
}
