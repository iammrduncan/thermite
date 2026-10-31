import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../../core/canonical.ts";
import type { AskOwner } from "../../core/commands.ts";
import type { Contract } from "../../core/contract.ts";
import { LedgerError, LedgerPart, type Row } from "./part.ts";
import { type BriefingItem, type RunRow, toRun } from "./rows.ts";

/** The kinds whose subject is a job's number. */
const JOB_KINDS = new Set(["job_queued", "job_leased", "job_finished", "job_unblocked"]);
const isJobKind = (kind: string) =>
  JOB_KINDS.has(kind) || kind === "job_lease_expired" || kind === "crash_infra";

/**
 * The run an event is about (goal 170: every run-scoped event names its run), or null for the
 * rig's own events (a command, a check, the rig's settings). Worked out once, when the event is
 * recorded: its subject is the run, or its body names it, or its subject is one of a run's things
 * (an attempt, a trial, an experiment, a job), each found by its ID.
 */
export function eventRun(
  db: DatabaseSync,
  kind: string,
  subject: string | null,
  body: unknown,
): string | null {
  const one = (sql: string, arg: string | number) => {
    const r = db.prepare(sql).get(arg) as { run?: unknown } | undefined;
    return typeof r?.run === "string" ? r.run : null;
  };
  // A contract's subject is its campaign, which may share a run's name.
  if (kind === "contract_stored") return null;
  const named = (body as { run?: unknown } | null)?.run;
  if (subject !== null && one("select id as run from run where id = ?", subject)) return subject;
  if (typeof named === "string" && one("select id as run from run where id = ?", named))
    return named;
  if (subject === null) return null;
  if (isJobKind(kind) && /^\d+$/.test(subject))
    return one(
      `select coalesce(a.run, json_extract(j.spec, '$.run')) as run
         from job j left join attempt a on a.id = j.attempt where j.id = ?`,
      Number(subject),
    );
  return (
    one("select run from attempt where id = ?", subject) ??
    one("select run from trial where id = ?", subject) ??
    one("select run from experiment where id = ?", subject)
  );
}

/**
 * Migration 23: each event's run, in a column of its own with its index, for every event the
 * ledger already holds, worked out as eventRun does for a new one. Events stay append-only: the
 * update runs inside the migration, between the trigger's removal and its return.
 */
export function eventRunColumn(db: DatabaseSync): void {
  db.exec("alter table event add column run text");
  db.exec("drop trigger event_no_update");
  const rows = db.prepare("select id, kind, subject, body from event").all() as {
    id: number;
    kind: string;
    subject: string | null;
    body: string;
  }[];
  const set = db.prepare("update event set run = ? where id = ?");
  for (const r of rows) {
    const run = eventRun(db, r.kind, r.subject, JSON.parse(r.body));
    if (run !== null) set.run(run, r.id);
  }
  db.exec(
    "create trigger event_no_update before update on event begin select raise(abort, 'event is append-only'); end",
  );
  db.exec("create index event_run on event (run, id)");
}

