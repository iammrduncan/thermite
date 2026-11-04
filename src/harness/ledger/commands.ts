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

  /**
   * The model files a run's accepted assignment names, each with where it came from (goal 205: a
   * follower fetches them there too). None: no assignment, or no model in it.
   */
  modelsOf(run: string): { name: string; path: string; sha256: string; url?: string }[] {
    const rows = this.db
      .prepare("select envelope from command where kind = 'assign_campaign' and accepted = 1")
      .all() as { envelope: string }[];
    for (const r of rows.reverse()) {
      const payload = (JSON.parse(r.envelope) as { payload?: Record<string, unknown> }).payload;
      if (payload?.run !== run) continue;
      const imports = (payload.imports ?? []) as {
        kind?: string;
        name?: string;
        path?: string;
        sha256?: string;
        source?: { url?: string };
      }[];
      return imports
        .filter((i) => i.kind === "model" && i.name && i.path && i.sha256)
        .map((i) => ({
          name: String(i.name),
          path: String(i.path),
          sha256: String(i.sha256),
          ...(i.source?.url ? { url: i.source.url } : {}),
        }));
    }
    return [];
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
