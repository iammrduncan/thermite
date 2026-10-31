import { canonicalJson } from "../../core/canonical.ts";
import { LedgerPart, type Row } from "./part.ts";

/** A claim as its row holds it; its quotes and problems are JSON, as stored. */
export interface ClaimRow {
  id: string;
  run: string;
  lane: string | null;
  question: number | null;
  text: string;
  quotes: string;
  verified: boolean;
  problems: string;
  confidence: number | null;
  created_at: string;
}

/** A finding as its row holds it; its supporting claims and problems are JSON, as stored. */
export interface FindingRow {
  id: string;
  run: string;
  lane: string | null;
  text: string;
  summary: string;
  why_it_matters: string;
  supporting: string;
  supported: boolean;
  problems: string;
  created_at: string;
}

/** A research note as its row holds it; the sources it cites are JSON, as stored. */
export interface NoteRow {
  id: number;
  run: string;
  lane: string | null;
  text: string;
  sources: string;
  created_at: string;
}

const textOrNull = (v: unknown) => (v === null ? null : String(v));
const numberOrNull = (v: unknown) => (v === null ? null : Number(v));

function toClaim(r: Row): ClaimRow {
  return {
    id: String(r.id),
    run: String(r.run),
    lane: textOrNull(r.lane),
    question: numberOrNull(r.question),
    text: String(r.text),
    quotes: String(r.quotes),
    verified: Number(r.verified) === 1,
    problems: String(r.problems),
    confidence: numberOrNull(r.confidence),
    created_at: String(r.created_at),
  };
}

function toFinding(r: Row): FindingRow {
  return {
    id: String(r.id),
    run: String(r.run),
    lane: textOrNull(r.lane),
    text: String(r.text),
    summary: String(r.summary),
    why_it_matters: String(r.why_it_matters),
    supporting: String(r.supporting),
    supported: Number(r.supported) === 1,
    problems: String(r.problems),
    created_at: String(r.created_at),
  };
}

function toNote(r: Row): NoteRow {
  return {
    id: Number(r.id),
    run: String(r.run),
    lane: textOrNull(r.lane),
    text: String(r.text),
    sources: String(r.sources),
    created_at: String(r.created_at),
  };
}

/** Which claims: of one question, and verified or drafts. */
interface ClaimFilter {
  question?: number | undefined;
  verified?: boolean | undefined;
}

/** The `where` of a query over a run's claims, with its parameters. */
function claimsWhere(run: string, f: ClaimFilter): [string, (string | number)[]] {
  const parts = ["run = ?"];
  const args: (string | number)[] = [run];
  if (f.question !== undefined) {
    parts.push("question = ?");
    args.push(f.question);
  }
  if (f.verified !== undefined) {
    parts.push("verified = ?");
    args.push(f.verified ? 1 : 0);
  }
  return [parts.join(" and "), args];
}

/**
 * The `claim`, `finding` and `note` tables: what the workers state. A claim is checked against the
 * archived sources it quotes, a finding against the claims it cites; a note is checked by nothing.
 */
export class LedgerClaims extends LedgerPart {
  /** A claim, recorded now, verified or a draft with its problems. */
  add(c: {
    id: string;
    run: string;
    lane: string | null;
    question: number | null;
    text: string;
    quotes: readonly unknown[];
    verified: boolean;
    problems: readonly string[];
    confidence: number | null;
  }): void {
    this.execute(
      "insert into claim (id, run, lane, question, text, quotes, verified, problems, confidence, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      c.id,
      c.run,
      c.lane,
      c.question,
      c.text,
      canonicalJson(c.quotes),
      c.verified ? 1 : 0,
      canonicalJson(c.problems),
      c.confidence,
      this.now(),
    );
  }

  get(run: string, id: string): ClaimRow | undefined {
    const r = this.row<Row>("select * from claim where run = ? and id = ?", run, id);
    return r ? toClaim(r) : undefined;
  }

  /** The run's claims, oldest first. */
  list(run: string): ClaimRow[] {
    return this.rows<Row>("select * from claim where run = ? order by created_at", run).map(
      toClaim,
    );
  }

  /** The run's claims, in no set order. */
  ofRun(run: string): ClaimRow[] {
    return this.rows<Row>("select * from claim where run = ?", run).map(toClaim);
  }

  /** The run's claims, the verified ones first, each oldest first. */
  verifiedFirst(run: string): ClaimRow[] {
    return this.rows<Row>(
      "select * from claim where run = ? order by verified desc, created_at",
      run,
    ).map(toClaim);
  }

  /** The run's draft claims, oldest first. */
  drafts(run: string): ClaimRow[] {
    return this.rows<Row>(
      "select * from claim where run = ? and verified = 0 order by created_at",
      run,
    ).map(toClaim);
  }

