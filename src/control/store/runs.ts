import type { DatabaseSync } from "node:sqlite";
import { StorePart } from "./part.ts";

/**
 * Control's run registry (goal 170): every run control signed an assignment for, and every run a
 * rig reported creating, by run and rig, with the campaign, the assignment and the rig's ledger.
 * A run's name is used while its assignment is pending or delivered, or once a rig created it;
 * the command's own status stays the one record of whether it went through. Runs named before
 * goal 170 may share a name across rigs, hence a row for each rig.
 */

/** The registry's table, and its rows from the commands and the events control already holds. */
export function runRegistryTable(db: DatabaseSync): void {
  db.exec(`create table if not exists run_registry (
  run text not null,
  rig text not null,
  campaign text,
  command text,
  assigned_at text,
  ledger_id text,
  created_at text,
  primary key (run, rig)
)`);
  db.exec(`insert into run_registry (run, rig, campaign, command, assigned_at)
  select json_extract(signed, '$.envelope.payload.run'), rig,
    json_extract(signed, '$.envelope.payload.contract.campaign'), id, issued_at
  from command where kind = 'assign_campaign'
    and json_extract(signed, '$.envelope.payload.run') is not null
  order by issued_at
  on conflict (run, rig) do update set campaign = excluded.campaign, command = excluded.command,
    assigned_at = excluded.assigned_at`);
  db.exec(`insert into run_registry (run, rig, campaign, ledger_id, created_at)
  select subject, rig, json_extract(body, '$.campaign'), ledger_id, at
  from rig_event where kind in ('run_created', 'instance_created') and subject is not null
  order by seq
  on conflict (run, rig) do update set ledger_id = excluded.ledger_id,
    created_at = excluded.created_at, campaign = coalesce(run_registry.campaign, excluded.campaign)`);
}

/** The registry's rows whose name is used: created on a rig, or assigned and not refused. */
const USED = `select r.run, r.rig, r.campaign, r.command, r.created_at, r.assigned_at
  from run_registry r left join command c on c.id = r.command
  where r.ledger_id is not null or c.status in ('pending', 'delivered')`;

/** A run a rig created, as the registry has it: where it ran, its campaign and its ledger. */
export interface RegisteredRun {
  run: string;
  rig: string;
  /** Its campaign; null for a run assigned without one, which is its own campaign. */
  campaign: string | null;
  ledger_id: string;
  created_at: string | null;
}

const CREATED = `select run, rig, campaign, ledger_id, created_at from run_registry
  where ledger_id is not null`;

const registered = (r: Record<string, unknown>): RegisteredRun => ({
  run: String(r.run),
  rig: String(r.rig),
  campaign: r.campaign === null ? null : String(r.campaign),
  ledger_id: String(r.ledger_id),
  created_at: r.created_at === null ? null : String(r.created_at),
});

export class RunRegistry extends StorePart {
  /**
   * The run a rig created by this name. A name used on more than one rig before goal 170, or
   * again after a full reset, stands for the run control assigned, else the newest of that name.
   */
  created(run: string): RegisteredRun | undefined {
    const row = this.db
      .prepare(
        `${CREATED} and run = ? order by (command is not null) desc, created_at desc limit 1`,
      )
      .get(run) as Record<string, unknown> | undefined;
    return row ? registered(row) : undefined;
  }

  /** The run a rig created by this name, on that rig: in its newest ledger that has one. */
  createdOn(run: string, rig: string): RegisteredRun | undefined {
    const row = this.db.prepare(`${CREATED} and run = ? and rig = ?`).get(run, rig) as
      | Record<string, unknown>
      | undefined;
    return row ? registered(row) : undefined;
  }

  /**
   * The campaign of the run a rig created by this name; undefined while the rig has not reported
   * creating it, or for a run created without one.
   */
  campaignOf(run: string, rig: string): string | undefined {
    return this.createdOn(run, rig)?.campaign ?? undefined;
  }

  /**
   * Every run of a campaign that a rig created, newest first, one for each name (its newest), on
   * every rig and every ledger: retired rigs and runs from before a full reset too.
   */
  ofCampaign(campaign: string): RegisteredRun[] {
    const rows = this.db
      .prepare(`${CREATED} and coalesce(campaign, run) = ? order by created_at desc`)
      .all(campaign) as Record<string, unknown>[];
    const newest = new Map<string, RegisteredRun>();
    for (const r of rows.map(registered)) if (!newest.has(r.run)) newest.set(r.run, r);
    return [...newest.values()];
  }

  /**
   * The newest assignment control signed for a run's name, whatever became of it: the rig, the
   * campaign and the command. What a run's page shows until the rig reports the run.
   */
  assigned(run: string): { rig: string; campaign: string | null; command: string } | undefined {
    return this.db
      .prepare(
        `select rig, campaign, command from run_registry where run = ? and command is not null
         order by assigned_at desc limit 1`,
      )
      .get(run) as { rig: string; campaign: string | null; command: string } | undefined;
  }

  /** The ledger a rig created a run in; undefined while the rig has not reported the run. */
  ledgerOf(run: string, rig: string): string | undefined {
    const row = this.db
      .prepare("select ledger_id from run_registry where run = ? and rig = ?")
      .get(run, rig) as { ledger_id: string | null } | undefined;
    return row?.ledger_id ?? undefined;
  }

