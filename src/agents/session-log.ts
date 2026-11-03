import { appendFileSync } from "node:fs";
import type { Agent } from "@earendil-works/pi-agent-core";

/**
 * A Pi agent's own session log (goal 125, T12): each message of its conversation, as it ends, one
 * JSON line in a file of the trial's own folder, `{at, message}`. Pi keeps its conversation in
 * memory; this is the log the harness keeps of a Pi trial when it ends (harness/sessions.ts),
 * as it keeps each other program's own. A line that can't be written is left out: the trial goes
 * on, and its live lines and events stay.
 */

/** The file of a Pi trial's session log, in its folder. */
export const PI_SESSION_LOG = "pi-session.jsonl";

/** Writes each message of `agent`'s conversation to `path` as it ends. */
export function writeSessionLog(agent: Agent, path: string): void {
  agent.subscribe((event) => {
    if (event.type !== "message_end") return;
    try {
      appendFileSync(
        path,
        `${JSON.stringify({ at: new Date().toISOString(), message: event.message })}\n`,
        { mode: 0o600 },
      );
    } catch {
      // A full disk or a folder gone: the log misses this message, and nothing else changes.
    }
  });
}
