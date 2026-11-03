import { LedgerPart } from "./part.ts";

/** An owner's message to a run's agents, as its row holds it. */
export interface MessageRow {
  id: number;
  run: string;
  target: string;
  text: string;
  keep: number;
  created_at: string;
  unkept_at: string | null;
}

const COLS = "m.id, m.run, m.target, m.text, m.keep, m.created_at, m.unkept_at";

/**
 * The `agent_message` and `agent_message_read` tables: the owner's messages to a run's agents, and
 * each reader's receipt of one (a lane in a trial, the planner, an advisor role).
 */
export class LedgerMessages extends LedgerPart {
  get(id: number): MessageRow | undefined {
    return this.row<MessageRow>(`select ${COLS} from agent_message m where m.id = ?`, id);
  }

  /** A new message, sent at `at`: its id. */
  add(m: { run: string; to: string; text: string; by: string; at: string; keep: boolean }): number {
    return this.execute(
      "insert into agent_message (run, target, text, issued_by, created_at, keep) values (?, ?, ?, ?, ?, ?)",
      m.run,
      m.to,
      m.text,
      m.by,
      m.at,
      m.keep ? 1 : 0,
    ).id;
  }

  /** The owner ends a message kept in force, at `at`. */
  unkeep(id: number, at: string): void {
    this.execute("update agent_message set unkept_at = ? where id = ?", at, id);
  }

  /** The run's messages kept in force for a lane: to everyone working, or to the lane; oldest first. */
  inForce(run: string, lane: string): MessageRow[] {
    return this.rows<MessageRow>(
      `select ${COLS} from agent_message m where m.run = ? and m.keep = 1 and m.unkept_at is null and (m.target = 'all' or m.target = ?) order by m.id`,
      run,
      lane,
    );
  }

  /**
   * The messages in force that a trial's lane has not read: to the trial, to its lane, to everyone
   * working, and to an earlier trial of its lane that ended; oldest first.
   */
  unreadByTrial(trial: { id: string; run: string; lane: string }): MessageRow[] {
    return this.rows<MessageRow>(
      `select ${COLS} from agent_message m
         left join trial t on m.target = 'trial:' || t.id
         where m.run = ? and m.unkept_at is null
           and (m.target = ? or m.target = 'all' or m.target = ?
                or (t.run = m.run and t.lane = ? and t.ended_at is not null))
           and not exists (select 1 from agent_message_read r where r.message = m.id and r.reader = ?)
         order by m.id`,
      trial.run,
      trial.lane,
      `trial:${trial.id}`,
      trial.lane,
      trial.lane,
    );
  }

  /** The messages in force to the planner or to everyone working that it has not read, oldest first. */
  unreadByPlanner(run: string): MessageRow[] {
    return this.rows<MessageRow>(
      `select ${COLS} from agent_message m where m.run = ? and m.unkept_at is null and m.target in ('planner', 'all')
           and not exists (select 1 from agent_message_read r where r.message = m.id and r.reader = 'planner')
           order by m.id`,
      run,
    );
  }

  /** The first `limit` messages to an advisor role or to all the advisors that it has not read. */
  unreadByRole(run: string, role: string, limit: number): MessageRow[] {
    return this.rows<MessageRow>(
      `select ${COLS} from agent_message m where m.run = ? and m.target in (?, 'advisors')
           and not exists (select 1 from agent_message_read r where r.message = m.id and r.reader = ?)
           order by m.id limit ?`,
      run,
      role,
      role,
      limit,
    );
  }

  /** The newest five messages to the teachers or to all the advisors that they read since `since`. */
  readByTeachers(run: string, since: string): MessageRow[] {
    return this.rows<MessageRow>(
      `select ${COLS} from agent_message m where m.run = ? and m.target in ('teachers', 'advisors')
           and exists (select 1 from agent_message_read r where r.message = m.id and r.reader = 'teachers' and r.read_at >= ?)
           order by m.id desc limit 5`,
      run,
      since,
    );
  }

  /** The trials in which a reader read a message (null: read outside a trial). */
  readIn(id: number, reader: string): (string | null)[] {
    return this.rows<{ trial: string | null }>(
      "select trial from agent_message_read where message = ? and reader = ?",
      id,
      reader,
    ).map((r) => r.trial);
  }

  /**
   * A reader read a message at `at`, in a trial or not: its receipt, and the message's first
   * delivery, to the trial or else the reader, unless it was delivered before.
   */
  recordRead(id: number, reader: string, trial: string | null, at: string): void {
    this.execute(
      "insert into agent_message_read (message, reader, trial, read_at) values (?, ?, ?, ?)",
      id,
      reader,
      trial,
      at,
    );
    this.execute(
      "update agent_message set delivered_at = ?, delivered_to = ? where id = ? and delivered_at is null",
      at,
      trial !== null ? `trial:${trial}` : reader,
      id,
    );
  }
}
