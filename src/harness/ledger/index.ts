import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { openDatabase, transaction } from "../../common/sqlite.ts";
import { canonicalJson } from "../../core/canonical.ts";
import type { AppendEvent } from "../../core/events/bodies.ts";
import { currentEvent, type EventKind } from "../../core/names.ts";
import { LedgerAttempts } from "./attempts.ts";
import { LedgerAudits } from "./audits.ts";
import { LedgerBuilds } from "./builds.ts";
import { LedgerCards } from "./cards.ts";
import { LedgerChampions } from "./champions.ts";
import { LedgerClaims } from "./claims.ts";
import { LedgerCommands } from "./commands.ts";
import { LedgerConclusions } from "./conclusions.ts";
import { LedgerContracts } from "./contracts.ts";
import { LedgerDirectives } from "./directives.ts";
import { LedgerEvents } from "./events.ts";
import { LedgerExperiments } from "./experiments.ts";
import { LedgerExports } from "./exports.ts";
import { LedgerGoals } from "./goals.ts";
import { LedgerHeldOut } from "./held-out.ts";
import { LedgerHypotheses } from "./hypotheses.ts";
import { LedgerImports } from "./imports.ts";
import { LedgerJobs } from "./jobs.ts";
import { LedgerJournal } from "./journal.ts";
import { LedgerLaneFiles } from "./lane-files.ts";
import { LedgerMeasurements } from "./measurements.ts";
import { LedgerMessages } from "./messages.ts";
import { migrateLedger } from "./migrate.ts";
import { LedgerError, type Row } from "./part.ts";
import { LedgerPrompts } from "./prompts.ts";
import { LedgerPropagations } from "./propagations.ts";
import { LedgerReports } from "./reports.ts";
import { LedgerReviews } from "./reviews.ts";
import type { LedgerEvent } from "./rows.ts";
import { eventRun, LedgerRuns } from "./runs.ts";
import { LedgerSources } from "./sources.ts";
import { LedgerTrials } from "./trials.ts";
import { LedgerVerdicts } from "./verdicts.ts";

/**
 * The harness ledger: the authoritative research record for one rig.
 *
 * One process (the controller) owns the database and is its only writer. Every state change
 * also appends an event, so the supervisor can stream changes with a cursor.
 */

export type { CardRow } from "./cards.ts";
export type { PromoteResult } from "./champions.ts";
export type { ClaimRow, FindingRow } from "./claims.ts";
export type { HypothesisRow } from "./hypotheses.ts";
export { MAX_LEASE_EXPIRIES, type RunJob } from "./jobs.ts";
export type { JournalNoteRow } from "./journal.ts";
export type { LaneFileChange } from "./lane-files.ts";
export type { MessageRow } from "./messages.ts";
export { LedgerError } from "./part.ts";
export type { PromptRow } from "./prompts.ts";
export type { AttemptInput, BriefingItem, ExperimentRow, JobRow, RunRow } from "./rows.ts";
export type { SourceRow } from "./sources.ts";
export type { EpochSource, FamilyStatus } from "./trials.ts";
export type { InvalidationResult } from "./verdicts.ts";

export class Ledger {
  readonly db: DatabaseSync;
  /** The events, read by kind (the one module that queries the event table). */
  readonly events: LedgerEvents;
  // One module for each of the ledger's tables (goal 125, T6): each owns its table's SQL.
  readonly contracts: LedgerContracts;
  readonly runs: LedgerRuns;
  readonly champions: LedgerChampions;
  readonly attempts: LedgerAttempts;
  readonly jobs: LedgerJobs;
  readonly measurements: LedgerMeasurements;
  readonly heldOut: LedgerHeldOut;
  readonly builds: LedgerBuilds;
  readonly verdicts: LedgerVerdicts;
  readonly commands: LedgerCommands;
  readonly directives: LedgerDirectives;
  readonly experiments: LedgerExperiments;
  readonly goals: LedgerGoals;
  readonly imports: LedgerImports;
  readonly exports: LedgerExports;
  readonly trials: LedgerTrials;
  readonly sources: LedgerSources;
  readonly claims: LedgerClaims;
  readonly hypotheses: LedgerHypotheses;
  readonly reports: LedgerReports;
  readonly laneFiles: LedgerLaneFiles;
  readonly messages: LedgerMessages;
  readonly cards: LedgerCards;
  readonly reviews: LedgerReviews;
  readonly audits: LedgerAudits;
  readonly conclusions: LedgerConclusions;
  readonly journal: LedgerJournal;
  readonly propagations: LedgerPropagations;
  /** The whole text of every prompt a run's agents were sent (goal 166). */
  readonly prompts: LedgerPrompts;
  private readonly clock: () => Date;

  private constructor(db: DatabaseSync, clock: () => Date) {
    this.db = db;
    this.events = new LedgerEvents(db);
    this.clock = clock;
    this.contracts = new LedgerContracts(this, db, clock);
    this.runs = new LedgerRuns(this, db, clock);
    this.champions = new LedgerChampions(this, db, clock);
    this.attempts = new LedgerAttempts(this, db, clock);
    this.jobs = new LedgerJobs(this, db, clock);
    this.measurements = new LedgerMeasurements(this, db, clock);
    this.heldOut = new LedgerHeldOut(this, db, clock);
    this.builds = new LedgerBuilds(this, db, clock);
    this.verdicts = new LedgerVerdicts(this, db, clock);
    this.commands = new LedgerCommands(this, db, clock);
    this.directives = new LedgerDirectives(this, db, clock);
    this.experiments = new LedgerExperiments(this, db, clock);
    this.goals = new LedgerGoals(this, db, clock);
    this.imports = new LedgerImports(this, db, clock);
    this.exports = new LedgerExports(this, db, clock);
    this.trials = new LedgerTrials(this, db, clock);
    this.sources = new LedgerSources(this, db, clock);
    this.claims = new LedgerClaims(this, db, clock);
    this.hypotheses = new LedgerHypotheses(this, db, clock);
    this.reports = new LedgerReports(this, db, clock);
    this.laneFiles = new LedgerLaneFiles(this, db, clock);
    this.messages = new LedgerMessages(this, db, clock);
    this.cards = new LedgerCards(this, db, clock);
    this.reviews = new LedgerReviews(this, db, clock);
    this.audits = new LedgerAudits(this, db, clock);
    this.conclusions = new LedgerConclusions(this, db, clock);
    this.journal = new LedgerJournal(this, db, clock);
    this.propagations = new LedgerPropagations(this, db, clock);
    this.prompts = new LedgerPrompts(this, db, clock);
  }

