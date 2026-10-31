import { gunzipSync, gzipSync } from "node:zlib";
import { ROLES } from "../../agents/roles/index.ts";
import {
  PromptRecord,
  type PromptRecordInput,
  type PromptSection,
  promptEventBody,
  roleVersion,
  sha256,
} from "../../core/prompts.ts";
import { LedgerPart, type Row } from "./part.ts";

/** A prompt kept, without its text: what a list of a run's prompts shows. */
export interface PromptRow {
  id: number;
  run: string;
  role: string;
  program: string;
  /** Its place among the messages its call was sent: 0 for the first, 1 for the first later turn. */
  turn: number;
  lane: string | null;
  trial: string | null;
  call: string | null;
  version: string;
  at: string;
  chars: number;
  /** Its size compressed, in bytes. */
  bytes: number;
}

/** The fixed texts of the roles' definitions, by sha256: an event names them, never sends them. */
const FIXED = new Set(ROLES.flatMap((r) => r.texts.map((t) => sha256(t.text))));

const COLS =
  "id, run, role, program, turn, lane, trial, call, version, at, chars, length(text_gz) as bytes";

const toRow = (r: Row): PromptRow => ({
  id: Number(r.id),
  run: String(r.run),
  role: String(r.role),
  program: String(r.program),
  turn: Number(r.turn),
  lane: r.lane === null ? null : String(r.lane),
  trial: r.trial === null ? null : String(r.trial),
  call: r.call === null ? null : String(r.call),
  version: String(r.version),
  at: String(r.at),
  chars: Number(r.chars),
  bytes: Number(r.bytes),
});

/**
 * Migration 24: the `prompt` table (goal 166), the whole text of every prompt a run's agents were
 * sent, its sections as JSON, compressed with gzip.
 */
export const PROMPT_TABLE = `
create table prompt (
  id integer primary key autoincrement,
  run text not null,
  role text not null,
  program text not null,
  lane text,
  trial text,
  call text,
  version text not null,
  at text not null,
  chars integer not null,
  text_gz blob not null
);
create index prompt_run on prompt (run, id);
`;

/**
 * Migration 25: which turn of its call each prompt was (goal 166), its place among the messages
 * the call was sent: 0 for the first, as every prompt kept before was; 1 for the first later turn.
 */
export const PROMPT_TURN_COLUMN = "alter table prompt add column turn integer not null default 0;";

/**
 * The `prompt` table (goal 166): each prompt a run's agents were sent, a call's first message or
 * a later turn in it, kept whole and compressed, with an `agent_prompt` event about its run, which
 * reaches control with its sections and sources. Nothing reads a kept prompt back into another
 * prompt.
 */
export class LedgerPrompts extends LedgerPart {
  /** Keeps a prompt sent in `run`; returns its number. */
  record(actor: string, run: string, r: PromptRecordInput): number {
    const prompt = PromptRecord.parse(r);
    return this.tx(() => {
      const body = promptEventBody(0, prompt, FIXED);
      const id = this.execute(
        `insert into prompt (run, role, program, turn, lane, trial, call, version, at, chars, text_gz)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        run,
        prompt.role,
        prompt.program,
        prompt.turn,
        prompt.lane,
        prompt.trial,
        prompt.call,
        roleVersion(prompt.sections),
        this.now(),
        body.chars,
        gzipSync(JSON.stringify(prompt.sections)),
      ).id;
      this.appendEvent(actor, "agent_prompt", run, { ...body, id });
      return id;
    });
  }

  /** A run's prompts, oldest first, without their text. */
  list(run: string): PromptRow[] {
    return this.rows<Row>(`select ${COLS} from prompt where run = ? order by id`, run).map(toRow);
  }

  /** The prompts with these numbers, oldest first, without their text. */
  byIds(ids: readonly number[]): PromptRow[] {
    if (!ids.length) return [];
    return this.rows<Row>(
      `select ${COLS} from prompt where id in (${ids.map(() => "?").join(", ")}) order by id`,
      ...ids,
    ).map(toRow);
  }

  /** One prompt with its sections whole; undefined when there is none. */
  get(id: number): (PromptRow & { sections: PromptSection[] }) | undefined {
    const r = this.row<Row>(`select ${COLS}, text_gz from prompt where id = ?`, id);
    if (!r) return undefined;
    const sections = JSON.parse(
      gunzipSync(r.text_gz as Uint8Array).toString("utf8"),
    ) as PromptSection[];
    return { ...toRow(r), sections };
  }
}
