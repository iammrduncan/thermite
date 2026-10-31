import { LedgerPart } from "./part.ts";

/** A field note as its row holds it. */
export interface JournalNoteRow {
  id: number;
  run: string;
  by: string;
  kind: string;
  text: string;
  about_type: string;
  about_id: string;
  lane: string | null;
  trial: string | null;
  at: string;
}

/** The `journal_note` table: a run's field notes (append-only). */
export class LedgerJournal extends LedgerPart {
  /** A note, written at `at`: its id. */
  add(n: {
    run: string;
    by: string;
    kind: string;
    text: string;
    aboutType: string;
    aboutId: string;
    lane: string | null;
    trial: string | null;
    at: string;
  }): number {
    return this.execute(
      `insert into journal_note (run, by, kind, text, about_type, about_id, lane, trial, at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      n.run,
      n.by,
      n.kind,
      n.text,
      n.aboutType,
      n.aboutId,
      n.lane,
      n.trial,
      n.at,
    ).id;
  }

  get(id: number): JournalNoteRow | undefined {
    return this.row<JournalNoteRow>("select * from journal_note where id = ?", id);
  }

  /**
   * The run's newest `limit` notes, the newest first: all of them, or those by a writer, not by
   * one, or of these kinds.
   */
  newest(
    run: string,
    limit: number,
    o: {
      by?: string | undefined;
      notBy?: string | undefined;
      kinds?: readonly string[] | undefined;
    },
  ): JournalNoteRow[] {
    const where = [
      "run = ?",
      ...(o.by !== undefined ? ["by = ?"] : []),
      ...(o.notBy !== undefined ? ["by <> ?"] : []),
      ...(o.kinds?.length ? [`kind in (${o.kinds.map(() => "?").join(", ")})`] : []),
    ].join(" and ");
    return this.rows<JournalNoteRow>(
      `select * from journal_note where ${where} order by id desc limit ?`,
      run,
      ...(o.by !== undefined ? [o.by] : []),
      ...(o.notBy !== undefined ? [o.notBy] : []),
      ...(o.kinds ?? []),
      limit,
    );
  }

  /** Notes by id, oldest first. */
  byIds(ids: readonly number[]): JournalNoteRow[] {
    if (!ids.length) return [];
    return this.rows<JournalNoteRow>(
      `select * from journal_note where id in (${ids.map(() => "?").join(", ")}) order by id`,
      ...ids,
    );
  }
}