  static open(path: string, clock: () => Date = () => new Date()): Ledger {
    const db = openDatabase(path);
    const ledger = new Ledger(db, clock);
    migrateLedger(
      db,
      path,
      (fn) => ledger.tx(fn),
      (m) => new LedgerError("invalid", m),
    );
    // A new ledger gets a fresh id, so readers can tell a reset ledger from the old one.
    db.prepare("insert or ignore into meta (key, value) values ('ledger_id', ?)").run(randomUUID());
    return ledger;
  }

  close(): void {
    this.db.close();
  }

  /**
   * A consistent copy of the whole ledger in a new file at `path`, without the tables named in
   * `without`.
   */
  copyTo(path: string, without: readonly string[] = []): void {
    this.db.exec(`vacuum into '${path.replace(/'/g, "''")}'`);
    if (!without.length) return;
    const copy = new DatabaseSync(path);
    copy.exec(`${without.map((t) => `drop table if exists ${t};`).join(" ")} vacuum;`);
    copy.close();
  }

  /** Random id created with the ledger. Event ids are only unique within one ledger id. */
  ledgerId(): string {
    return String(this.get<Row>("select value from meta where key = 'ledger_id'")?.value);
  }

  /** After a wipe: commands issued before this time belonged to the old ledger. */
  notBefore(): string | undefined {
    const r = this.get<Row>("select value from meta where key = 'not_before'");
    return r ? String(r.value) : undefined;
  }

  setNotBefore(at: string): void {
    this.run("insert or replace into meta (key, value) values ('not_before', ?)", at);
  }

  private now(): string {
    return this.clock().toISOString();
  }

  /** Runs fn in an immediate transaction. Nested calls become savepoints of the outer one. */
  tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: SQLInputValue[]): { changes: number; id: number } {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }

  // ---------------------------------------------------------------- events

  appendEvent: AppendEvent = (actor, kind, subject, body) =>
    this.run(
      "insert into event (at, actor, kind, subject, body, run) values (?, ?, ?, ?, ?, ?)",
      this.now(),
      actor,
      kind,
      subject,
      canonicalJson(body ?? {}),
      eventRun(this.db, kind, subject, body),
    ).id;

  /** The body of the newest event of a kind about a subject, if any. */
  latestEventBody(kind: string, subject: string): Record<string, unknown> | undefined {
    return this.events.newest(kind as EventKind, { subject })?.body as Record<string, unknown>;
  }

  /** Events strictly after the cursor, in order. The next cursor is the last id returned. */
  eventsAfter(cursor: number, limit = 500): { events: LedgerEvent[]; next: number } {
    const rows = this.all<Row>(
      "select id, at, actor, kind, subject, body, run from event where id > ? order by id limit ?",
      cursor,
      limit,
    );
    // Events recorded before the 2026-10-15 rename are read under the new names.
    const events = rows.map((r) =>
      currentEvent({
        id: Number(r.id),
        at: String(r.at),
        actor: String(r.actor),
        kind: String(r.kind),
        subject: r.subject === null ? null : String(r.subject),
        body: JSON.parse(String(r.body)),
        run: r.run === null ? null : String(r.run),
      }),
    );
    return { events, next: events.length ? (events[events.length - 1] as LedgerEvent).id : cursor };
  }

  latestEventId(): number {
    return Number(this.get<Row>("select coalesce(max(id), 0) as id from event")?.id ?? 0);
  }

  /** Whether an event of any kind but `except` was recorded after event `id`. */
  recordedAfter(id: number, except: readonly string[] = []): boolean {
    const notIn = except.length ? ` and kind not in (${except.map(() => "?").join(", ")})` : "";
    return !!this.get<Row>(`select 1 from event where id > ?${notIn} limit 1`, id, ...except);
  }

  // ---------------------------------------------------------------- contracts and runs

  // ---------------------------------------------------------------- champions

  // ---------------------------------------------------------------- attempts

  // ---------------------------------------------------------------- jobs and leases

  // ---------------------------------------------------------------- measurements, receipts, verdicts

  // ---------------------------------------------------------------- commands, directives, imports

  // ---------------------------------------------------------------- the experiment queue

  /** A compact current-state summary for the supervisor's report. */
  summary(): unknown {
    return {
      ledger_id: this.ledgerId(),
      runs: this.runs.list().map((i) => {
        const champ = this.champions.current(i.id);
        return {
          id: i.id,
          campaign: i.campaign,
          version: i.version,
          mode: i.mode,
          status: i.status,
          pause_reason: i.pause_reason,
          champion: {
            seq: champ.seq,
            commit: champ.commit_sha,
            reopened: this.champions.reopened(i.id),
          },
          attempts: this.attempts.lifecycles(i.id),
        };
      }),
      jobs: this.jobs.states(),
      latest_event: this.latestEventId(),
    };
  }
}
