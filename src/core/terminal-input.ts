import { z } from "zod";
import { RunId } from "./ids.ts";

/**
 * The owner's console into an agent's terminal (goal 169; the owner's decision of 2026-10-26):
 * `terminal_input`, a signed command only the owner issues, never an operator, an agent or a
 * reader. It types text into one agent's program in its terminal (a message, a slash command or a
 * skill, then Enter), or sends it keys from a fixed list: a running trial's, a planner's call's
 * (plannerCallId) or an advisor's call's (advisorCallId), which the supervisor runs and the
 * harness hands the input to (core/api/harness/terminals.ts). A worker in Pi takes the same input
 * in its Pi view, where each is one call in its trial's loop (core/api/harness/console.ts). The
 * harness
 * records each input word for word with its outcome. While the program waits for its usage
 * window, an input waits for the reset unless the owner says to send it now (the owner's decision
 * of 2026-10-27).
 */

/**
 * The keys that may be sent by name, the owner's list for a program's menus (2026-10-26): Enter,
 * Esc, Tab, the arrows, the digits, Page Up and Page Down. Ctrl+C is not one: it exits Codex on an
 * empty composer and Claude Code on a second press. An interrupt is each program's own steps.
 */
export const TERMINAL_KEYS = [
  "enter",
  "esc",
  "tab",
  "up",
  "down",
  "left",
  "right",
  "page-up",
  "page-down",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
] as const;
export type TerminalKey = (typeof TERMINAL_KEYS)[number];

/** The most characters of text in one input, as in an owner's message. */
export const TERMINAL_TEXT_MAX = 4000;
/** The most named keys in one input. */
export const TERMINAL_KEYS_MAX = 16;
/** The most inputs one trial takes in a minute: more are refused, in words. */
export const TERMINAL_INPUTS_PER_MINUTE = 30;
/** The most inputs that wait for one trial's usage window to reset: more are refused, in words. */
export const TERMINAL_QUEUE_MAX = 20;

/**
 * The id of an agent's terminal, as terminal_input and the screens name it: a trial's
 * (`t-` and 16 hex digits), or a call's of a role outside a trial, plannerCallId's or
 * advisorCallId's.
 */
export const TERMINAL_ID = /^[A-Za-z0-9_-]{1,100}$/;
export const TerminalId = z
  .string()
  .regex(
    TERMINAL_ID,
    "a trial's id, a planner's call's (planner-RUN-N) or an advisor's call's (advisor-ADVISOR-RUN-N)",
  );

/**
 * A planner's call in its own terminal (goal 169), as the console and the screens name it: the
 * run and the round it plans. Both tries of a round have the same, as their kept prompts name the
 * same round.
 */
export const plannerCallId = (run: string, round: number): string => `planner-${run}-${round}`;

/** The most characters of an advisor's name in its call's id: the run's name must fit after it. */
const ADVISOR_IN_ID_MAX = 20;

/**
 * An advisor's call in its own terminal (goal 169), as the console and the screens name it: the
 * advisor (auditor, teacher-1, reviewer-2; another character than TERMINAL_ID's becomes `-`, and a
 * long name is cut), the run it advises, and the supervisor's count of its calls.
 */
export const advisorCallId = (advisor: string, run: string, n: number): string =>
  `advisor-${advisor.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, ADVISOR_IN_ID_MAX)}-${run}-${n}`;

/**
 * Where a terminal's lines go on control's Live, by its id: a planner's call's to the planner's
 * page, an advisor's call's to the advisors' (the supervisor's lines), a trial's to its own.
 */
export const terminalSource = (id: string): string =>
  id.startsWith("planner-") ? "planner" : id.startsWith("advisor-") ? "supervisor" : `trial:${id}`;

/** What an input does while the program waits for its usage window: wait for the reset, or go now. */
export const TERMINAL_WAITS = ["queue", "now"] as const;

/** Control characters, which text may not hold (but line breaks and tabs): a key goes by name. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/**
 * The inputs that must be confirmed first: a line that starts with `!` runs a shell command in
 * Claude Code and Codex; `/login`, `/logout`, `/config` and `/permissions` change the program's
 * sign-in or settings. The console's script shows its confirmation with the same rule.
 */
export const CONFIRM_FIRST = /^\s*(?:!|\/(login|logout|config|permissions)(?![\w-]))/;

/** Why an input must be confirmed first, in words, or undefined. */
export function confirmFirst(text: string): string | undefined {
  const m = CONFIRM_FIRST.exec(text);
  if (!m) return undefined;
  return m[1]
    ? `it runs /${m[1]}, which changes the program's sign-in or settings`
    : "it starts with !, which runs a shell command in the agent's terminal";
}

const Text = z
  .string()
  // A browser sends a form's line breaks as CR LF; the record keeps them as the program gets them.
  .transform((s) => s.replace(/\r\n?/g, "\n"))
  .pipe(
    z
      .string()
      .max(TERMINAL_TEXT_MAX)
      .refine((s) => s.trim() !== "", "type some text, or send keys by their names")
      .refine(
        (s) => !CONTROL.test(s),
        "text may hold no control characters but line breaks and tabs: send a key by its name",
      ),
  );

export const TerminalInput = z
  .strictObject({
    run: RunId,
    /**
     * The terminal it goes into: a running trial's, as stop_trial names one, or a planner's or an
     * advisor's call's (plannerCallId, advisorCallId), as Live shows it.
     */
    trial: TerminalId,
    /** Typed into the program, then Enter. */
    text: Text.optional(),
    /** Sent to the program one after the other. */
    keys: z.array(z.enum(TERMINAL_KEYS)).min(1).max(TERMINAL_KEYS_MAX).optional(),
    /** While the program waits for its usage window: wait for the reset (the default), or go now. */
    wait: z.enum(TERMINAL_WAITS).default("queue"),
    /** The owner confirmed an input that confirmFirst names. */
    confirm: z.literal(true).optional(),
    /**
     * For a worker in Pi (its Pi view) only: the text waits until the agent would stop, at the
     * end of a reply that calls no tool, and goes in then, instead of steering the agent before
     * its next model call.
     */
    follow_up: z.literal(true).optional(),
  })
  .refine((p) => (p.text === undefined) !== (p.keys === undefined), {
    message: "give text or keys, one of the two",
    path: ["text"],
  })
  .refine((p) => p.follow_up === undefined || p.text !== undefined, {
    message: "follow_up goes with text, not keys",
    path: ["follow_up"],
  })
  .refine((p) => p.confirm === true || p.text === undefined || !confirmFirst(p.text), {
    message: "confirm this input first (confirm: true)",
    path: ["confirm"],
  });
export type TerminalInput = z.infer<typeof TerminalInput>;

/**
 * Who may type into an agent's terminal: the owner alone, from the dashboard, REST, the command
 * line or the owner's MCP token; never an operator, which issues commands as `owner:operator`.
 */
export const typesIntoTerminals = (issuedBy: string): boolean =>
  issuedBy === "owner" || (issuedBy.startsWith("owner:") && issuedBy !== "owner:operator");

/**
 * What became of an input, as its record says: typed into the program; queued for the reset of the
 * program's usage window, then typed after it, or dropped when the trial ended first; or refused.
 */
export const TERMINAL_OUTCOMES = [
  "typed",
  "queued",
  "typed_after_reset",
  "dropped",
  "refused",
] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

/** An input in words, for a record and a page: its text, or its keys by name. */
export function inputWords(i: { text?: string | undefined; keys?: readonly string[] | undefined }) {
  return i.text ?? (i.keys ?? []).map((k) => `[${k}]`).join(" ");
}
