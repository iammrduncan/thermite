import { z } from "zod";
import { TERMINAL_TEXT_MAX } from "../../terminal-input.ts";
import type { Route } from "../route.ts";

/**
 * The Pi view's console (goal 169; the harness answers in src/harness/api/trials.ts): the owner's
 * input to a worker in Pi (terminal_input), which the harness turns into one call of the Pi view
 * (src/agents/pi-view/commands.ts), and which the worker's own code takes over its trial's
 * routes, with its trial's token, and makes in its trial's loop. Nothing is typed into a terminal:
 * the screen is only drawn. One input at a time: the worker asks for the next, makes its call,
 * and says what became of it.
 */

/** The longest the worker's ask for the next input waits for one, in milliseconds. */
export const PI_VIEW_WAIT_MAX = 25_000;

const Text = z.string().min(1).max(TERMINAL_TEXT_MAX);

/** One call of the Pi view in the trial's loop. */
export const PiViewCall = z.discriminatedUnion("kind", [
  /** The owner's words, put to the agent before its next model call. */
  z.strictObject({ kind: z.literal("steer"), text: Text }),
  /** The owner's words, put to the agent when it would stop: a reply that calls no tool. */
  z.strictObject({ kind: z.literal("follow_up"), text: Text }),
  /** Stops the agent's open reply; the trial goes on. */
  z.strictObject({ kind: z.literal("interrupt") }),
  /** Compacts the conversation before the agent's next model call. */
  z.strictObject({ kind: z.literal("compact") }),
  /** Shows the trial's MCP tools and the servers that failed. */
  z.strictObject({ kind: z.literal("mcp") }),
  /** Lists the MCP servers' tools again, from the servers, and gives the agent the new list. */
  z.strictObject({
    kind: z.literal("mcp_reconnect"),
    server: z.string().min(1).max(64).optional(),
  }),
  /** Shows the trial's counts: turns, tokens, compactions, time left, its model. */
  z.strictObject({ kind: z.literal("status") }),
]);
export type PiViewCall = z.infer<typeof PiViewCall>;

/** An input as the worker takes it: its id, which its outcome names, and its call. */
export const PiViewInput = z.strictObject({
  id: z.string().min(1).max(32),
  call: PiViewCall,
});
export type PiViewInput = z.infer<typeof PiViewInput>;

/**
 * The next input for the trial's Pi view: at once when one waits, else when one comes, or null
 * after `wait_ms`. Each input is given once.
 */
export const PI_VIEW_NEXT = {
  method: "POST",
  path: "/v1/trial/console/next",
  body: z.strictObject({ wait_ms: z.number().int().min(0).max(PI_VIEW_WAIT_MAX) }),
  answer: z.looseObject({ input: PiViewInput.nullable() }),
  maxBytes: 1024,
} as const satisfies Route;

/** What became of an input: its call was made (`typed`, as every terminal input says), or why not. */
export const PI_VIEW_DONE = {
  method: "POST",
  path: "/v1/trial/console/done",
  body: z.strictObject({
    id: z.string().min(1).max(32),
    outcome: z.enum(["typed", "refused"]),
    why: z.string().max(2000).optional(),
  }),
  answer: z.looseObject({ ok: z.literal(true) }),
  maxBytes: 4096,
} as const satisfies Route;

/**
 * The trial is ending: the harness keeps the view's last screen now, while the worker still draws
 * it, and its console takes no more input.
 */
export const PI_VIEW_END = {
  method: "POST",
  path: "/v1/trial/console/end",
  body: z.strictObject({}),
  answer: z.looseObject({ ok: z.literal(true) }),
  maxBytes: 64,
} as const satisfies Route;