  /** The run's verified claims, oldest first. */
  verified(run: string): ClaimRow[] {
    return this.rows<Row>(
      "select * from claim where run = ? and verified = 1 order by created_at",
      run,
    ).map(toClaim);
  }

  /** The run's verified claims that name a question, in no set order. */
  verifiedWithQuestion(run: string): ClaimRow[] {
    return this.rows<Row>(
      "select * from claim where run = ? and verified = 1 and question is not null",
      run,
    ).map(toClaim);
  }

  /** The run's verified claims that name a question, recorded before `at`, in no set order. */
  verifiedBefore(run: string, at: string): ClaimRow[] {
    return this.rows<Row>(
      "select * from claim where run = ? and verified = 1 and question is not null and created_at < ?",
      run,
      at,
    ).map(toClaim);
  }

  /** The verified claims a lane recorded from `since` to `until`, oldest first. */
  verifiedOfLane(run: string, lane: string, since: string, until: string): ClaimRow[] {
    return this.rows<Row>(
      "select * from claim where run = ? and lane = ? and verified = 1 and created_at >= ? and created_at <= ? order by created_at, rowid",
      run,
      lane,
      since,
      until,
    ).map(toClaim);
  }

  /**
   * A question's verified claims after a claim (`after`: its time and id), or all of them, oldest
   * first, then by id.
   */
  verifiedAfter(
    run: string,
    question: number,
    after?: { at: string; id: string } | undefined,
  ): ClaimRow[] {
    const rows = after
      ? this.rows<Row>(
          `select * from claim where run = ? and question = ? and verified = 1
             and (created_at > ? or (created_at = ? and id > ?)) order by created_at, id`,
          run,
          question,
          after.at,
          after.at,
          after.id,
        )
      : this.rows<Row>(
          "select * from claim where run = ? and question = ? and verified = 1 order by created_at, id",
          run,
          question,
        );
    return rows.map(toClaim);
  }

  /** One page of the run's claims (of a question, verified or drafts, when given), the newest first. */
  page(run: string, f: ClaimFilter, limit: number, offset: number): ClaimRow[] {
    const [where, args] = claimsWhere(run, f);
    return this.rows<Row>(
      `select * from claim where ${where} order by created_at desc, id desc limit ? offset ?`,
      ...args,
      limit,
      offset,
    ).map(toClaim);
  }

  /** How many claims the run has (of a question, verified or drafts, when given). */
  count(run: string, f: ClaimFilter = {}): number {
    const [where, args] = claimsWhere(run, f);
    const r = this.row<Row>(`select count(*) as n from claim where ${where}`, ...args);
    return Number(r?.n ?? 0);
  }

  /** How many of the run's claims were verified after `at`. */
  countVerifiedSince(run: string, at: string): number {
    const r = this.row<Row>(
      "select count(*) as n from claim where run = ? and verified = 1 and created_at > ?",
      run,
      at,
    );
    return Number(r?.n ?? 0);
  }

  /** How many verified claims a lane recorded from `since` on. */
  countVerifiedOfLane(run: string, lane: string, since: string): number {
    const r = this.row<Row>(
      "select count(*) as n from claim where run = ? and lane = ? and verified = 1 and created_at >= ?",
      run,
      lane,
      since,
    );
    return Number(r?.n ?? 0);
  }

  /** How many verified claims each question of the run has, by question index. */
  verifiedByQuestion(run: string): Map<number, number> {
    return new Map(
      this.rows<Row>(
        "select question, count(*) as n from claim where run = ? and verified = 1 and question is not null group by question",
        run,
      ).map((r) => [Number(r.question), Number(r.n)]),
    );
  }

  /** How many verified and draft claims each question of the run has, by question index. */
  countsByQuestion(run: string): Map<number, { verified: number; draft: number }> {
    const out = new Map<number, { verified: number; draft: number }>();
    for (const r of this.rows<Row>(
      "select question, verified, count(*) as n from claim where run = ? and question is not null group by question, verified",
      run,
    )) {
      const c = out.get(Number(r.question)) ?? { verified: 0, draft: 0 };
      if (Number(r.verified) === 1) c.verified += Number(r.n);
      else c.draft += Number(r.n);
      out.set(Number(r.question), c);
    }
    return out;
  }

  /** When the question's first claim was verified, if one was. */
  firstVerified(run: string, question: number): string | undefined {
    const r = this.row<Row>(
      "select min(created_at) as t from claim where run = ? and question = ? and verified = 1",
      run,
      question,
    );
    return typeof r?.t === "string" ? r.t : undefined;
  }

