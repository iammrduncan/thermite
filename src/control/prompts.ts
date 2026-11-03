import { ROLES, roleOf } from "../agents/roles/index.ts";
import { type AgentPromptBody, sha256 } from "../core/prompts.ts";
import type { ControlStore } from "./store/index.ts";
import { type RunOnRig, runEvents } from "./views/index.ts";

/**
 * The agents' roles and the prompts a run's agents were sent, as control shows them (goal 166):
 * REST, MCP, the command line and the dashboard read them here. A role's definition is the one in
 * control's own build (src/agents/roles/); a run's prompts are its rig's `agent_prompt` events, read
 * from the message bus's events stream, whose fixed texts of a definition control fills in from its
 * own when their sha256 matches.
 * The whole text of each prompt stays on the rig, and in the run's export.
 */

/** A role's definition, as control shows it. */
export interface RoleInfo {
  id: string;
  name: string;
  what: string;
  runs_in: string;
  model: string;
  programs: readonly string[];
  messages: boolean;
  /** The one function that puts its prompt together for a run. */
  render: string;
  texts: { id: string; what: string; chars: number; text?: string | undefined }[];
}

/** Every role, without its texts (`texts: true` gives them whole). */
export function roles(o: { texts?: boolean } = {}): RoleInfo[] {
  return ROLES.map((r) => roleInfo(r.id, o.texts === true) as RoleInfo);
}

/** One role, with its texts whole; undefined for a name no role has. */
export function role(id: string): RoleInfo | undefined {
  return roleOf(id) ? roleInfo(id, true) : undefined;
}

function roleInfo(id: string, texts: boolean): RoleInfo | undefined {
  const r = roleOf(id);
  if (!r) return undefined;
  return {
    id: r.id,
    name: r.name,
    what: r.what,
    runs_in: r.runsIn,
    model: r.model,
    programs: r.programs,
    messages: r.messages,
    render: r.render.name,
    texts: r.texts.map((t) => ({
      id: t.id,
      what: t.what,
      chars: t.text.length,
      ...(texts ? { text: t.text } : {}),
    })),
  };
}

/** A prompt a run's agent was sent, as a list shows it. */
export interface PromptItem {
  id: number;
  at: string;
  role: string;
  program: string;
  lane: string | null;
  trial: string | null;
  call: string | null;
  version: string;
  chars: number;
  /** The sections' ids and sources, in order. */
  sections: { id: string; source: string; part: string; chars: number }[];
}

/** One prompt, with each section's text where control has it. */
export interface PromptDetail extends PromptItem {
  rig: string;
  sections: {
    id: string;
    source: string;
    part: string;
    chars: number;
    /** Its text: as the rig sent it, or a definition's fixed text; null when control has neither. */
    text: string | null;
    /** The rig sent part of it: the whole is on the rig and in the run's export. */
    cut: boolean;
    /** The text is control's copy of the role's definition. */
    from_definition: boolean;
  }[];
}

/** The kind of a prompt's event. */
const PROMPT = "agent_prompt";

/** The fixed texts of the definitions in control's build, by sha256. */
const FIXED = new Map(ROLES.flatMap((r) => r.texts.map((t) => [sha256(t.text), t.text] as const)));

const bodyOf = (b: unknown) => b as AgentPromptBody;

/** The `agent_prompt` events of a run on its rig, oldest first, in every ledger. */
async function promptEvents(store: ControlStore, found: RunOnRig) {
  const events = await runEvents(store, { rig: found.rig.id, run: found.run.id, kind: PROMPT });
  return events.map((e) => e.read.event);
}

/** A run's prompts, oldest first, without their text. */
export async function runPrompts(store: ControlStore, found: RunOnRig): Promise<PromptItem[]> {
  return promptItems(await promptEvents(store, found));
}

/** Prompt events as a list shows them. */
function promptItems(events: { at: string; body: unknown }[]): PromptItem[] {
  return events.map((e) => {
    const b = bodyOf(e.body);
    return {
      id: b.id,
      at: e.at,
      role: b.role,
      program: b.program,
      lane: b.lane,
      trial: b.trial,
      call: b.call,
      version: b.version,
      chars: b.chars,
      sections: b.sections.map((s) => ({
        id: s.id,
        source: s.source,
        part: s.part,
        chars: s.chars,
      })),
    };
  });
}

/** One of a run's prompts, by its number on the rig; undefined when the run has none. */
export async function runPrompt(
  store: ControlStore,
  found: RunOnRig,
  id: number,
): Promise<PromptDetail | undefined> {
  const events = await promptEvents(store, found);
  const e = events.findLast((x) => bodyOf(x.body).id === id);
  if (!e) return undefined;
  const b = bodyOf(e.body);
  const item = promptItems(events).findLast((p) => p.id === id) as PromptItem;
  return {
    ...item,
    rig: found.rig.id,
    sections: b.sections.map((s) => {
      const fixed = s.text === undefined ? FIXED.get(s.sha256) : undefined;
      return {
        id: s.id,
        source: s.source,
        part: s.part,
        chars: s.chars,
        text: s.text ?? fixed ?? null,
        cut: s.cut === true,
        from_definition: fixed !== undefined,
      };
    }),
  };
}