  /** The rigs a run's name is used on (created, or assigned and not refused), newest first. */
  rigsOf(run: string): string[] {
    const rows = this.db
      .prepare(
        `select rig from (${USED}) where run = ? order by coalesce(created_at, assigned_at) desc`,
      )
      .all(run) as { rig: string }[];
    return rows.map((r) => r.rig);
  }

  /** A command control signed: an assignment's run on its rig, for its campaign; others are not. */
  registerAssignment(e: {
    id: string;
    rig: string;
    kind: string;
    issued_at: string;
    payload: unknown;
  }): void {
    const p = e.payload as { run?: unknown; contract?: { campaign?: unknown } } | null;
    if (e.kind !== "assign_campaign" || typeof p?.run !== "string") return;
    const campaign = typeof p.contract?.campaign === "string" ? p.contract.campaign : null;
    const a = { run: p.run, rig: e.rig, campaign, command: e.id, at: e.issued_at };
    this.db
      .prepare(
        `insert into run_registry (run, rig, campaign, command, assigned_at) values (?, ?, ?, ?, ?)
         on conflict (run, rig) do update set campaign = excluded.campaign,
           command = excluded.command, assigned_at = excluded.assigned_at`,
      )
      .run(a.run, a.rig, a.campaign, a.command, a.at);
  }

  /**
   * An event a rig reported: a run it created goes in the registry, with the rig's ledger, when
   * control assigned that rig the run, or when no assignment uses its name (a rig check, a run
   * started on the rig itself). An assigned run's campaign is its assignment's. A run control did
   * not assign keeps the campaign its event names only when control knows no campaign of that
   * name (none saved, none assigned); otherwise it is its own. A run whose name control assigned
   * another rig is "refused", and the registry keeps nothing of it.
   */
  registerRunCreated(
    rig: string,
    ledgerId: string,
    e: { kind: string; subject: string | null; body: unknown; at: string },
  ): "taken" | "refused" | "none" {
    if (e.kind !== "run_created" || !e.subject) return "none";
    const run = e.subject;
    const assigned = this.db
      .prepare(
        `select r.rig, r.ledger_id, c.status from run_registry r join command c on c.id = r.command
         where r.run = ?`,
      )
      .all(run) as { rig: string; ledger_id: string | null; status: string }[];
    const own = assigned.some((a) => a.rig === rig);
    const elsewhere = assigned.some(
      (a) =>
        a.rig !== rig &&
        (a.ledger_id !== null || a.status === "pending" || a.status === "delivered"),
    );
    if (!own && elsewhere) return "refused";
    const named = (e.body as { campaign?: unknown } | null)?.campaign;
    const claimed = typeof named === "string" && !this.knowsCampaign(named) ? named : null;
    this.db
      .prepare(
        `insert into run_registry (run, rig, campaign, ledger_id, created_at) values (?, ?, ?, ?, ?)
         on conflict (run, rig) do update set ledger_id = excluded.ledger_id,
           created_at = excluded.created_at,
           campaign = case when run_registry.command is null then excluded.campaign
             else run_registry.campaign end`,
      )
      .run(run, rig, own ? null : claimed, ledgerId, e.at);
    return "taken";
  }

  /** Whether control has a campaign of this name: saved, or named by an assignment it signed. */
  private knowsCampaign(campaign: string): boolean {
    return (
      this.db
        .prepare(
          `select 1 from campaign_version where campaign = ?
           union all select 1 from run_registry where campaign = ? and command is not null
           limit 1`,
        )
        .get(campaign, campaign) !== undefined
    );
  }

  /**
   * Each rig's runs, newest first, `max` at most for each rig: those it created, and those control
   * assigned it that were not refused. What the rig's user on the message bus may publish the
   * live lines of.
   */
  runsByRig(max: number): Map<string, string[]> {
    const rows = this.db
      .prepare(`select run, rig from (${USED}) order by coalesce(created_at, assigned_at) desc`)
      .all() as { run: string; rig: string }[];
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const runs = out.get(r.rig) ?? [];
      if (runs.length < max) runs.push(r.run);
      out.set(r.rig, runs);
    }
    return out;
  }

  /** The run names used so far that start with `prefix`. */
  usedNames(prefix = ""): Set<string> {
    const like = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = this.db
      .prepare(`select run from (${USED}) where run like ? escape '\\'`)
      .all(like) as { run: string }[];
    return new Set(rows.map((r) => r.run));
  }

  /** The rig a run's name was used on, or undefined while it is free. */
  rigOfName(run: string): string | undefined {
    const row = this.db.prepare(`select rig from (${USED}) where run = ? limit 1`).get(run) as
      | { rig: string }
      | undefined;
    return row?.rig;
  }

  /**
   * The campaigns control itself assigned to a rig, by run: its signed assignments that did not
   * fail, expire or get refused. What a rig may read and be given is decided from these, never
   * from what the rig's own events claim.
   */
  assignedCampaigns(rig: string): Map<string, string> {
    const rows = this.db
      .prepare(
        `select r.run, r.campaign from run_registry r join command c on c.id = r.command
         where r.rig = ? and r.campaign is not null
           and c.status not in ('failed', 'rejected', 'expired')
         order by r.assigned_at`,
      )
      .all(rig) as { run: string; campaign: string }[];
    return new Map(rows.map((r) => [r.run, r.campaign]));
  }
}
