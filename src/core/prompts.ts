import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The record of every prompt sent (goal 166, the owner's decision 3): the whole text of each
 * prompt a run's agents are sent, a call's first message and each later turn in it (a nudge, a
 * warning, a continuation), with its sections and where each comes from. The harness keeps
 * it, compressed, in its ledger and puts it in the run's exports, never in the run's research
 * folder, which the workers read. Control gets one `agent_prompt` event for each prompt: its
 * sections, their sources and sizes, and their text up to PROMPT_EVENT_TEXT_CHARS, apart from a
 * fixed text of the role's definition, which the event names by its sha256 and control shows
 * from the definitions it has.
 */

/** Where a section goes: Pi's system text, or the message (a program gets one message). */
export const PROMPT_PARTS = ["system", "message"] as const;

/** The sources whose text is the role's or the program's own: the same for every run. */
export const OWN_SOURCES: readonly string[] = ["role", "program"];

/** The most text of a prompt that one event carries to control, in characters. */
export const PROMPT_EVENT_TEXT_CHARS = 8_000;

/** The most characters of one prompt the supervisor or a Pi worker sends the harness to keep. */
export const PROMPT_RECORD_MAX_CHARS = 4_000_000;

/** The most messages in one call that a record numbers. */
export const PROMPT_TURN_MAX = 1_000_000;

/** One section of a prompt sent, with its text. */
export const PromptSection = z.strictObject({
  id: z.string().min(1).max(64),
  source: z.string().min(1).max(64),
  part: z.enum(PROMPT_PARTS),
  text: z.string(),
  /** What came before it in the text sent; none: a newline. */
  sep: z.string().max(8).optional(),
});
export type PromptSection = z.infer<typeof PromptSection>;

/** A prompt sent, as it is kept: who it went to, where, and its sections whole. */
export const PromptRecord = z.strictObject({
  role: z.string().min(1).max(64),
  program: z.string().min(1).max(32),
  /** Its place among the messages its call was sent: 0 for the first, 1 for the first later turn. */
  turn: z.number().int().min(0).max(PROMPT_TURN_MAX).default(0),
  lane: z.string().min(1).max(64).nullable(),
  trial: z.string().min(1).max(100).nullable(),
  /** The call it started outside a trial: a round, an audit, a review, a paper. */
  call: z.string().min(1).max(200).nullable(),
  sections: z.array(PromptSection).min(1).max(200),
});
export type PromptRecord = z.infer<typeof PromptRecord>;
/** A record as a sender gives it: with no turn, the call's first message. */
export type PromptRecordInput = z.input<typeof PromptRecord>;

/** A section as the `agent_prompt` event gives it: its text only for what the run added. */
export interface PromptSectionInfo {
  id: string;
  source: string;
  part: (typeof PROMPT_PARTS)[number];
  chars: number;
  sha256: string;
  /** Its text, whole or cut (`cut`); none for a fixed text of the role's definition. */
  text?: string | undefined;
  cut?: boolean | undefined;
}

/** The `agent_prompt` event's body: the prompt's place, its role's version and its sections. */
export interface AgentPromptBody {
  /** The prompt's number in the rig's ledger: its whole text is there, and in the run's export. */
  id: number;
  role: string;
  program: string;
  /** Its place among the messages its call was sent: 0 for the first, 1 for the first later turn. */
  turn: number;
  lane: string | null;
  trial: string | null;
  call: string | null;
  /** The role's own text's version: the first 12 hex digits of its sha256. */
  version: string;
  chars: number;
  sections: PromptSectionInfo[];
}

/** A text's sha256, in hex: how an event names a fixed text of a role's definition. */
export const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

/** The text sent of one part: its sections in order, each after its separator. */
export function partText(sections: readonly PromptSection[], part: PromptSection["part"]): string {
  return sections
    .filter((s) => s.part === part)
    .map((s, i) => (i ? (s.sep ?? "\n") : "") + s.text)
    .join("");
}

/** The role's own text's version: the same texts give the same version, on every rig. */
export function roleVersion(sections: readonly PromptSection[]): string {
  const own = sections.filter((s) => OWN_SOURCES.includes(s.source)).map((s) => s.text);
  return sha256(own.join("\u0000")).slice(0, 12);
}

/**
 * The event's body for a prompt kept as `id`: every section's source and size, and its text, in
 * order, until PROMPT_EVENT_TEXT_CHARS are used; a section past that is cut, and says so. A section
 * whose sha256 is in `fixed` (the definitions' fixed texts) carries none.
 */
export function promptEventBody(
  id: number,
  r: PromptRecord,
  fixed: ReadonlySet<string> = new Set(),
): AgentPromptBody {
  let left = PROMPT_EVENT_TEXT_CHARS;
  const sections = r.sections.map((s): PromptSectionInfo => {
    const info = {
      id: s.id,
      source: s.source,
      part: s.part,
      chars: s.text.length,
      sha256: sha256(s.text),
    };
    if (fixed.has(info.sha256)) return info;
    const text = s.text.slice(0, Math.max(0, left));
    left -= text.length;
    return { ...info, text, ...(text.length < s.text.length ? { cut: true } : {}) };
  });
  return {
    id,
    role: r.role,
    program: r.program,
    turn: r.turn,
    lane: r.lane,
    trial: r.trial,
    call: r.call,
    version: roleVersion(r.sections),
    chars: partText(r.sections, "system").length + partText(r.sections, "message").length,
    sections,
  };
}
