import { z } from "zod";
import { PLAN_LIMITS } from "../../../agents/roles/index.ts";
import { canonicalJson } from "../../../core/canonical.ts";
import { QueuePosition } from "../../../core/commands.ts";
import { asToken, DirectionRef, directionName, notADirection } from "../../../core/directions.ts";
import { DIRECTIVE_KINDS } from "../../../core/directives.ts";
import { directionOf, inFamily } from "../../queue.ts";
import { directiveSets, lanesOf, type PlannerInput, toConvert, toDesign } from "./context.ts";

/**
 * The model's answer and its check: the shape a plan takes, and the rules code holds every plan
 * to before any of it is applied.
 */

export interface NewFamily {
  id: string;
  description: string;
}

/**
 * A rule the planner adds because an owner's message asked for it, in :name: or in plain words:
 * for one of the run's directions, or a new one it designs in the same answer (goal 066).
 */
export interface PlannerRule {
  kind: "avoid" | "try" | "mandate";
  family: string;
  rationale: string;
  /** The owner's message that asked for it. */
  from_message: number;
}

/** The model's checked answer: its queue changes, its rules and its hand-out. */
export interface QueuePlan {
  /** New experiments; `ref` is how an assignment names one (inline ones get `@lane-N`). */
  add: {
    ref: string;
    title: string;
    details?: string | undefined;
    family?: string | undefined;
    why: string;
    position?: QueuePosition | undefined;
    /** A research task's question, an index from 0 (the research planner's, goal 117). */
    question?: number | undefined;
  }[];
  move: { id: string; position: QueuePosition; why: string }[];
  drop: { id: string; why: string }[];
  accept: { id: string; why: string; position?: QueuePosition | undefined }[];
  rules: PlannerRule[];
  /**
   * The old rules in words in force (legacy), each with the direction its words mean: one the run
   * has, or one designed in the same answer. Code replaces each with a rule on that direction.
   */
  convert: { rule: number; family: string }[];
  /** Each lane's experiment (a queued or proposed id, or an added one's ref) and why. */
  handout: { lane: string; experiment: string; parent: "champion" | "lane_best"; why: string }[];
}

const Why = z.string().trim().min(1).max(PLAN_LIMITS.why);
const PlanSchema = z.object({
  /**
   * New directions: the name (plain words or :name:, kept as its name) and what it means. Room
   * for one more for each old rule in words the round converts, so each can get a new one.
   */
  new_families: z
    .array(
      z.object({
        id: DirectionRef,
        description: z.string().trim().min(3).max(PLAN_LIMITS.description),
      }),
    )
    .max(PLAN_LIMITS.newFamilies)
    .default([]),
  add: z
    .array(
      z.object({
        ref: z.string().trim().min(1).max(PLAN_LIMITS.ref).optional(),
        title: z.string().trim().min(1).max(PLAN_LIMITS.title),
        details: z.string().max(PLAN_LIMITS.details).optional(),
        family: z.string().trim().min(1).max(PLAN_LIMITS.family).optional(),
        why: Why,
        position: QueuePosition.optional(),
      }),
    )
    // No count (goal 081): the queue's target drives ideas, and nothing caps them.
    .default([]),
  move: z
    .array(
      z.object({ id: z.string().min(1).max(PLAN_LIMITS.id), position: QueuePosition, why: Why }),
    )
    .max(PLAN_LIMITS.changes)
    .default([]),
  drop: z
    .array(z.object({ id: z.string().min(1).max(PLAN_LIMITS.id), why: Why }))
    .max(PLAN_LIMITS.changes)
    .default([]),
  accept: z
    .array(
      z.object({
        id: z.string().min(1).max(PLAN_LIMITS.id),
        why: Why,
        position: QueuePosition.optional(),
      }),
    )
    .default([]),
  rules: z
    .array(
      z.object({
        kind: z.enum(["avoid", "try", "mandate"]),
        /** The direction, as its name or :name:; checked against the message and the run. */
        family: z.string().trim().max(200).optional(),
        /** Words: a rule no longer takes them, and one that gives them is refused with why. */
        match: z.unknown().optional(),
        rationale: z.string().trim().min(1).max(PLAN_LIMITS.why),
        from_message: z.coerce.number().int().positive(),
      }),
    )
    .max(PLAN_LIMITS.rules)
    .default([]),
  /** Old rules in words, each with the direction its words mean (goal 066). */
  convert: z
    .array(
      z.object({
        rule: z.coerce.number().int().positive(),
        /** The direction, as its name or :name:; checked against the run's and the answer's. */
        family: z.string().trim().max(200),
      }),
    )
    .max(PLAN_LIMITS.convert)
    .default([]),
  assignments: z.array(
    z.object({
      lane: z.string(),
      /** An experiment from the queue (its id) or one this answer adds (its ref). */
      experiment: z.string().trim().min(1).max(PLAN_LIMITS.id).optional(),
      /** Or a new experiment inline: what to try (title or focus), its direction and details. */
      title: z.string().trim().min(1).max(PLAN_LIMITS.title).optional(),
      focus: z.string().trim().min(3).max(PLAN_LIMITS.focus).optional(),
      family: z.string().trim().min(1).max(PLAN_LIMITS.family).optional(),
      details: z.string().max(PLAN_LIMITS.details).optional(),
      parent: z.enum(["champion", "lane_best"]).default("champion"),
      why: z.string().max(PLAN_LIMITS.why).optional(),
    }),
  ),
  notes: z.string().max(PLAN_LIMITS.notes).optional(),
});

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A directive's kind as a direction's id (lane_count: lane-count): never a direction's name. */
const DIRECTIVE_WORDS = new Set(DIRECTIVE_KINDS.map((k) => directionOf(k)));
const NOT_A_DIRECTION = `is a kind of rule (${DIRECTIVE_KINDS.join(", ")}), not a direction: name the direction by what it changes`;
const directiveWord = (family: string | undefined) =>
  family !== undefined && DIRECTIVE_WORDS.has(directionOf(family));

