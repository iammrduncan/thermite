import { LedgerPart, type Row } from "./part.ts";

/** A source as its row holds it: a page the harness fetched and archived for a run. */
export interface SourceRow {
  id: string;
  run: string;
  url: string;
  final_url: string;
  domain: string;
  fetched_at: string;
  http_status: number;
  content_type: string | null;
  bytes: number;
  sha256: string;
  title: string | null;
  raw_path: string;
  text_path: string;
  fetched_by: string;
}

const textOrNull = (v: unknown) => (v === null ? null : String(v));

function toSource(r: Row): SourceRow {
  return {
    id: String(r.id),
    run: String(r.run),
    url: String(r.url),
    final_url: String(r.final_url),
    domain: String(r.domain),
    fetched_at: String(r.fetched_at),
    http_status: Number(r.http_status),
    content_type: textOrNull(r.content_type),
    bytes: Number(r.bytes),
    sha256: String(r.sha256),
    title: textOrNull(r.title),
    raw_path: String(r.raw_path),
    text_path: String(r.text_path),
    fetched_by: String(r.fetched_by),
  };
}

/**
 * The `source` and `research_query` tables: the pages the harness archived for each run, and the
 * web searches its workers asked for.
 */
export class LedgerSources extends LedgerPart {
  /** A page just archived, fetched now by `by` (a lane, or the research service). */
  add(s: {
    id: string;
    run: string;
    url: string;
    finalUrl: string;
    domain: string;
    status: number;
    contentType: string | null;
    bytes: number;
    sha256: string;
    title: string | null;
    rawPath: string;
    textPath: string;
    by: string;
  }): void {
    this.execute(
      `insert into source (id, run, url, final_url, domain, fetched_at, http_status, content_type, bytes, sha256,
         title, raw_path, text_path, fetched_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id,
      s.run,
      s.url,
      s.finalUrl,
      s.domain,
      this.now(),
      s.status,
      s.contentType,
      s.bytes,
      s.sha256,
      s.title,
      s.rawPath,
      s.textPath,
      s.by,
    );
  }

  get(run: string, id: string): SourceRow | undefined {
    const r = this.row<Row>("select * from source where run = ? and id = ?", run, id);
    return r ? toSource(r) : undefined;
  }

  /** The run's source archived from this URL (as the archive stores URLs), if any. */
  atUrl(run: string, url: string): SourceRow | undefined {
    const r = this.row<Row>("select * from source where run = ? and url = ?", run, url);
    return r ? toSource(r) : undefined;
  }

  /** The run's source whose content has this hash, if any. */
  withContent(run: string, sha256: string): SourceRow | undefined {
    const r = this.row<Row>("select * from source where run = ? and sha256 = ?", run, sha256);
    return r ? toSource(r) : undefined;
  }

  /** The run's sources, oldest first. */
  list(run: string): SourceRow[] {
    return this.rows<Row>("select * from source where run = ? order by fetched_at", run).map(
      toSource,
    );
  }

  /** The run's sources, in no set order. */
  ofRun(run: string): SourceRow[] {
    return this.rows<Row>("select * from source where run = ?", run).map(toSource);
  }

  /** The run's newest `limit` sources, the newest first. */
  newest(run: string, limit: number): SourceRow[] {
    return this.rows<Row>(
      "select * from source where run = ? order by fetched_at desc limit ?",
      run,
      limit,
    ).map(toSource);
  }

  /** One page of the run's sources, the newest first. */
  page(run: string, limit: number, offset: number): SourceRow[] {
    return this.rows<Row>(
      "select * from source where run = ? order by fetched_at desc, id desc limit ? offset ?",
      run,
      limit,
      offset,
    ).map(toSource);
  }

  /** The ids of the run's sources fetched from this URL or redirected to it, oldest first. */
  idsAt(run: string, url: string): string[] {
    return this.rows<Row>(
      "select id from source where run = ? and (url = ? or final_url = ?) order by fetched_at",
      run,
      url,
      url,
    ).map((r) => String(r.id));
  }

  /** How many sources the run archived. */
  count(run: string): number {
    const r = this.row<Row>("select count(*) as n from source where run = ?", run);
    return Number(r?.n ?? 0);
  }

  /** How many sources the run archived after `at`. */
  countSince(run: string, at: string): number {
    const r = this.row<Row>(
      "select count(*) as n from source where run = ? and fetched_at > ?",
      run,
      at,
    );
    return Number(r?.n ?? 0);
  }

  /** How many bytes the run's sources hold. */
  bytes(run: string): number {
    const r = this.row<Row>("select coalesce(sum(bytes), 0) as n from source where run = ?", run);
    return Number(r?.n);
  }

  /** The hosts the run's sources were fetched from, each once. */
  domains(run: string): string[] {
    return this.rows<Row>("select distinct domain from source where run = ?", run).map((r) =>
      String(r.domain),
    );
  }

  /** The hosts of the run's sources fetched before `at`, one for each source. */
  domainsBefore(run: string, at: string): string[] {
    return this.rows<Row>(
      "select domain from source where run = ? and fetched_at < ?",
      run,
      at,
    ).map((r) => String(r.domain));
  }

  /** The hosts of the sources `by` fetched from `since` to `until`, one for each, oldest first. */
  domainsFetchedBy(run: string, by: string, since: string, until: string): string[] {
    return this.rows<Row>(
      "select domain from source where run = ? and fetched_by = ? and fetched_at >= ? and fetched_at <= ? order by fetched_at",
      run,
      by,
      since,
      until,
    ).map((r) => String(r.domain));
  }
}
