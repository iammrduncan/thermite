import { z } from "zod";
import { IN_TURN } from "../../agents.ts";
import type { Route } from "../route.ts";

/**
 * How a running trial's agent program takes the owner's messages inside its turn (goal 169; the
 * harness answers in src/harness/api/trials.ts): Thermite's hook program in Claude Code and Codex
 * (src/agents/programs/hooks/main.ts) and Thermite's plugin in OpenCode
 * (src/agents/programs/opencode/plugin.ts) ask with the trial's own token, which decides the
 * trial. Both import nothing of Thermite's, so each keeps its own copy of these paths, and a test
 * holds the copies to these.
 *
 * Two steps, so a message counts as read only once the program has it: the offer gives its text
 * and reads nothing; the receipt, after the hook printed the text or OpenCode took it into the
 * session, reads it.
 */

/**
 * The next owner's message waiting for the trial, as its role puts it to the agent, offered to
 * the hook or plugin that asks. `at`: where the program is. `offer` null: none waits, or the
 * trial takes none inside its turn now.
 */
export const TURN_OFFER = {
  method: "POST",
  path: "/v1/trial/turn/offer",
  body: z.strictObject({ at: z.enum(IN_TURN) }),
  answer: z.looseObject({ offer: z.string().nullable(), text: z.string() }),
  maxBytes: 1024,
} as const satisfies Route;

/**
 * The hook or plugin gave the offer's text to its program: the message is read now, and kept as
 * a later turn of the trial. `messages`: the ids read (none for an offer unknown or too old).
 */
export const TURN_TAKEN = {
  method: "POST",
  path: "/v1/trial/turn/taken",
  body: z.strictObject({ offer: z.string().min(1).max(64) }),
  answer: z.looseObject({ messages: z.array(z.number()) }),
  maxBytes: 1024,
} as const satisfies Route;
