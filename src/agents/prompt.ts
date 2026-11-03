import type { PromptRecord, PromptSection } from "../core/prompts.ts";

/**
 * A prompt as its sections (goal 166): each part of what a role is sent, with where it comes
 * from, so the owner can see what a run added to the role's own text. A role's render function
 * (src/agents/roles/) is the only maker of a Prompt: `prompt` and the section makers are for the
 * roles' modules alone, and a test fails when another file imports them. A send site takes a
 * Prompt and sends systemText and messageText (or userMessage, in Pi), which are the exact texts
 * sent. A later turn inside a call (a nudge, a warning, a continuation) is a Prompt too.
 */

/** Where a section comes from. */
export type Source =
  | "role"
  | "program"
  | "assignment"
  | "contract"
  | "campaign brief"
  | "queue"
  | "planner"
  | "judge"
  | "ledger"
  | "field notes and past research"
  | "owner"
  | "owner's addition"
  | "kit"
  | "rig"
  | "package"
  | "check"
  | "provider"
  | "compaction"
  | "left out";

export interface Section {
  /** A short id, unique within the prompt. */
  id: string;
  source: Source;
  text: string;
  /** What comes before it in the text sent, after the section before it: a newline by default. */
  sep?: string | undefined;
}

declare const RENDERED: unique symbol;

/**
 * A role's prompt for one call: its system text (Pi's system prompt; empty where a program takes
 * one message) and its first message, each in sections. A later turn in the call is one message,
 * with no system text.
 */
export interface Prompt {
  readonly [RENDERED]: true;
  /** The role's id (src/agents/roles/). */
  role: string;
  /** The agent program it is sent to: pi, opencode, claude-code, codex, or cli for a command. */
  program: string;
  /**
   * Its place among the messages Thermite sends in its call: 0 for the first message, 1 for the
   * first later turn, and so on.
   */
  turn: number;
  system: Section[];
  message: Section[];
}

/** A section; `sep` goes before it in the text sent (a newline by default). */
export function section(id: string, source: Source, text: string, sep?: string): Section {
  return { id, source, text, ...(sep !== undefined ? { sep } : {}) };
}

/** A section made of lines: its non-empty lines, each on its own line. */
export function linesSection(
  id: string,
  source: Source,
  lines: readonly string[],
  sep?: string,
): Section {
  return section(id, source, lines.filter((l) => l !== "").join("\n"), sep);
}

/**
 * A role's prompt from its sections; an empty section is left out. `turn`: a later turn's place
 * in its call (none: the call's first message). For the roles' modules only.
 */
export function prompt(
  role: string,
  program: string,
  parts: { system?: readonly Section[]; message: readonly Section[]; turn?: number },
): Prompt {
  const kept = (ss: readonly Section[] | undefined) => (ss ?? []).filter((s) => s.text !== "");
  return {
    role,
    program,
    turn: parts.turn ?? 0,
    system: kept(parts.system),
    message: kept(parts.message),
  } as Prompt;
}

/** Sections as the text sent: in order, each after its separator. */
export function sectionsText(ss: readonly Section[]): string {
  return ss.map((s, i) => (i ? (s.sep ?? "\n") : "") + s.text).join("");
}

/** The system text sent ("" where the program takes one message). */
export const systemText = (p: Prompt): string => sectionsText(p.system);

/** The message sent: the first one, or a later turn. */
export const messageText = (p: Prompt): string => sectionsText(p.message);

/** The message as Pi takes a user's turn, for a send that steers it into a running call. */
export const userMessage = (p: Prompt) => ({
  role: "user" as const,
  content: messageText(p),
  timestamp: Date.now(),
});

/**
 * A prompt as it is kept (core/prompts.ts): its sections whole, each with the part it went in,
 * and where it was sent.
 */
export function promptRecord(
  p: Prompt,
  at: { lane?: string | undefined; trial?: string | undefined; call?: string | undefined },
): PromptRecord {
  const part =
    (name: PromptSection["part"]) =>
    (s: Section): PromptSection => ({
      id: s.id,
      source: s.source,
      part: name,
      text: s.text,
      ...(s.sep !== undefined ? { sep: s.sep } : {}),
    });
  return {
    role: p.role,
    program: p.program,
    turn: p.turn,
    lane: at.lane ?? null,
    trial: at.trial ?? null,
    call: at.call ?? null,
    sections: [...p.system.map(part("system")), ...p.message.map(part("message"))],
  };
}
