import { z } from "zod";
import { CampaignId, RIG_ID } from "../ids.ts";
import { kindOf, perRig, RETENTION_KIND_KEYS, type RetentionKind } from "./kinds.ts";

/**
 * A retention policy's design (index.ts), and the one function that says what it removes of a
 * kind's items now: wouldRemove, for the preview on control and the run on control, a rig and a
 * supervisor alike.
 */

export const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type Day = (typeof DAYS)[number];

/** A day as the page shows it: "Sunday". */
export const dayWords = (d: Day): string => `${d[0]?.toUpperCase()}${d.slice(1)}`;

/** The most rigs or campaigns one policy names. */
const RETENTION_WHERE_MAX = 500;
/** The longest name of a policy. */
export const RETENTION_NAME_MAX = 80;

/** The time of day a policy runs, in UTC: HH:MM. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What a policy removes, and what it always keeps: what a rig needs to act on it. */
export const RetentionRule = z.strictObject({
  kind: z.enum(RETENTION_KIND_KEYS as [RetentionKind, ...RetentionKind[]]),
  rule: z.enum(["older", "newest", "size"]),
  older_n: z.number().int().min(1).max(100_000).default(30),
  older_unit: z.enum(["days", "weeks", "months"]).default("days"),
  newest_n: z.number().int().min(1).max(100_000_000).default(20),
  newest_per: z.enum(["rig", "run", "all"]).default("rig"),
  size_gib: z.number().positive().max(1_000_000).default(50),
  keep: z
    .strictObject({
      open: z.boolean().default(true),
      champions: z.boolean().default(true),
      newest: z.boolean().default(true),
    })
    .default({ open: true, champions: true, newest: true }),
});
export type RetentionRule = z.output<typeof RetentionRule>;

/** A policy as the owner designs it: its name, its rule, where, and when. */
export const RetentionSpec = RetentionRule.extend({
  name: z.string().trim().min(1, "a policy needs a name").max(RETENTION_NAME_MAX),
  where: z.enum(["all", "rigs", "campaigns"]).default("all"),
  rigs: z.array(z.string().regex(RIG_ID)).max(RETENTION_WHERE_MAX).default([]),
  campaigns: z.array(CampaignId).max(RETENTION_WHERE_MAX).default([]),
  when: z.enum(["daily", "weekly", "hand"]).default("daily"),
  time: z.string().regex(TIME, "a time of day, HH:MM in UTC").default("03:00"),
  day: z.enum(DAYS).default("sunday"),
});
export type RetentionSpec = z.output<typeof RetentionSpec>;
export type RetentionSpecInput = z.input<typeof RetentionSpec>;

/** A policy as control keeps it. */
export interface RetentionPolicy extends RetentionSpec {
  id: number;
  on: boolean;
  /** When it was last turned on: a due time before it does not run it. */
  on_since: string | null;
  /** The due time it last ran for; null when it never ran on its schedule. */
  last_due: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** A policy's design alone, without what control keeps beside it (its id, switch and times). */
export function specPart(p: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(RetentionSpec.shape).flatMap((k) => (k in p ? [[k, p[k]]] : [])),
  );
}

/** The rule's part of a policy: what a rig is sent. */
export function ruleOf(p: RetentionRule): RetentionRule {
  return RetentionRule.parse({
    kind: p.kind,
    rule: p.rule,
    older_n: p.older_n,
    older_unit: p.older_unit,
    newest_n: p.newest_n,
    newest_per: p.newest_per,
    size_gib: p.size_gib,
    keep: p.keep,
  });
}

// ---------------------------------------------------------------- what a policy removes

/** One thing of a kind, as wouldRemove reads it. */
export interface RetentionItem {
  /** How its remover names it: a build's key, a file's path, a version, an entry's id. */
  id: string;
  /** The rig it is on; null on control. */
  rig: string | null;
  /** The run it belongs to, when there is one. */
  run: string | null;
  /** When it was made (ISO 8601). */
  at: string;
  bytes: number;
  /** How many of the kind's unit it is: 1, but for a group of a rig's oldest (packItems). */
  count: number;
  /** Its run is still open. */
  open?: boolean;
  /** A champion's (or a lane's best) build. */
  champion?: boolean;
}

/** What a policy removes now: the items, and their count, bytes, rigs and dates. */
export interface Removal {
  items: RetentionItem[];
  count: number;
  bytes: number;
  rigs: number;
  /** The oldest's and the newest's time; null when it removes nothing. */
  oldest: string | null;
  newest: string | null;
}

const DAY_MS = 86_400_000;
const UNIT_DAYS = { days: 1, weeks: 7, months: 30 } as const;
const GIB = 2 ** 30;

/**
 * What a policy's rule removes of a kind's items now, after what it always keeps. The caller gives
 * only the items where the policy acts (its rigs). Older than: an item older than the age. Beyond
 * the newest: each group (rig, run or all) keeps its newest items until they hold N. Over a size: the oldest go first,
 * those it keeps passed over, until what is left fits. A month is 30 days. One function for the
 * preview on control and the run on control, a rig and a supervisor alike.
 */
export function wouldRemove(p: RetentionRule, items: readonly RetentionItem[], now: Date): Removal {
  const keeps = kindOf(p.kind).keeps;
  const newestOfAll =
    p.keep.newest && keeps.newest
      ? items.reduce<RetentionItem | undefined>((a, b) => (!a || b.at > a.at ? b : a), undefined)
      : undefined;
  const kept = (x: RetentionItem) =>
    (p.keep.open && keeps.open !== undefined && x.open === true) ||
    (p.keep.champions && keeps.champions !== undefined && x.champion === true) ||
    x === newestOfAll;
  const newestFirst = (a: RetentionItem, b: RetentionItem) =>
    a.at < b.at ? 1 : a.at > b.at ? -1 : a.id.localeCompare(b.id);
  let gone: RetentionItem[] = [];
  if (p.rule === "older") {
    const cut = now.getTime() - p.older_n * UNIT_DAYS[p.older_unit] * DAY_MS;
    gone = items.filter((x) => Date.parse(x.at) < cut && !kept(x));
  } else if (p.rule === "newest") {
    // Each group keeps its newest items until they hold N of the kind's unit: a group of many
    // (a rig's events of a day, a rig's oldest packed together) is kept or removed whole.
    const groups = new Map<string, RetentionItem[]>();
    for (const x of items) {
      const g =
        !perRig(p.kind) || p.newest_per === "all"
          ? ""
          : p.newest_per === "rig"
            ? (x.rig ?? "")
            : (x.run ?? "");
      const list = groups.get(g);
      if (list) list.push(x);
      else groups.set(g, [x]);
    }
    for (const g of groups.values()) {
      let held = 0;
      for (const x of g.sort(newestFirst)) {
        if (held < p.newest_n) held += x.count;
        else if (!kept(x)) gone.push(x);
      }
    }
  } else {
    const budget = p.size_gib * GIB;
    let total = items.reduce((n, x) => n + x.bytes, 0);
    for (const x of [...items].sort(newestFirst).reverse()) {
      if (total <= budget) break;
      if (kept(x)) continue;
      gone.push(x);
      total -= x.bytes;
    }
  }
  const ats = gone.map((x) => x.at).sort();
  return {
    items: gone,
    count: gone.reduce((n, x) => n + x.count, 0),
    bytes: gone.reduce((n, x) => n + x.bytes, 0),
    rigs: new Set(gone.flatMap((x) => (x.rig ? [x.rig] : []))).size,
    oldest: ats[0] ?? null,
    newest: ats.at(-1) ?? null,
  };
}
