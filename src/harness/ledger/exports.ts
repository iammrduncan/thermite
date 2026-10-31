import { canonicalJson } from "../../core/canonical.ts";
import { LedgerPart, type Row } from "./part.ts";

/** The `export` table: the exports made from the ledger. */
export class LedgerExports extends LedgerPart {
  record(e: { throughEvent: number; path: string; manifest: unknown; actor: string }): number {
    return this.tx(() => {
      const id = this.execute(
        "insert into export (through_event, path, manifest, created_at) values (?, ?, ?, ?)",
        e.throughEvent,
        e.path,
        canonicalJson(e.manifest),
        this.now(),
      ).id;
      this.ledger.appendEvent(e.actor, "export_written", String(id), {
        through_event: e.throughEvent,
        path: e.path,
      });
      return id;
    });
  }

  last(): { id: number; through_event: number; created_at: string } | undefined {
    const r = this.row<Row>(
      "select id, through_event, created_at from export order by id desc limit 1",
    );
    return r
      ? {
          id: Number(r.id),
          through_event: Number(r.through_event),
          created_at: String(r.created_at),
        }
      : undefined;
  }

  /** The export written at `path`, with its manifest, if there is one. */
  at(path: string): { id: number; through_event: number; manifest: unknown } | undefined {
    const r = this.row<Row>("select id, through_event, manifest from export where path = ?", path);
    return r
      ? {
          id: Number(r.id),
          through_event: Number(r.through_event),
          manifest: JSON.parse(String(r.manifest)),
        }
      : undefined;
  }
}
