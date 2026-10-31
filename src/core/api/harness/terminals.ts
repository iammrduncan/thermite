import { z } from "zod";
import { ADVISOR_USERS } from "../../advisor-runs.ts";
import { RunId } from "../../ids.ts";
import {
  TERMINAL_KEYS,
  TERMINAL_KEYS_MAX,
  TERMINAL_OUTCOMES,
  TERMINAL_TEXT_MAX,
  TERMINAL_WAITS,
  TerminalId,
} from "../../terminal-input.ts";
import type { Route } from "../route.ts";

/**
 * The advisors' terminals (goal 169), between the harness and its rig's supervisor, which runs each
 * advisor's call in its program's own terminal (src/harness/api/terminals.ts answers): the
 * supervisor says which calls run in theirs now (ADVISOR_TERMINALS), so the rig's report lists them
 * for Live and the harness takes the owner's input to them; the harness checks and records each
 * input (terminal_input) as it does a trial's, then hands it on (ADVISOR_INPUTS), a call the
 * supervisor holds open as it holds the knowledge base's asks (the harness never calls out); the
 * supervisor types it and says what became of it (ADVISOR_INPUT_OUTCOMES), which the harness
 * records. Every route takes the supervisor's token.
 */

/** An advisor's call in its terminal: its id, the run it advises, and the advisor's name. */
export const AdvisorTerminal = z.strictObject({
  id: TerminalId,
  run: RunId,
  /** The advisor, as the supervisor names it: auditor, teacher-1, reviewer-2. */
  role: z.string().min(1).max(40),
});
export type AdvisorTerminal = z.infer<typeof AdvisorTerminal>;

/**
 * The advisors' calls that run in their terminals now, all of them: one that is left out has
 * ended. At most one for each advisor user, since each runs as one.
 */
export const ADVISOR_TERMINALS = {
  method: "PUT",
  path: "/v1/advisor-terminals",
  body: z.strictObject({ calls: z.array(AdvisorTerminal).max(ADVISOR_USERS.count) }),
  answer: z.unknown(),
  maxBytes: 16 * 1024,
} as const satisfies Route;

/** An owner's input the harness checked and recorded, for an advisor's call: its id, and what to type. */
export const AdvisorInput = z.strictObject({
  id: z.string().min(1).max(64),
  call: TerminalId,
  text: z.string().max(TERMINAL_TEXT_MAX).optional(),
  keys: z.array(z.enum(TERMINAL_KEYS)).min(1).max(TERMINAL_KEYS_MAX).optional(),
  wait: z.enum(TERMINAL_WAITS),
});
export type AdvisorInput = z.infer<typeof AdvisorInput>;

/**
 * The owner's inputs that wait for the advisors' terminals: the supervisor holds this call open up
 * to `wait` seconds (at most ADVISOR_INPUTS_WAIT_MAX_S) until one comes. Each is handed over once.
 */
export const ADVISOR_INPUTS = {
  method: "GET",
  path: "/v1/advisor-terminals/inputs",
  what: "advisors' terminal inputs",
  answer: z.object({ inputs: z.array(AdvisorInput) }),
} as const satisfies Route;
export const ADVISOR_INPUTS_WAIT_MAX_S = 30;

/**
 * What became of an input the supervisor took: typed, queued for the usage window's reset (until
 * when, when the program said) or refused (why, in words); and later, for one that waited, typed
 * after the reset or dropped.
 */
export const AdvisorOutcome = z.strictObject({
  id: z.string().min(1).max(64),
  outcome: z.enum(TERMINAL_OUTCOMES),
  why: z.string().max(1000).optional(),
  until: z.string().max(64).optional(),
});
export type AdvisorOutcome = z.infer<typeof AdvisorOutcome>;

export const ADVISOR_INPUT_OUTCOMES = {
  method: "POST",
  path: "/v1/advisor-terminals/outcomes",
  body: z.strictObject({ outcomes: z.array(AdvisorOutcome).max(100) }),
  answer: z.object({ taken: z.number() }),
  maxBytes: 256 * 1024,
} as const satisfies Route;