/** Checks a raw plan; returns the errors (empty when valid) and the checked plan. */
export function validatePlan(
  raw: unknown,
  input: PlannerInput,
): {
  errors: string[];
  plan?: QueuePlan & { newFamilies: NewFamily[]; notes?: string | undefined };
} {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success)
    return { errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const p = parsed.data;
  const errors: string[] = [];
  const lanes = lanesOf(input.laneCount);
  const assigned = p.assignments.map((a) => a.lane).sort();
  if (canonicalJson(assigned) !== canonicalJson([...lanes].sort())) {
    errors.push(
      `assign each of ${lanes.join(", ")} exactly once (got ${assigned.join(", ") || "none"})`,
    );
  }
  const q = input.queue ?? { up_next: [], proposed: [], in_progress: [], tried: [] };
  const queued = new Map(q.up_next.map((x) => [x.id, x]));
  const proposed = new Map(q.proposed.map((x) => [x.id, x]));
  const elsewhere = new Map<string, string>([
    ...q.in_progress.map((x): [string, string] => [x.id, `in progress on ${x.lane}`]),
    ...q.tried.map((x): [string, string] => [x.id, "tried already"]),
  ]);
  const why = (id: string) => elsewhere.get(id) ?? "not in the queue";

  // The queue's changes: each names an experiment in the state it needs.
  for (const m of p.move)
    if (!queued.has(m.id)) errors.push(`move ${m.id}: only queued experiments move (${why(m.id)})`);
  for (const d of p.drop)
    if (!queued.has(d.id) && !proposed.has(d.id))
      errors.push(
        `drop ${d.id}: only queued or proposed experiments can be dropped (${why(d.id)})`,
      );
  for (const a of p.accept)
    if (!proposed.has(a.id)) errors.push(`accept ${a.id}: not a proposed idea (${why(a.id)})`);
  const dropped = new Set(p.drop.map((d) => d.id));

  // New experiments: the answer's own, then each inline one under its lane's ref.
  const add: QueuePlan["add"] = [];
  p.add.forEach((a, i) => {
    const ref = a.ref ?? `new-${i + 1}`;
    if (add.some((x) => x.ref === ref) || queued.has(ref) || proposed.has(ref))
      errors.push(`add: the ref ${ref} is used twice`);
    add.push({ ...a, ref });
  });
  const handout: QueuePlan["handout"] = [];
  for (const a of p.assignments) {
    let experiment = a.experiment;
    const text = a.title ?? a.focus;
    if (!experiment && text) {
      experiment = `@${a.lane}`;
      add.push({
        ref: experiment,
        title: clip(text, 200),
        ...(text.length > 200 || a.details
          ? { details: [text.length > 200 ? text : "", a.details ?? ""].filter(Boolean).join("\n") }
          : {}),
        ...(a.family ? { family: a.family } : {}),
        why: a.why?.trim() || text,
      });
    }
    if (!experiment) {
      errors.push(
        `${a.lane}: name an experiment (an id from the queue or the ref of one you add), or give a new one with title and family`,
      );
      continue;
    }
    const known =
      queued.get(experiment) ?? proposed.get(experiment) ?? add.find((x) => x.ref === experiment);
    if (!known)
      errors.push(`${a.lane}: experiment ${experiment} can't be given out (${why(experiment)})`);
    if (dropped.has(experiment))
      errors.push(`${a.lane}: experiment ${experiment} is dropped in this same answer`);
    if (a.parent === "lane_best" && !input.laneBests[a.lane])
      errors.push(`${a.lane}: has no lane best yet; use parent "champion"`);
    handout.push({
      lane: a.lane,
      experiment,
      parent: a.parent,
      why: a.why?.trim() || (known ? `next: ${known.title}` : ""),
    });
  }
  // A direction is never named by a kind of rule: a lane "on try" reads as a directive.
  for (const f of p.new_families)
    if (directiveWord(f.id)) errors.push(`new_families: "${f.id}" ${NOT_A_DIRECTION}`);
  for (const a of add)
    if (directiveWord(a.family))
      errors.push(
        `${a.ref.startsWith("@") ? a.ref.slice(1) : `add ${a.ref}`}: the family "${a.family}" ${NOT_A_DIRECTION}`,
      );
  const twice = handout.filter(
    (h, i) => handout.findIndex((o) => o.experiment === h.experiment) !== i,
  );
  for (const h of twice)
    errors.push(`${h.lane}: experiment ${h.experiment} is given to another lane too`);

  // The rules: AVOID families are never given out, every MANDATE family is.
  const familyOf = (id: string) =>
    (queued.get(id) ?? proposed.get(id) ?? add.find((x) => x.ref === id))?.family ?? "";
  const { avoid, mandate } = directiveSets(input);
  for (const h of handout) {
    const family = familyOf(h.experiment);
    for (const f of avoid)
      if (inFamily({ family }, f))
        errors.push(
          `${h.lane}: experiment ${h.experiment} is in family ${f}, under an AVOID directive`,
        );
  }
  for (const m of mandate) {
    if (!handout.some((h) => inFamily({ family: familyOf(h.experiment) }, m)))
      errors.push(
        `MANDATE directive: give a lane an experiment of family ${m} (add one if the queue has none)`,
      );
  }
  // Directions (goal 066): the planner designs each new one it or a rule names, in new_families.
  const known = input.directions;
  const designed = new Set(p.new_families.map((f) => f.id));
  for (const d of toDesign(input))
    if (!designed.has(d.name))
      errors.push(
        `rule ${d.rules.map((r) => r.id).join(", ")} names ${asToken(d.name)}, a direction this run doesn't have yet: design it in new_families, with its name and what it means, in your words`,
      );
  // Rules only from the owner's messages in this prompt, each naming a direction: one the run
  // has, or a new one this answer designs. A message's :name: names one exactly; its plain words
  // are the planner's to turn into directions.
  const messages = new Set((input.ownerMessages ?? []).map((m) => m.id));
  const rules: PlannerRule[] = [];
  for (const r of p.rules) {
    if (!messages.has(r.from_message)) {
      errors.push(
        `rules: message ${r.from_message} is not one of the owner's messages given to you`,
      );
      continue;
    }
    const family = r.family ? directionName(r.family) : undefined;
    if (!family) {
      const why = r.family
        ? notADirection(r.family)
        : r.match !== undefined
          ? "a rule no longer takes match"
          : "";
      errors.push(`rules: a rule names its direction in family${why ? `: ${why}` : ""}`);
      continue;
    }
    if (known && !known.includes(family) && !designed.has(family)) {
      errors.push(
        `rules: ${asToken(family)} is not one of the run's directions: to make a rule for a new direction, design it in new_families too`,
      );
      continue;
    }
    rules.push({ kind: r.kind, family, rationale: r.rationale, from_message: r.from_message });
  }
  // Old rules in words (goal 066): the answer gives each the direction its words mean, one the
  // run has or one it designs here; code then replaces the rule. One left out is refused.
  const words = new Map(toConvert(input).map((r) => [r.rule, r]));
  const convert: QueuePlan["convert"] = [];
  const seen = new Set<number>();
  for (const c of p.convert) {
    if (!words.has(c.rule)) {
      errors.push(`convert: rule ${c.rule} is not an old rule in words in to_convert`);
      continue;
    }
    if (seen.has(c.rule)) {
      errors.push(`convert: rule ${c.rule} is converted twice: give it one direction`);
      continue;
    }
    seen.add(c.rule);
    const family = directionName(c.family);
    if (!family) {
      errors.push(`convert: rule ${c.rule}: ${notADirection(c.family)}`);
      continue;
    }
    if (directiveWord(family)) {
      errors.push(`convert: rule ${c.rule}: "${c.family}" ${NOT_A_DIRECTION}`);
      continue;
    }
    if (known && !known.includes(family) && !designed.has(family)) {
      errors.push(
        `convert: rule ${c.rule}: ${asToken(family)} is not one of the run's directions: to convert it to a new direction, design it in new_families too`,
      );
      continue;
    }
    convert.push({ rule: c.rule, family });
  }
  for (const [id, r] of words)
    if (!p.convert.some((c) => c.rule === id))
      errors.push(
        `rule ${id} is an old rule in words ("${clip(r.words, 120)}"): convert it, in convert, to the direction its words mean: one in directions, or a new one you design in new_families`,
      );
  return {
    errors,
    plan: {
      add,
      move: p.move,
      drop: p.drop,
      accept: p.accept,
      rules,
      convert,
      handout,
      newFamilies: p.new_families,
      notes: p.notes,
    },
  };
}
