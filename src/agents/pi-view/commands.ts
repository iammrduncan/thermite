import { Refusal } from "../../common/errors.ts";
import type { PiViewCall } from "../../core/api/harness/console.ts";
import type { TerminalInput } from "../../core/terminal-input.ts";

/**
 * What one of the owner's inputs does in a worker's Pi view (goal 169; the owner's decisions of
 * 2026-10-27 and 2026-10-30): words steer the agent before its next model call, or, with
 * follow_up, wait until it would stop; Esc interrupts its reply; each command is one call in the
 * trial's loop. Anything else is refused here, in words, before it reaches the worker.
 */

/** The Pi view's commands, as the console's help and the refusals name them. */
export const PI_VIEW_COMMANDS = "/status, /compact, /mcp, /mcp reconnect [server] and /skill:NAME";

/** The longest name of an MCP server, as a kit gives one. */
const SERVER_MAX = 64;

/** The call an input makes, or a Refusal that says why it makes none. */
export function piViewCall(i: Pick<TerminalInput, "text" | "keys" | "follow_up">): PiViewCall {
  if (i.keys !== undefined) {
    if (i.keys.length === 1 && i.keys[0] === "esc") return { kind: "interrupt" };
    throw new Refusal(
      "the Pi view takes one key, Esc, which interrupts the agent's reply: it has no menu for other keys",
    );
  }
  const text = i.text ?? "";
  const line = text.trim();
  if (!line.startsWith("/"))
    return i.follow_up ? { kind: "follow_up", text } : { kind: "steer", text };
  const [name = "", ...rest] = line.split(/\s+/);
  if (i.follow_up)
    throw new Refusal(`follow_up goes with words for the agent, not with a command (${name})`);
  const alone = (call: PiViewCall): PiViewCall => {
    if (rest.length) throw new Refusal(`${name} takes nothing after it`);
    return call;
  };
  if (name === "/status") return alone({ kind: "status" });
  if (name === "/compact") return alone({ kind: "compact" });
  if (name === "/mcp") {
    if (!rest.length) return { kind: "mcp" };
    const [verb, server, ...more] = rest;
    if (verb !== "reconnect" || more.length)
      throw new Refusal("/mcp takes nothing after it, or reconnect and at most one server's name");
    if (server !== undefined && server.length > SERVER_MAX)
      throw new Refusal(`an MCP server's name has at most ${SERVER_MAX} characters`);
    return server === undefined ? { kind: "mcp_reconnect" } : { kind: "mcp_reconnect", server };
  }
  // Kits carry no agent skills yet (goal 169 decided that a kit may carry them, reviewed with the
  // kit; that is not built), so a run's kit has none to load.
  if (name.startsWith("/skill:"))
    throw new Refusal(`this run's kit carries no skills, so ${name} has nothing to load`);
  throw new Refusal(
    `${name} is not a command of the Pi view: it takes ${PI_VIEW_COMMANDS}, and words that do not start with / steer the agent`,
  );
}
