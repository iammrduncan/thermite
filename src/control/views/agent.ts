import { type GoalChecks, parseGoalChecks } from "../../core/goal/index.ts";
import { type HeldOutKind, heldOutKinds, heldOutWords } from "../../core/held-out.ts";
import type { AttemptView, HeldOutView, RunView, StoredEvent } from "./index.ts";

/**
 * What the agent token reads over MCP of a run's held-out checks (goal 082). The agents see only
 * that a held-out check failed and its kinds, in the words the lanes get: never a held-out cell's
 * name, its values, its threshold or its time limit. The owner, the operator and the reader keep
 * the full view, which is the owner's.
 */

/** A held-out check as the agent token sees it: passed or not, and how it failed. */
export interface AgentHeldOut {
  at: string;
  pass: boolean;
  /** The kinds of failure among its cells, each once, from the closed list. */
  kinds: HeldOutKind[];
  /** The lanes' words for them, such as "a held-out check timed out"; null when it passed. */
  words: string | null;
}

export function agentHeldOut(h: HeldOutView): AgentHeldOut {
  const kinds = heldOutKinds(h.cells);
  return { at: h.at, pass: h.pass, kinds, words: h.pass ? null : heldOutWords(kinds) };
}

/** Each goal's check without its held-out cells, which the agents never see named. */
export function agentGoalChecks(g: GoalChecks | null): GoalChecks | null {
  if (!g) return null;
  return {
    ...g,
    goals: g.goals.map(({ cells_total: _total, ...goal }) => ({
      ...goal,
      cells: goal.cells ? goal.cells.filter((c) => !c.held_out) : null,
    })),
  };
}

/**
 * An `agent_prompt` event without its sections' text: each section's source, part, size and hash
 * stay. The agent's and the reader's tokens read it so; the owner and the operator read the text
 * (agent_prompts, REST's prompts). Every other event is as given.
 */
export function withoutPromptText(e: StoredEvent): StoredEvent {
  if (e.kind !== "agent_prompt" || !Array.isArray(e.body.sections)) return e;
  const sections = e.body.sections.map((s: unknown) => {
    const { text: _text, cut: _cut, ...rest } = (s ?? {}) as Record<string, unknown>;
    return rest;
  });
  return { ...e, body: { ...e.body, sections } };
}

/** A run as the reader's token sees it: its prompts' events without their text. */
export function readerRun(r: RunView): RunView {
  return { ...r, timeline: r.timeline.map(withoutPromptText) };
}

/**
 * An event as the agent token sees it: a `held_out_checked` event with its kinds alone, a
 * `goal_checks` event without its held-out cells, an `agent_prompt` event without its text. Every
 * other event is as the rig reported it.
 */
export function agentEvent(e: StoredEvent): StoredEvent {
  // An event control can't read has an empty body already: nothing to say of it.
  if (e.unreadable !== undefined) return e;
  if (e.kind === "agent_prompt") return withoutPromptText(e);
  if (e.kind === "held_out_checked") {
    const b = e.body;
    const pass = b.pass === true;
    const kinds = heldOutKinds(
      (Array.isArray(b.cells) ? b.cells : []).map((x) => {
        const c = (x ?? {}) as Record<string, unknown>;
        return { ok: c.ok === true, kind: typeof c.kind === "string" ? c.kind : null };
      }),
    );
    return {
      ...e,
      body: {
        ...(typeof b.run === "string" ? { run: b.run } : {}),
        // A goal run's champion's check (goal 086): which champion, never which case.
        ...(typeof b.champion_seq === "number" ? { champion_seq: b.champion_seq } : {}),
        pass,
        kinds,
        words: pass ? null : heldOutWords(kinds),
      },
    };
  }
  if (e.kind === "goal_checks")
    return { ...e, body: { ...agentGoalChecks(parseGoalChecks(e.body)) } };
  return e;
}

/** A run as the agent token sees it: held-out checks as their kinds, no held-out cell named. */
export function agentRun(r: RunView): Omit<RunView, "attempts" | "champion_held_out"> & {
  attempts: (Omit<AttemptView, "held_out"> & {
    held_out: AgentHeldOut | null;
  })[];
  champion_held_out: (AgentHeldOut & { champion_seq: number }) | null;
} {
  return {
    ...r,
    attempts: r.attempts.map((a) => ({
      ...a,
      held_out: a.held_out ? agentHeldOut(a.held_out) : null,
    })),
    // The champion's held-out check (goal 086), as an attempt's: its kinds alone.
    champion_held_out: r.champion_held_out
      ? { ...agentHeldOut(r.champion_held_out), champion_seq: r.champion_held_out.champion_seq }
      : null,
    goal_checks: agentGoalChecks(r.goal_checks),
    timeline: r.timeline.map(agentEvent),
  };
}
