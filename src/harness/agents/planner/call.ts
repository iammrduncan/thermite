import type { ModelConfig } from "../../../agents/model/index.ts";
import { messageText, type Prompt } from "../../../agents/prompt.ts";
import { windowFit } from "../../../agents/roles/index.ts";
import { LenientNotes, type NoteInput } from "../../../core/journal.ts";
import type { OwnerAddition } from "../../../core/role-additions.ts";
import type { CallUsage } from "../../../core/usage.ts";
import { causeOf, causeWords, PlannerCallError, type PlanTry } from "./causes.ts";
import type { PlannerPast } from "./context.ts";
import { callPlanner, type PlannerCompaction, type PlannerMcp } from "./pi.ts";
import type { PlannerCallSpec } from "./submit.ts";

/**
 * A planner call, in Pi (pi.ts, or its own process: view.ts) or through another harness
 * (askPlanner): its tries, each answer checked, and why each try gave no plan.
 */

/**
 * A planner call through another harness (OpenCode, Claude Code, Codex): the prompt in, the model's
 * answer out. `read`: a folder the planner may read and search (its past research), read only.
 */
export type Ask = ((
  prompt: string,
  signal?: AbortSignal,
  o?: {
    read?: string | undefined;
    /** The MCP servers it may call (goal 068), by name, at the harness's gateway. */
    mcp?: string[] | undefined;
    /** Thermite's own server too, with the knowledge base's tools (goal 175). */
    kb?: boolean | undefined;
  },
) => Promise<string>) & {
  /** The program it asks through (its prompt names it); none: a program like OpenCode. */
  program?: string | undefined;
};

/**
 * The planner in Pi in a process of its own, in its Pi view (goal 169; view.ts): its prompt and its
 * call's spec in, submit_plan's arguments out, or a PlannerCallError that says why it gave none.
 */
export type PlannerView = (
  sent: Prompt,
  spec: PlannerCallSpec,
  signal?: AbortSignal,
) => Promise<unknown>;

/** What the tries of a planner call gave: the checked plan, or why each try gave none. */
export interface PlannerTries<T> {
  plan?: T | undefined;
  tries: number;
  causes: PlanTry[];
  /** What was wrong with the model's raw output, per try. */
  rawViolations: string[];
  /** The field notes every answer carried, read leniently, also when its plan was refused. */
  journal: NoteInput[];
}

/**
 * A planner call, tried at most twice (goal 079): in Pi with the model's own tool, or through
 * another harness with `ask`. Each answer is checked with `check`; a refused answer goes back
 * once with its errors in words. Why each try gave no plan is kept (PlanTry), and the field notes
 * of every answer, also of a refused one. The plan of the hill climb and the goal campaign and
 * the research plan both come through here.
 */
export async function plannerTries<T>(o: {
  context: string;
  /** The owner's addition to the role for the campaign (goal 166). */
  addition?: OwnerAddition | undefined;
  model: ModelConfig;
  spec: PlannerCallSpec;
  check: (raw: unknown) => { errors: string[]; plan?: T | undefined };
  signal?: AbortSignal | undefined;
  ask?: Ask | undefined;
  /** In Pi, in its own process and its Pi view, on a rig whose agents run in their terminal. */
  view?: PlannerView | undefined;
  past?: PlannerPast | undefined;
  mcp?: PlannerMcp | undefined;
  compaction?: PlannerCompaction | undefined;
  usage?: ((u: CallUsage) => void) | undefined;
  /** Keeps each try's prompt, and each later turn in it, as it is sent (goal 166). */
  sent?: ((p: Prompt) => void) | undefined;
}): Promise<PlannerTries<T>> {
  const rawViolations: string[] = [];
  const causes: PlanTry[] = [];
  const journal: NoteInput[] = [];
  const keepNotes = (raw: unknown) => {
    const notes = LenientNotes.parse((raw as { journal?: unknown } | undefined)?.journal);
    for (const n of notes)
      if (!journal.some((j) => j.kind === n.kind && j.text === n.text)) journal.push(n);
  };
  let refused: string[] | undefined;
  for (let tries = 1; tries <= 2; tries++) {
    if (o.signal?.aborted) break;
    // Its prompt, from its role's definition: in Pi, or through the program `ask` reaches.
    const sent = o.spec.render({
      program: o.ask ? (o.ask.program ?? o.model.harness ?? "opencode") : "pi",
      context: o.context,
      refused,
      read: o.ask ? o.past?.dir : undefined,
      mcpServers: o.ask ? (o.mcp?.servers ?? []) : o.mcp?.tools.length ? o.mcp.servers : [],
      kbWrites: o.mcp?.kb?.writes,
      // Cut to the model's window, when the route says it (decision 8).
      fit: windowFit(o.model.contextWindow, o.model.compactAt),
      addition: o.addition,
    });
    o.sent?.(sent);
    let raw: unknown;
    try {
      raw = o.ask
        ? await askPlanner(
            o.ask,
            sent,
            o.signal,
            o.past?.dir,
            o.mcp?.servers,
            o.mcp?.kb !== undefined,
          )
        : o.view
          ? await o.view(sent, o.spec, o.signal)
          : await callPlanner(o.model, sent, {
              signal: o.signal,
              mcp: o.mcp,
              compaction: o.compaction,
              usage: o.usage,
              spec: o.spec,
              kept: o.sent,
            });
    } catch (err) {
      const why = err instanceof PlannerCallError ? err : causeOf(err);
      causes.push({ try: tries, cause: why.planCause, detail: why.message.slice(0, 600) });
      rawViolations.push(`try ${tries}: ${causeWords[why.planCause]}: ${why.message}`);
      continue;
    }
    keepNotes(raw);
    const { errors, plan: p } = o.check(raw);
    if (!errors.length && p !== undefined)
      return { plan: p, tries, causes, rawViolations, journal };
    causes.push({ try: tries, cause: "invalid", detail: errors.join("; ").slice(0, 600) });
    rawViolations.push(...errors.map((e) => `try ${tries}: refused: ${e}`));
    refused = errors;
  }
  return { tries: 2, causes, rawViolations, journal };
}

/**
 * The planner through another harness: its prompt, with the plan as JSON text. With past
 * research, it may read and search the run's knowledge/ folder first, read only.
 */
async function askPlanner(
  ask: Ask,
  sent: Prompt,
  signal?: AbortSignal,
  read?: string,
  mcp?: string[],
  kb?: boolean,
): Promise<unknown> {
  const text = await ask(
    messageText(sent),
    signal,
    read || mcp?.length || kb
      ? { ...(read ? { read } : {}), ...(mcp?.length ? { mcp } : {}), ...(kb ? { kb } : {}) }
      : undefined,
  );
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(body);
  } catch {
    throw new PlannerCallError(
      "text_only",
      `the planner's answer was not a JSON plan: ${text.slice(0, 200)}`,
    );
  }
}
