export type { EventKind } from "./events/kinds.ts";

/**
 * The one map of old names to public ones. Ledgers are append-only, and signed records keep the
 * words they were signed with, so events, commands and contracts recorded under an old name keep
 * it; readers see them under the public names through this. Stored rows that may change are
 * migrated instead (the ledger's and control's migrations).
 *
 * - 2026-10-15: a unit is now a rig and an instance a run.
 * - v0.1.1 (goal 125, T1): the merged by model and the review panel were `combiner` and `panel`.
 * - v0.1.1 (goal 125, the guide's questions 11 and 23): an approach family is a direction; a
 *   field note's kind `note` is `other`; a rule's kind `note` is `planner_note`; a research note
 *   is a source note; a contract's `notes` is `additional_information`; and the owner's label for
 *   one run, the signed `direction` of `assign_campaign`, is `note`.
 */

// Maps, not objects: a kind or a key comes from a rig's report, and an object would also answer
// for the names every object has (`constructor`, `toString`).
const KINDS = new Map([
  ["instance_created", "run_created"],
  ["instance_status", "run_status"],
  ["family_added", "direction_added"],
  ["family_status", "direction_status"],
  ["research_note", "source_note"],
]);

/** Keys renamed in every event's body, and in the records a body holds (NESTED). */
const KEYS = new Map([
  ["instance", "run"],
  ["source_instance", "source_run"],
  ["unit", "rig"],
  ["source_unit", "source_rig"],
  ["family", "direction"],
  ["new_families", "new_directions"],
]);

/**
 * Keys renamed in one kind's body only: before v0.1.1 a run's `direction` was the owner's label
 * for it, its note, where `direction` now names an approach.
 */
const KIND_KEYS = new Map([["run_created", new Map([["direction", "note"]])]]);

/** The fields of a body that hold records with old keys of their own: a rule, a list of rules. */
const NESTED = new Map([
  ["directive", ["body"]],
  ["directives_left_out", ["rules"]],
  ["conclusion_proposed", ["approaches"]],
  ["epoch_started", ["assignments"]],
]);

/** A rule's kind: `note`, free text for the planner, is `planner_note`. */
const RULE_KINDS = new Map([["note", "planner_note"]]);

/** A field note's kind: `note`, a note of no other kind, is `other`. */
const NOTE_KINDS = new Map([["note", "other"]]);

/** The kinds of event whose body (or whose rules, NESTED) holds a rule's kind. */
const RULE_KIND_EVENTS = new Set(["directive", "directives_left_out"]);

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

/** Every key a body's value may have been recorded under, the new one first. */
export function bodyKeys(key: string): string[] {
  return [key, ...[...KEYS].filter(([, now]) => now === key).map(([old]) => old)];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** An object's keys under the new names (`keys`); the same object when none is old. */
function renamed<T>(body: T, keys: ReadonlyMap<string, string> = KEYS): T {
  if (!isRecord(body) || !Object.keys(body).some((k) => keys.has(k))) return body;
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [keys.get(k) ?? k, v])) as T;
}

/** A rule (a directive's body) under the new names: its keys and its kind. */
export function currentRule<T>(rule: T): T {
  const r = renamed(rule);
  if (!isRecord(r) || typeof r.kind !== "string" || !RULE_KINDS.has(r.kind)) return r;
  return { ...r, kind: RULE_KINDS.get(r.kind) } as T;
}

/** A field note's kind under the new names. */
export function currentNoteKind(kind: string): string {
  return NOTE_KINDS.get(kind) ?? kind;
}

/** An event body's top-level keys under the new names. Other bodies are returned unchanged. */
export function currentBody<T>(body: T): T {
  return renamed(body);
}

/** One kind's body under the new names: its keys, its records' keys and the kinds they hold. */
function currentKindBody<T>(kind: string, body: T): T {
  const own = KIND_KEYS.get(kind);
  let b = renamed(own ? renamed(body, own) : body);
  const fields = NESTED.get(kind);
  if (!fields || !isRecord(b)) return b;
  const rules = RULE_KIND_EVENTS.has(kind);
  const one = (v: unknown) => (rules ? currentRule(v) : renamed(v));
  for (const field of fields) {
    const v: unknown = (b as Record<string, unknown>)[field];
    const now = Array.isArray(v)
      ? v.map(one).some((x, i) => x !== v[i])
        ? v.map(one)
        : v
      : one(v);
    if (now !== v) b = { ...(b as object), [field]: now } as T;
  }
  return b;
}

