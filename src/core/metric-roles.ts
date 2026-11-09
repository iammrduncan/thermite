import { z } from "zod";

/**
 * What each of a hill climb's metrics is for (goal 209). The priority metrics are what it climbs:
 * the first, the primary, decides, and each next one breaks a tie on those before it. A guard
 * metric holds it to account: a change that breaks one of its guards is refused, however much it
 * gains. An informational metric is recorded with every measurement and never decides. A kit
 * names its metrics' kinds and guards in kit.json; a campaign's contract may add metrics to a
 * kind and tighten a kit's guards (core/metric-plan.ts). Another kind a kit needs is recorded and
 * shown as an informational metric is.
 */

/**
 * A guard's bound: where its metric must stay, against what. `above`: at least the reference less
 * `by` of it (by 0.05: no more than 5% below it); `below`: at most the reference plus `by` of it;
 * `within`: no further from the reference than `by` standard deviations of its spread. The
 * reference is the run's `baseline`, the `champion` in force, or a fixed `value`.
 */
export const GuardRule = z.strictObject({
  stay: z.enum(["above", "below", "within"]),
  against: z.enum(["baseline", "champion", "value"]),
  /** A fraction of the reference for above and below, standard deviations for within. */
  by: z.number().nonnegative().optional(),
  /** Against a value: the value. */
  value: z.number().optional(),
  /**
   * A guard that asks (goal 212): a change past it is not refused; once confirmed better, it waits
   * for the owner's yes, with the guard and its value. For now, only against a value.
   */
  ask: z.literal(true).optional(),
});
export type GuardRule = z.infer<typeof GuardRule>;

/** What a kit's or a contract's entry says one metric is for. */
export const MetricRole = {
  /** priority, guard, info, or another kind the kit needs; none: informational. */
  kind: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/, "a kind is a lowercase word, such as priority, guard or info")
    .optional(),
  /** A priority metric's place: 1 is the primary. */
  priority: z.number().int().min(1).max(16).optional(),
  direction: z.enum(["max", "min"]).optional(),
  /** The smallest change that counts, as a fraction (0.02 is 2%): a tie is broken only by one. */
  min_effect: z.number().positive().optional(),
  guards: z.array(GuardRule).min(1).max(8).optional(),
};
export const MetricRoleSchema = z.strictObject(MetricRole);
export type MetricRole = z.infer<typeof MetricRoleSchema>;

/** One guard in words, as a page or a brief says it: `at most 5% above the baseline`. */
export function guardWords(g: GuardRule): string {
  const ref = g.against === "value" ? String(g.value) : `the ${g.against}`;
  const pct = `${+((g.by ?? 0) * 100).toFixed(2)}%`;
  if (g.stay === "within") return `within ${g.by} standard deviations of ${ref}`;
  if (g.against === "value") return `${g.stay === "above" ? "at least" : "at most"} ${ref}`;
  if (!g.by) return `${g.stay === "above" ? "at least" : "at most"} ${ref}`;
  return `at most ${pct} ${g.stay === "above" ? "below" : "above"} ${ref}`;
}

/** A guard in words, with what happens past it: refused, or waiting for the owner (goal 212). */
export function guardWordsAsks(g: GuardRule): string {
  return g.ask ? `${guardWords(g)}, or it asks the owner` : guardWords(g);
}

/** What is wrong with one metric's entry, in words; empty when it holds. */
export function roleProblems(name: string, r: MetricRole): string[] {
  const out: string[] = [];
  const at = `metric ${name}`;
  if (r.kind === "priority") {
    if (r.priority === undefined)
      out.push(`${at} is a priority metric: give its priority, 1 first`);
    if (!r.direction) out.push(`${at} is a priority metric: give its direction, max or min`);
    if (r.priority === 1 && r.min_effect === undefined)
      out.push(`${at} is the primary metric: give its min_effect, the smallest gain that counts`);
  } else {
    for (const k of ["priority", "direction", "min_effect"] as const)
      if (r[k] !== undefined)
        out.push(`${at}: ${k} is for a priority metric, and its kind is ${r.kind ?? "none"}`);
  }
  if (r.kind === "guard" && !r.guards?.length)
    out.push(`${at} is a guard metric: give its guards, each where it must stay`);
  for (const [i, g] of (r.guards ?? []).entries()) {
    const w = `${at}, guard ${i + 1}`;
    if (g.ask && g.against !== "value")
      out.push(`${w}: ask is for a guard against a value; one against the ${g.against} refuses`);
    if (g.against === "value") {
      if (g.value === undefined) out.push(`${w}: against a value, give the value`);
      if (g.stay === "within")
        out.push(`${w}: within is against the baseline or the champion, which have a spread`);
      if (g.by !== undefined)
        out.push(`${w}: against a value, by has no use; give the value itself`);
    } else {
      if (g.value !== undefined)
        out.push(
          `${w}: value is for a guard against a value, and this one is against the ${g.against}`,
        );
      if (g.by === undefined)
        out.push(
          `${w}: give by, ${g.stay === "within" ? "how many standard deviations it may move" : "how far it may move, as a fraction"}`,
        );
      if (g.stay === "within" && g.by === 0)
        out.push(`${w}: within 0 standard deviations allows no change at all`);
    }
  }
  return out;
}

/**
 * What a metric that may be zero (goal 211) can't be, in words: a priority metric, or held by a
 * guard against the baseline or the champion. The judge compares those by their ratio, which a
 * zero has none of; an informational metric and a guard against a value compare values.
 */
/**
 * A metric measured once a job (goal 233) has a value in the change's first block alone: it can't
 * be a priority metric, nor have a guard against the champion or the baseline, which compare it
 * block by block.
 */
export function onceProblems(name: string, r: MetricRole): string[] {
  const out: string[] = [];
  if (r.kind === "priority" || r.priority !== undefined)
    out.push(
      `metric ${name} is measured once a job, so it can't be a priority metric: the judge compares those block by block`,
    );
  for (const g of r.guards ?? [])
    if (g.against !== "value")
      out.push(
        `metric ${name} is measured once a job, so its guard can't be against the ${g.against}, which the judge compares block by block: hold it against a value`,
      );
  return out;
}

export function zeroProblems(name: string, r: MetricRole): string[] {
  const out: string[] = [];
  if (r.kind === "priority" || r.priority !== undefined)
    out.push(
      `metric ${name} may be zero, so it can't be a priority metric: the judge compares those by their ratio`,
    );
  for (const g of r.guards ?? [])
    if (g.against !== "value")
      out.push(
        `metric ${name} may be zero, so its guard can't be against the ${g.against}, which the judge compares by their ratio: hold it against a value`,
      );
  return out;
}