/** The `run` and `run_briefing` tables: the runs, their briefings and their statuses. */
export class LedgerRuns extends LedgerPart {
  /**
   * Creates a campaign run from a stored contract. The seed commit becomes champion seq 1, the
   * run's starting point; a hill climb's judge measures it first, its baseline (goal 115).
   * Goal-mode runs also get their goal tree.
   */
  create(input: {
    id: string;
    contract: Contract;
    contractSha: string;
    seedRepo: string;
    seedCommit: string;
    /** A project in one folder of its repository: the folder, and the repository's commit. */
    seedFolder?: { folder: string; commit: string } | undefined;
    direction?: string | undefined;
    /** False: a judge-only run (no worker agents). */
    agents?: boolean | undefined;
    /** The run's own promotion policy (unset: the rig's default). */
    promotion?: "auto" | "owner_approval" | undefined;
    /** What else the run asks the owner about (goal 079). */
    askOwner?: AskOwner | undefined;
    /** Background from past research for every agent's brief, in order (goal 065). */
    briefing?: BriefingItem[] | undefined;
    actor: string;
  }): void {
    this.tx(() => {
      if (this.row<Row>("select id from run where id = ?", input.id)) {
        throw new LedgerError("conflict", `run ${input.id} already exists`);
      }
      const stored = this.row<Row>(
        "select sha from contract where campaign = ? and version = ?",
        input.contract.campaign,
        input.contract.version,
      );
      if (!stored || stored.sha !== input.contractSha) {
        throw new LedgerError("invalid", "run must reference a stored contract version");
      }
      const at = this.now();
      this.execute(
        `insert into run (id, campaign, version, contract_sha, mode, seed_repo, seed_commit,
           direction, status, agents, promotion, ask_owner, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
        input.id,
        input.contract.campaign,
        input.contract.version,
        input.contractSha,
        input.contract.mode,
        input.seedRepo,
        input.seedCommit,
        input.direction ?? null,
        input.agents === false ? 0 : 1,
        input.promotion ?? null,
        input.askOwner && Object.keys(input.askOwner).length ? canonicalJson(input.askOwner) : null,
        at,
        at,
      );
      this.execute(
        "insert into champion (run, seq, attempt, commit_sha, promoted_by, promoted_at) values (?, 1, null, ?, ?, ?)",
        input.id,
        input.seedCommit,
        `${input.actor}:seed`,
        at,
      );
      if (input.contract.mode === "goal") this.ledger.goals.create(input.id, input.contract.goals);
      const briefing = input.briefing ?? [];
      for (const [i, b] of briefing.entries())
        this.execute(
          `insert into run_briefing (run, seq, text, from_campaign, from_run, from_kind, from_ref)
             values (?, ?, ?, ?, ?, ?, ?)`,
          input.id,
          i + 1,
          b.text,
          b.from.campaign,
          b.from.run,
          b.from.kind,
          b.from.ref,
        );
      this.ledger.appendEvent(input.actor, "run_created", input.id, {
        campaign: input.contract.campaign,
        version: input.contract.version,
        mode: input.contract.mode,
        seed: {
          repo: input.seedRepo,
          commit: input.seedCommit,
          ...(input.seedFolder
            ? { folder: input.seedFolder.folder, source_commit: input.seedFolder.commit }
            : {}),
        },
        direction: input.direction ?? null,
        agents: input.agents !== false,
        promotion: input.promotion ?? null,
        ...(input.askOwner && Object.keys(input.askOwner).length
          ? { ask_owner: input.askOwner }
          : {}),
        ...(briefing.length ? { briefing: briefing.length } : {}),
        // The campaign's own context settings for the run's agents, when it sets any (goal 070):
        // with each agent's route, they say what the agents work with.
        ...(input.contract.agents_context && input.agents !== false
          ? { agents_context: input.contract.agents_context }
          : {}),
      });
    });
  }

  /** A run's background from past research, in the order the owner gave it. */
  briefing(run: string): BriefingItem[] {
    return this.rows<Row>(
      "select text, from_campaign, from_run, from_kind, from_ref from run_briefing where run = ? order by seq",
      run,
    ).map((r) => ({
      text: String(r.text),
      from: {
        campaign: String(r.from_campaign),
        run: String(r.from_run),
        kind: String(r.from_kind),
        ref: String(r.from_ref),
      },
    }));
  }

  get(id: string): RunRow | undefined {
    const r = this.row<Row>("select * from run where id = ?", id);
    return r ? toRun(r) : undefined;
  }

  list(): RunRow[] {
    return this.rows<Row>("select * from run order by created_at").map(toRun);
  }

  setStatus(id: string, status: RunRow["status"], reason: string | null, actor: string): void {
    this.tx(() => {
      const r = this.execute(
        "update run set status = ?, pause_reason = ?, updated_at = ? where id = ?",
        status,
        reason,
        this.now(),
        id,
      );
      if (r.changes === 0) throw new LedgerError("not_found", `no run ${id}`);
      this.ledger.appendEvent(actor, "run_status", id, { status, reason });
      if (status === "closed") this.ledger.jobs.endClosedRuns(actor, id);
    });
  }

  /** The ids of the runs in this mode and status, in id order. */
  ids(mode: string, status: RunRow["status"]): string[] {
    return this.rows<Row>(
      "select id from run where mode = ? and status = ? order by id",
      mode,
      status,
    ).map((r) => String(r.id));
  }

  /** When a run was created, if it was. */
  createdAt(id: string): string | undefined {
    const r = this.row<Row>("select created_at from run where id = ?", id);
    return r ? String(r.created_at) : undefined;
  }
}