/** An event under the new names. */
export function currentEvent<E extends { kind: string; body: unknown }>(e: E): E {
  const kind = KINDS.get(e.kind) ?? e.kind;
  let body = currentKindBody(kind, e.body);
  if (kind === "journal_note" && isRecord(body) && typeof body.kind === "string") {
    const now = currentNoteKind(body.kind);
    if (now !== body.kind) body = { ...body, kind: now } as typeof body;
  }
  const field = AGENT_FIELDS.get(kind);
  const named =
    field && body && typeof body === "object"
      ? (body as Record<string, unknown>)[field]
      : undefined;
  if (field && typeof named === "string" && currentAgent(named) !== named)
    body = { ...(body as object), [field]: currentAgent(named) } as typeof body;
  return kind === e.kind && body === e.body ? e : { ...e, kind, body };
}

// ---------------------------------------------------------------- commands and contracts

/**
 * The old keys of each kind of signed command's payload, and their new names. A command signed
 * before v0.1.1 is read under the new names (currentCommand); control's APIs refuse a new one
 * that uses an old name (oldCommandKeys).
 */
const COMMAND_KEYS = new Map([
  ["assign_campaign", new Map([["direction", "note"]])],
  ["queue_add", new Map([["family", "direction"]])],
  ["queue_edit", new Map([["family", "direction"]])],
]);

/** The commands whose payload holds rules (`directives`), each read with currentRule. */
const RULE_COMMANDS = new Set(["redirect"]);

/** The lists in a command's payload whose records have old keys (KEYS): an assignment's queue. */
const RECORD_LISTS = new Map([["assign_campaign", "queue"]]);

/** A signed command's payload under the new names. */
export function currentCommand<T>(kind: string, payload: T): T {
  const keys = COMMAND_KEYS.get(kind);
  let p = keys ? renamed(payload, keys) : payload;
  if (RULE_COMMANDS.has(kind) && isRecord(p) && Array.isArray(p.directives)) {
    const rules = p.directives.map(currentRule);
    if (rules.some((r, i) => r !== (p as { directives: unknown[] }).directives[i]))
      p = { ...p, directives: rules } as T;
  }
  const list = RECORD_LISTS.get(kind);
  const records = list && isRecord(p) ? p[list] : undefined;
  if (list && Array.isArray(records)) {
    const now = records.map((r) => renamed(r));
    if (now.some((r, i) => r !== records[i])) p = { ...(p as object), [list]: now } as T;
  }
  return p;
}

/**
 * The old names a new command's payload uses, each as "`old` is now `new`": empty when none. A
 * rule's old kind counts too.
 */
export function oldCommandKeys(kind: string, payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const out = [...(COMMAND_KEYS.get(kind) ?? [])]
    .filter(([old]) => old in payload)
    .map(([old, now]) => `\`${old}\` is now \`${now}\``);
  if (RULE_COMMANDS.has(kind) && Array.isArray(payload.directives))
    for (const r of payload.directives) out.push(...oldRuleKeys(r));
  const list = RECORD_LISTS.get(kind);
  const records = list ? payload[list] : undefined;
  if (list && Array.isArray(records))
    for (const r of records)
      if (isRecord(r))
        for (const k of Object.keys(r).filter((k) => KEYS.has(k)))
          out.push(`\`${list}\`'s \`${k}\` is now \`${KEYS.get(k)}\``);
  return [...new Set(out)];
}

/** The old names a rule uses, each as "`old` is now `new`": empty when none. */
export function oldRuleKeys(rule: unknown): string[] {
  if (!isRecord(rule)) return [];
  const out = Object.keys(rule)
    .filter((k) => KEYS.has(k))
    .map((k) => `\`${k}\` is now \`${KEYS.get(k)}\``);
  if (typeof rule.kind === "string" && RULE_KINDS.has(rule.kind))
    out.push(`the kind \`${rule.kind}\` is now \`${RULE_KINDS.get(rule.kind)}\``);
  return out;
}

/**
 * A contract's keys before v0.1.1 and their new names. A contract keeps its keys as it was signed,
 * so its hash holds; readers take it through currentContract.
 */
export const CONTRACT_KEYS: ReadonlyMap<string, string> = new Map([
  ["notes", "additional_information"],
]);

/**
 * For a strict schema of a contract's parts (the New campaign page's draft, a copy's request): a
 * key from before v0.1.1 is refused with its new name. Other issues keep their own words.
 */
export function oldContractKeyError(issue: {
  code?: string;
  keys?: readonly string[];
}): string | undefined {
  if (issue.code !== "unrecognized_keys") return undefined;
  const old = (issue.keys ?? []).filter((k) => CONTRACT_KEYS.has(k));
  return old.length
    ? old.map((k) => `\`${k}\` is now \`${CONTRACT_KEYS.get(k)}\``).join("; ")
    : undefined;
}

/** A contract under the new names, to read; never to hash or to store. */
export function currentContract<T>(contract: T): T {
  return renamed(contract, CONTRACT_KEYS);
}
