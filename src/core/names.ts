export type { EventKind } from "./events/kinds.ts";

/**
 * The owner's names (2026-10-15): a unit is now a rig and an instance a run. Ledgers are
 * append-only, so events recorded before the rename keep their old kinds and body keys; readers
 * see them under the new names through this.
 */

// Maps, not objects: a kind or a key comes from a rig's report, and an object would also answer
// for the names every object has (`constructor`, `toString`).
const KINDS = new Map([
  ["instance_created", "run_created"],
  ["instance_status", "run_status"],
]);

const KEYS = new Map([
  ["instance", "run"],
  ["source_instance", "source_run"],
  ["unit", "rig"],
  ["source_unit", "source_rig"],
]);

/** The agents' names before v0.1.1 (goal 074): the merged by model and the review panel. */
const AGENTS = new Map([
  ["combiner", "merged_by"],
  ["panel", "review_panel"],
]);

/** The field of each kind of event that names an agent or an advisor role. */
const AGENT_FIELDS = new Map([
  ["model_call", "agent"],
  ["advisor_answer", "role"],
  ["agent_message", "to"],
  ["agent_message_read", "by"],
  ["journal_note", "by"],
]);

/**
 * An agent's or an advisor role's name under the public names, alone (`panel`) or naming a writer
 * (`panel:reviewer-1`).
 */
export function currentAgent(name: string): string {
  const [head = "", ...rest] = name.split(":");
  const now = AGENTS.get(head);
  return now ? [now, ...rest].join(":") : name;
}

/** Every kind an event of this (new) kind may have been recorded under. */
export function eventKinds(kind: string): string[] {
  return [kind, ...[...KINDS].filter(([, now]) => now === kind).map(([old]) => old)];
}

/** An event body's top-level keys under the new names. Other bodies are returned unchanged. */
export function currentBody<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  if (!Object.keys(b).some((k) => KEYS.has(k))) return body;
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [KEYS.get(k) ?? k, v])) as T;
}

/** An event under the new names. */
export function currentEvent<E extends { kind: string; body: unknown }>(e: E): E {
  const kind = KINDS.get(e.kind) ?? e.kind;
  let body = currentBody(e.body);
  const field = AGENT_FIELDS.get(kind);
  const named =
    field && body && typeof body === "object"
      ? (body as Record<string, unknown>)[field]
      : undefined;
  if (field && typeof named === "string" && currentAgent(named) !== named)
    body = { ...(body as object), [field]: currentAgent(named) } as typeof body;
  return kind === e.kind && body === e.body ? e : { ...e, kind, body };
}