  /**
   * How many sources, claims and notes the run recorded; with `compactions`, also how many of its
   * agents' conversations were kept before a compaction.
   */
  recorded(run: string, o: { compactions?: boolean } = {}): number {
    return (
      this.ledger.sources.count(run) +
      this.count(run) +
      this.countNotes(run) +
      (o.compactions ? this.ledger.events.count("context_compacted", { subject: run }) : 0)
    );
  }

  // The findings.

  /** A finding, recorded now, supported or a draft with its problems. */
  addFinding(f: {
    id: string;
    run: string;
    lane: string | null;
    text: string;
    summary: string;
    whyItMatters: string;
    supporting: readonly string[];
    supported: boolean;
    problems: readonly string[];
  }): void {
    this.execute(
      `insert into finding (id, run, lane, text, summary, why_it_matters, supporting, supported, problems, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      f.id,
      f.run,
      f.lane,
      f.text,
      f.summary,
      f.whyItMatters,
      canonicalJson(f.supporting),
      f.supported ? 1 : 0,
      canonicalJson(f.problems),
      this.now(),
    );
  }

  finding(run: string, id: string): FindingRow | undefined {
    const r = this.row<Row>("select * from finding where run = ? and id = ?", run, id);
    return r ? toFinding(r) : undefined;
  }

  /** The run's findings, oldest first. */
  findings(run: string): FindingRow[] {
    return this.rows<Row>("select * from finding where run = ? order by created_at", run).map(
      toFinding,
    );
  }

  /** The run's findings, in no set order. */
  findingsOfRun(run: string): FindingRow[] {
    return this.rows<Row>("select * from finding where run = ?", run).map(toFinding);
  }

  /** One page of the run's findings (supported or drafts, when given), the newest first. */
  findingsPage(
    run: string,
    supported: boolean | undefined,
    limit: number,
    offset: number,
  ): FindingRow[] {
    const rows =
      supported === undefined
        ? this.rows<Row>(
            "select * from finding where run = ? order by created_at desc, id desc limit ? offset ?",
            run,
            limit,
            offset,
          )
        : this.rows<Row>(
            "select * from finding where run = ? and supported = ? order by created_at desc, id desc limit ? offset ?",
            run,
            supported ? 1 : 0,
            limit,
            offset,
          );
    return rows.map(toFinding);
  }

  /** How many findings the run has (supported or drafts, when given). */
  countFindings(run: string, supported?: boolean | undefined): number {
    const r =
      supported === undefined
        ? this.row<Row>("select count(*) as n from finding where run = ?", run)
        : this.row<Row>(
            "select count(*) as n from finding where run = ? and supported = ?",
            run,
            supported ? 1 : 0,
          );
    return Number(r?.n ?? 0);
  }

  /** How many supported findings a lane recorded from `since` to `until`. */
  countFindingsOfLane(run: string, lane: string, since: string, until: string): number {
    const r = this.row<Row>(
      "select count(*) as n from finding where run = ? and lane = ? and supported = 1 and created_at >= ? and created_at <= ?",
      run,
      lane,
      since,
      until,
    );
    return Number(r?.n ?? 0);
  }

  // The research notes.

  /** A research note, recorded now, with the sources it cites: its id. */
  addNote(n: {
    run: string;
    lane: string | null;
    text: string;
    sources: readonly string[];
  }): number {
    return this.execute(
      "insert into note (run, lane, text, sources, created_at) values (?, ?, ?, ?, ?)",
      n.run,
      n.lane,
      n.text,
      canonicalJson(n.sources),
      this.now(),
    ).id;
  }

  /** The run's notes, oldest first. */
  notes(run: string): NoteRow[] {
    return this.rows<Row>("select * from note where run = ? order by id", run).map(toNote);
  }

  /** The run's newest `limit` notes, the newest first. */
  newestNotes(run: string, limit: number): NoteRow[] {
    return this.rows<Row>(
      "select * from note where run = ? order by id desc limit ?",
      run,
      limit,
    ).map(toNote);
  }

  /** One page of the run's notes, the newest first. */
  notesPage(run: string, limit: number, offset: number): NoteRow[] {
    return this.rows<Row>(
      "select * from note where run = ? order by id desc limit ? offset ?",
      run,
      limit,
      offset,
    ).map(toNote);
  }

  /** The notes with these ids, of any run, oldest first. */
  notesById(ids: readonly number[]): NoteRow[] {
    if (!ids.length) return [];
    return this.rows<Row>(
      `select * from note where id in (${ids.map(() => "?").join(", ")}) order by id`,
      ...ids,
    ).map(toNote);
  }

  /** How many notes the run has. */
  countNotes(run: string): number {
    const r = this.row<Row>("select count(*) as n from note where run = ?", run);
    return Number(r?.n ?? 0);
  }
}
