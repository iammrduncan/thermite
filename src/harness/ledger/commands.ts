import { canonicalJson } from "../../core/canonical.ts";
import { LedgerPart, type Row } from "./part.ts";

/** The `command` table: the signed commands the harness applied. */
export class LedgerCommands extends LedgerPart {
  get(id: string): { accepted: boolean; result: unknown } | undefined {
    const r = this.row<Row>("select accepted, result from command where id = ?", id);
    return r
      ? { accepted: Number(r.accepted) === 1, result: JSON.parse(String(r.result)) }
      : undefined;
  }

  record(c: {
    id: string;
    kind: string;
    envelope: unknown;
    signature: string;
    accepted: boolean;
    result: unknown;
    actor: string;
  }): void {
    this.tx(() => {
      this.execute(
        "insert into command (id, kind, envelope, signature, accepted, result, received_at) values (?, ?, ?, ?, ?, ?, ?)",
        c.id,
        c.kind,
        canonicalJson(c.envelope),
        c.signature,
        c.accepted ? 1 : 0,
        canonicalJson(c.result ?? {}),
        this.now(),
      );
      this.ledger.appendEvent(c.actor, "command", c.id, {
        kind: c.kind,
        accepted: c.accepted,
        result: c.result ?? {},
      });
    });
  }
}
