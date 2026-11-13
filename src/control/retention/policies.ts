import { BadInput, Refusal } from "../../common/errors.ts";
import { filterInTurn, mapInTurn } from "../../common/in-turn.ts";
import {
  keepWords,
  kindOf,
  nextDueAt,
  perRig,
  policyWords,
  RETENTION_KIND_KEYS,
  type RetentionPolicy,
  type RetentionSpec,
  RetentionSpec as RetentionSpecSchema,
  removeWords,
  ruleWords,
  whenWords,
  whereWords,
  wouldRemove,
} from "../../core/retention/index.ts";
import { sizeWords } from "../../core/words.ts";
import type { ControlStore, RetentionRemovalRow } from "../store/index.ts";
import { itemsOf, knownRig } from "./items.ts";

/**
 * The owner's retention policies on control (core/retention/): made, changed, turned on and
 * off, and removed, each change written to the audit log; and what each would remove now. The
 * dashboard, REST, MCP and the command line all call these, so each refuses in the same words.
 */

/** What a policy would remove now, in figures and in words. */
export interface PolicyPreview {
  count: number;
  bytes: number;
  rigs: number;
  oldest: string | null;
  newest: string | null;
  /** "It would remove …" or "It would remove nothing now." */
  words: string;
  /** What would stay of its kind where it acts, in words. */
  stays: string;
  /** Rigs it covers that have not said what they keep yet: their items are not counted. */
  unreported: string[];
}

/** A policy with its words, what it would remove now, its last removal and its next time. */
export interface PolicyView extends RetentionPolicy {
  label: string;
  rule_words: string;
  where_words: string;
  when_words: string;
  keep_words: string;
  would_remove: PolicyPreview;
  last: RetentionRemovalRow | null;
  /** When it runs next once on; null for one only run by hand. */
  next_at: string | null;
}

/** The kinds a policy may remove, as REST and MCP list them. */
export const retentionKinds = () =>
  RETENTION_KIND_KEYS.map((k) => ({
    kind: k,
    label: kindOf(k).label,
    on: kindOf(k).on,
    words: kindOf(k).words,
    ...(kindOf(k).warn ? { warn: kindOf(k).warn } : {}),
    keeps: kindOf(k).keeps,
  }));

/** A spec as a caller gives it, checked: refused in words when it is not one. */
export async function specOf(store: ControlStore, input: unknown): Promise<RetentionSpec> {
  const read = RetentionSpecSchema.safeParse(input);
  if (!read.success)
    throw new BadInput(
      `not a retention policy: ${read.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`).join("; ")}`,
    );
  const spec = read.data;
  if (perRig(spec.kind) && spec.where === "rigs") {
    const unknown = await filterInTurn(spec.rigs, async (r) => !(await knownRig(store, r)));
    if (unknown.length) throw new BadInput(`control knows no rig ${unknown.join(", ")}`);
  }
  return spec;
}

/** What a spec would remove now, where it acts. */
export async function previewOf(
  store: ControlStore,
  spec: RetentionSpec,
  now = new Date(),
): Promise<PolicyPreview> {
  const where = await itemsOf(store, spec);
  const r = wouldRemove(spec, where.items, now);
  const total = where.items.reduce((n, x) => n + x.bytes, 0);
  const label = kindOf(spec.kind).label.toLowerCase();
  return {
    count: r.count,
    bytes: r.bytes,
    rigs: r.rigs,
    oldest: r.oldest,
    newest: r.newest,
    words: r.count
      ? `It would remove ${removeWords(spec.kind, r)}.`
      : "It would remove nothing now.",
    stays: r.count
      ? `${sizeWords(total - r.bytes)} of ${label} would stay.`
      : "Everything it covers is inside the rule today.",
    unreported: where.unreported,
  };
}

/** A policy as the page, REST and MCP show it. */
export async function policyView(
  store: ControlStore,
  p: RetentionPolicy,
  now = new Date(),
): Promise<PolicyView> {
  const next = p.when === "hand" ? null : nextDueAt(p, now);
  return {
    ...p,
    label: kindOf(p.kind).label,
    rule_words: ruleWords(p),
    where_words: whereWords(p),
    when_words: whenWords(p),
    keep_words: keepWords(p),
    would_remove: await previewOf(store, p, now),
    last: (await store.retention.removals(1, p.id))[0] ?? null,
    next_at: next?.toISOString() ?? null,
  };
}

/** Every policy, oldest first, as policyView shows each. */
export async function policyViews(store: ControlStore, now = new Date()): Promise<PolicyView[]> {
  return mapInTurn(await store.retention.list(), async (p) => policyView(store, p, now));
}

/** A policy by its id; refused in words when control has none. */
export async function policyOf(store: ControlStore, id: number): Promise<RetentionPolicy> {
  const p = await store.retention.get(id);
  if (!p) throw new Refusal(`no retention policy ${id}`);
  return p;
}

/** What the audit log keeps of a policy: its id, name, whether on, and its design in words. */
const audited = (p: RetentionPolicy) => ({
  id: p.id,
  name: p.name,
  on: p.on,
  policy: policyWords(p),
});

/** A new policy: off unless `on`, which turns it on from now. Written to the audit log. */
export async function createPolicy(
  store: ControlStore,
  input: unknown,
  on: boolean,
  by: string,
): Promise<RetentionPolicy> {
  const spec = await specOf(store, input);
  const p = await store.tx(async () => {
    const made = await policyOf(store, await store.retention.add(spec, on, by));
    await store.auditLog.add(by, "retention_policy_created", audited(made));
    return made;
  });
  return p;
}

/**
 * A policy's new design, on or off as `on` says (left out: as it was). Its last run stays, so a
 * due time it ran for does not run it again. Written to the audit log with what it was.
 */
export async function updatePolicy(
  store: ControlStore,
  id: number,
  input: unknown,
  on: boolean | undefined,
  by: string,
): Promise<RetentionPolicy> {
  const was = await policyOf(store, id);
  const spec = await specOf(store, input);
  return store.tx(async () => {
    await store.retention.update(id, spec, on ?? was.on, by);
    const now = await policyOf(store, id);
    await store.auditLog.add(by, "retention_policy_changed", {
      ...audited(now),
      was: audited(was),
    });
    return now;
  });
}

/** Turns a policy on (from now) or off. Written to the audit log when it changes. */
export async function setPolicyOn(
  store: ControlStore,
  id: number,
  on: boolean,
  by: string,
): Promise<RetentionPolicy> {
  const was = await policyOf(store, id);
  if (was.on === on) return was;
  return store.tx(async () => {
    await store.retention.setOn(id, on, by);
    const now = await policyOf(store, id);
    await store.auditLog.add(by, on ? "retention_policy_on" : "retention_policy_off", audited(now));
    return now;
  });
}

/** Deletes a policy; what it removed stays in the history. Written to the audit log. */
export async function deletePolicy(
  store: ControlStore,
  id: number,
  by: string,
): Promise<RetentionPolicy> {
  const was = await policyOf(store, id);
  await store.tx(async () => {
    await store.retention.remove(id);
    await store.auditLog.add(by, "retention_policy_deleted", audited(was));
  });
  return was;
}
