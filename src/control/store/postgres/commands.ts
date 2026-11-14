import { canonicalJson } from "../../../core/canonical.ts";
import type { SignedCommand } from "../../../core/commands.ts";
import { type KbWrites, kbWritesOf } from "../../../core/kb/index.ts";
import { type McpUse, McpUses } from "../../../core/mcp.ts";
import { currentCommand } from "../../../core/names.ts";
import {
  type CommandRow,
  commandRowOf,
  type Decision,
  type IssuedCommands,
  namedIn,
} from "../commands.ts";
import { jsonPart, jsonText, PgPart, type Row } from "./part.ts";

/** IssuedCommands on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresIssuedCommands extends PgPart implements IssuedCommands {
  async enqueue(signed: SignedCommand): Promise<void> {
    const e = signed.envelope;
    const { run, campaign } = namedIn(e.payload);
    await this.q.run(
      "insert into command (id, rig, kind, signed, issued_by, issued_at, status, run, campaign) values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      e.id,
      e.rig,
      e.kind,
      canonicalJson(signed),
      e.issued_by,
      e.issued_at,
      run,
      campaign,
    );
    await this.store.runRegistry.registerAssignment(e);
    await this.store.auditLog.add(e.issued_by, "command_issued", {
      id: e.id,
      rig: e.rig,
      kind: e.kind,
    });
  }

  /** The rigs with a pending command. */
  async rigsWithPending(): Promise<string[]> {
    const rows = (await this.q.all(
      "select distinct rig from command where status = 'pending' order by rig",
    )) as { rig: string }[];
    return rows.map((r) => r.rig);
  }

  /** A rig's pending commands, oldest first. Expired ones are marked expired, not relayed. */
  async pending(rig: string): Promise<SignedCommand[]> {
    const now = Date.now();
    const out: SignedCommand[] = [];
    for (const r of (await this.q.all(
      "select id, signed from command where rig = ? and status = 'pending' order by issued_at, rowid",
      rig,
    )) as Row[]) {
      const cmd = JSON.parse(String(r.signed)) as SignedCommand;
      if (Date.parse(cmd.envelope.expires_at) < now) {
        await this.q.run(
          "update command set status = 'expired', acked_at = ? where id = ? and status = 'pending'",
          new Date().toISOString(),
          String(r.id),
        );
        await this.store.auditLog.add("control", "command_expired", { id: String(r.id), rig });
        continue;
      }
      out.push(cmd);
    }
    return out;
  }

  /**
   * A harness's own record of a command it applied, from the rig's report: the only outcome
   * control takes (signed with the rig's key).
   */
  async confirmApplied(
    rig: string,
    id: string,
    status: "delivered" | "failed",
    outcome: string,
    at: string,
  ): Promise<void> {
    await this.q.run(
      "update command set status = ?, outcome = ?, acked_at = coalesce(acked_at, ?) where id = ? and rig = ?",
      status,
      outcome,
      at,
      id,
      rig,
    );
  }

  /**
   * A command the rig's harness refused (its command_rejected event names it): its signature, its
   * rig, its time or its payload. Only a command still pending: one the harness recorded an
   * outcome for keeps it.
   */
  async confirmRejected(rig: string, id: string, outcome: string, at: string): Promise<void> {
    await this.q.run(
      "update command set status = 'rejected', outcome = ?, acked_at = ? where id = ? and rig = ? and status = 'pending'",
      outcome,
      at,
      id,
      rig,
    );
  }

  /** A pending command signed again with a later expiry, while its sources still stage. */
  async renew(id: string, signed: string): Promise<void> {
    await this.q.run(
      "update command set signed = ? where id = ? and status = 'pending'",
      signed,
      id,
    );
  }

  /** The owner withdraws a command that has not been delivered. */
  async cancel(id: string, actor: string): Promise<boolean> {
    const r = await this.q.run(
      "update command set status = 'failed', outcome = ?, acked_at = ? where id = ? and status = 'pending'",
      canonicalJson({ cancelled_by: actor }),
      new Date().toISOString(),
      id,
    );
    if (Number(r.changes)) await this.store.auditLog.add(actor, "command_cancelled", { id });
    return Number(r.changes) > 0;
  }

  /**
   * The Git accesses the rig's live assignments name in an import: the only ones control gives the
   * rig, and only while they last. Live: pending or delivered, and its run not among the rig's
   * `closed` runs. Sorted, each once.
   */
  async gitAccessesOf(rig: string, closed: ReadonlySet<string>): Promise<string[]> {
    const rows = (
      (await this.q.all(
        `select run, signed from command where rig = ? and kind = 'assign_campaign'
           and status in ('pending', 'delivered')`,
        rig,
      )) as { run: string | null; signed: string }[]
    ).filter((r) => r.run === null || !closed.has(r.run));
    const names = new Set<string>();
    for (const r of rows) {
      try {
        const payload = (
          JSON.parse(r.signed) as {
            envelope?: {
              payload?: {
                imports?: { source?: { access?: string } }[];
                results?: { access?: string };
              };
            };
          }
        ).envelope?.payload;
        for (const i of payload?.imports ?? []) if (i.source?.access) names.add(i.source.access);
        // The access its run's branches are pushed with (goal 185).
        if (payload?.results?.access) names.add(payload.results.access);
      } catch {
        // A row control signed is JSON: one that is not names no access.
      }
    }
    return [...names].sort();
  }

  /**
   * The runs of a campaign that control has sent a rig to start or resume, and that the rig has
   * not taken yet: its pending assign_campaign commands, and pending resume_run commands of its
   * runs. Expired ones are left out. An assignment the rig took in the last ten minutes, whose run
   * it has not reported yet, waits too.
   */
  async pendingStarts(campaign: string): Promise<{ rig: string; run: string; kind: string }[]> {
    const now = Date.now();
    const out: { rig: string; run: string; kind: string }[] = [];
    const assigned = new Map<string, Map<string, string>>();
    const since = new Date(now - 10 * 60_000).toISOString();
    // An assignment names its campaign; a resume's is its run's, from the run registry.
    for (const r of (await this.q.all(
      `select rig, kind, status, run, campaign, ${jsonText("signed", "envelope", "expires_at")} as expires_at
         from command where kind in ('assign_campaign', 'resume_run') and run <> ''
           and (status = 'pending' or (status = 'delivered' and kind = 'assign_campaign' and acked_at > ?))
           and (kind = 'resume_run' or campaign = ?)
         order by issued_at, rowid`,
      since,
      campaign,
    )) as Row[]) {
      const rig = String(r.rig);
      const run = String(r.run);
      if (r.status === "pending" && Date.parse(String(r.expires_at ?? "")) < now) continue;
      // Taken: it waits only until the rig reports the run.
      if (
        r.status === "delivered" &&
        (await this.store.runRegistry.campaignOf(run, rig)) !== undefined
      )
        continue;
      let of: string | undefined;
      if (r.kind === "assign_campaign") of = String(r.campaign);
      else {
        if (!assigned.has(rig))
          assigned.set(rig, await this.store.runRegistry.assignedCampaigns(rig));
        of = assigned.get(rig)?.get(run) ?? (await this.store.runRegistry.campaignOf(run, rig));
      }
      if (of === campaign) out.push({ rig, run, kind: String(r.kind) });
    }
    return out;
  }

  /**
   * The newest assignment control signed for each campaign, on any rig: what a new run of a
   * campaign assigned over the API, MCP or the CLI starts from. Failed and expired ones are left
   * out.
   */
  async latestAssignments(): Promise<
    Map<
      string,
      { id: string; rig: string; run: string; payload: Record<string, unknown>; issued_at: string }
    >
  > {
    const rows = (await this.q.all(
      "select id, rig, campaign, issued_at from command where kind = 'assign_campaign' and campaign is not null and status in ('pending', 'delivered') order by issued_at desc, rowid desc",
    )) as { id: string; rig: string; campaign: string; issued_at: string }[];
    const out = new Map<
      string,
      { id: string; rig: string; run: string; payload: Record<string, unknown>; issued_at: string }
    >();
    // The newest of each campaign's alone is read: a campaign in its column is in its JSON.
    const signed = "select signed from command where id = ?";
    for (const r of rows) {
      if (out.has(r.campaign)) continue;
      const { signed: json } = (await this.q.get(signed, r.id)) as { signed: string };
      // Signed before v0.1.1, it is read under the public names (core/names.ts).
      const payload = currentCommand(
        "assign_campaign",
        (JSON.parse(json) as { envelope: { payload: Record<string, unknown> } }).envelope.payload,
      );
      out.set(r.campaign, {
        id: r.id,
        rig: r.rig,
        run: String(payload.run ?? ""),
        payload,
        issued_at: r.issued_at,
      });
    }
    return out;
  }

  /**
   * The newest owner message (message_agent) control sent to one run, and the rig's answer: refused
   * (with why), or not.
   */
  async lastMessageToRun(
    rig: string,
    run: string,
    to?: string,
  ): Promise<{ refused: string | null; issued_at: string } | undefined> {
    const rows = (await this.q.all(
      "select signed, status, outcome, issued_at from command where rig = ? and kind = 'message_agent' order by issued_at desc, rowid desc limit 30",
      rig,
    )) as Row[];
    for (const r of rows) {
      try {
        const payload = (
          JSON.parse(String(r.signed)) as { envelope?: { payload?: { run?: string; to?: string } } }
        ).envelope?.payload;
        if (payload?.run !== run || (to !== undefined && payload.to !== to)) continue;
        const out = r.outcome
          ? (JSON.parse(String(r.outcome)) as {
              accepted?: boolean;
              error?: string;
              result?: { error?: string };
            })
          : null;
        const failed = r.status === "failed" || r.status === "rejected" || out?.accepted === false;
        return {
          refused: failed ? (out?.result?.error ?? out?.error ?? String(r.status)) : null,
          issued_at: String(r.issued_at),
        };
      } catch {
        // not a command this store wrote
      }
    }
    return undefined;
  }

  async list(limit = 100): Promise<
    {
      id: string;
      rig: string;
      kind: string;
      issued_by: string;
      issued_at: string;
      status: string;
      acked_at: string | null;
      outcome: unknown;
    }[]
  > {
    return (
      (await this.q.all(
        "select id, rig, kind, issued_by, issued_at, status, acked_at, outcome from command order by issued_at desc, rowid desc limit ?",
        limit,
      )) as Row[]
    ).map((r) => ({
      id: String(r.id),
      rig: String(r.rig),
      kind: String(r.kind),
      issued_by: String(r.issued_by),
      issued_at: String(r.issued_at),
      status: String(r.status),
      acked_at: r.acked_at === null ? null : String(r.acked_at),
      outcome: r.outcome ? JSON.parse(String(r.outcome)) : null,
    }));
  }

  /**
   * The owner's decisions sent to rigs (promote, decline, accept a review, conclude), newest
   * first, with what each rig answered: so a decision shows as sent the moment it is made, not
   * only once the rig's next report arrives.
   */
  async decisions(limit = 200): Promise<Decision[]> {
    const rows = (await this.q.all(
      `select id, rig, kind, signed, issued_at, status, acked_at, outcome from command
         where kind in ('approve_promotion', 'decline_promotion', 'accept_review', 'conclude')
         order by issued_at desc, rowid desc limit ?`,
      limit,
    )) as Row[];
    return rows.map((r) => {
      let payload: Record<string, unknown> = {};
      try {
        payload =
          (JSON.parse(String(r.signed)) as { envelope?: { payload?: Record<string, unknown> } })
            .envelope?.payload ?? {};
      } catch {}
      return {
        id: String(r.id),
        rig: String(r.rig),
        kind: String(r.kind),
        run: typeof payload.run === "string" ? payload.run : "",
        attempt: typeof payload.attempt === "string" ? payload.attempt : undefined,
        review: typeof payload.review === "number" ? payload.review : undefined,
        proposal: typeof payload.proposal === "number" ? payload.proposal : undefined,
        accept: typeof payload.accept === "boolean" ? payload.accept : undefined,
        issued_at: String(r.issued_at),
        status: String(r.status),
        acked_at: r.acked_at === null ? null : String(r.acked_at),
        outcome: r.outcome ? (JSON.parse(String(r.outcome)) as Decision["outcome"]) : null,
      };
    });
  }

  async get(id: string): Promise<{ status: string; outcome: unknown } | undefined> {
    const r = (await this.q.get("select status, outcome from command where id = ?", id)) as
      | Row
      | undefined;
    return r
      ? { status: String(r.status), outcome: r.outcome ? JSON.parse(String(r.outcome)) : null }
      : undefined;
  }

  /**
   * Whether the rig never took a command: it refused it, or its signature ran out first. One the
   * owner withdrew counts as taken: it is not sent again.
   */
  async notTaken(id: string | undefined): Promise<boolean> {
    const c = id ? await this.get(id) : undefined;
    return (
      c !== undefined &&
      ["failed", "rejected", "expired"].includes(c.status) &&
      !(c.outcome as { cancelled_by?: unknown } | null)?.cancelled_by
    );
  }

  /**
   * One command as the dashboard follows it (goal 080): its state, the rig's answer, its payload
   * and when its signature runs out. A pending command past that time is one the rig never took.
   */
  async row(id: string): Promise<CommandRow | undefined> {
    const r = (await this.q.get(
      "select id, rig, kind, signed, issued_by, issued_at, status, outcome, acked_at from command where id = ?",
      id,
    )) as Row | undefined;
    return r ? commandRowOf(r) : undefined;
  }

  /** A rig's newest commands of one kind, newest first (a check's row follows its newest one). */
  async latest(rig: string, kind: string, limit = 20): Promise<CommandRow[]> {
    return (
      (await this.q.all(
        "select id, rig, kind, signed, issued_by, issued_at, status, outcome, acked_at from command where rig = ? and kind = ? order by issued_at desc, rowid desc limit ?",
        rig,
        kind,
        limit,
      )) as Row[]
    ).map(commandRowOf);
  }

  /**
   * The MCP servers each live run control assigned a rig names (its own signed commands, never the
   * rig's reports), by run. Live: its assignment pending or delivered, and the run not among the
   * rig's `closed` runs.
   */
  async assignedMcpServers(
    rig: string,
    closed: ReadonlySet<string>,
  ): Promise<Map<string, McpUse[]>> {
    const out = new Map<string, McpUse[]>();
    // Each assignment's MCP servers alone, as JSON, of those that name a run.
    for (const r of (await this.q.all(
      `select run, ${jsonPart("signed", "envelope", "payload", "mcp_servers")} as uses from command
         where rig = ? and kind = 'assign_campaign' and run is not null
           and status in ('pending', 'delivered')
         order by issued_at, rowid`,
      rig,
    )) as { run: string; uses: string | null }[]) {
      if (closed.has(r.run)) continue;
      const uses = McpUses.safeParse(r.uses === null ? [] : JSON.parse(r.uses)).data ?? [];
      if (uses.length) out.set(r.run, uses);
    }
    return out;
  }

  /**
   * What the campaign lets each role write in the knowledge base for a run control assigned this
   * rig (goal 175): its newest signed assignment's contract's `kb_writes`, or the default when it
   * sets none. Undefined for a run control did not assign the rig.
   */
  async assignedKbWrites(rig: string, run: string): Promise<KbWrites | undefined> {
    const r = (await this.q.get(
      `select ${jsonPart("signed", "envelope", "payload", "contract")} as contract from command
         where rig = ? and kind = 'assign_campaign' and run = ?
           and status not in ('failed', 'rejected', 'expired')
         order by issued_at desc, rowid desc limit 1`,
      rig,
      run,
    )) as { contract: string | null } | undefined;
    if (!r) return undefined;
    return kbWritesOf(r.contract === null ? undefined : JSON.parse(r.contract));
  }
}
