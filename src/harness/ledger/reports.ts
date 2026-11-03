import { LedgerPart, type Row } from "./part.ts";

/** A report as its row holds it: a digest or the final report, written by the harness. */
export interface ReportRow {
  id: number;
  run: string;
  kind: string;
  body: string;
  created_at: string;
}

/** A report section as its row holds it: a worker's text, under its name. */
export interface SectionRow {
  run: string;
  name: string;
  body: string;
  updated_by: string;
  updated_at: string;
}

/**
 * The `report_version` and `report_section` tables: each run's reports, kept as versions, and the
 * report sections its workers write, one row for each name.
 */
export class LedgerReports extends LedgerPart {
  /** A report, written now. */
  add(run: string, kind: "digest" | "final", body: string): void {
    this.execute(
      "insert into report_version (run, kind, body, created_at) values (?, ?, ?, ?)",
      run,
      kind,
      body,
      this.now(),
    );
  }

  /** The run's newest report, if it has one. */
  newest(run: string): ReportRow | undefined {
    const r = this.row<Row>(
      "select * from report_version where run = ? order by id desc limit 1",
      run,
    );
    return r
      ? {
          id: Number(r.id),
          run: String(r.run),
          kind: String(r.kind),
          body: String(r.body),
          created_at: String(r.created_at),
        }
      : undefined;
  }

  /** A section's text, now, by `by`: a new name adds it, a name it has replaces it. */
  setSection(run: string, name: string, body: string, by: string): void {
    this.execute(
      `insert into report_section (run, name, body, updated_by, updated_at) values (?, ?, ?, ?, ?)
       on conflict (run, name) do update set body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      run,
      name,
      body,
      by,
      this.now(),
    );
  }

  /** The run's report sections, by name. */
  sections(run: string): SectionRow[] {
    return this.rows<Row>("select * from report_section where run = ? order by name", run).map(
      (s) => ({
        run: String(s.run),
        name: String(s.name),
        body: String(s.body),
        updated_by: String(s.updated_by),
        updated_at: String(s.updated_at),
      }),
    );
  }
}
