import { type Prompt, promptRecord } from "../agents/prompt.ts";
import { log } from "../common/log.ts";
import type { Ledger } from "./ledger/index.ts";

/**
 * Keeps a prompt the harness sent one of a run's agents (goal 166): whole, compressed, in the
 * ledger, with its `agent_prompt` event (ledger/prompts.ts). A prompt that cannot be kept is
 * logged, and the call it starts goes on: the record is provenance, never a gate.
 */
export function keepPrompt(
  ledger: Ledger,
  run: string,
  p: Prompt,
  at: { lane?: string | undefined; trial?: string | undefined; call?: string | undefined },
): void {
  try {
    ledger.prompts.record("harness", run, promptRecord(p, at));
  } catch (err) {
    log("prompts", "a prompt sent was not kept", {
      run,
      role: p.role,
      ...at,
      error: String(err),
    });
  }
}

/** Which role's next prompt to preview, and for which lane and experiment (a worker's). */
export interface PreviewAsk {
  role: "worker" | "planner";
  lane?: string | undefined;
  /** The experiment a worker's trial would take; none: the first one up next. */
  experiment?: string | undefined;
}
