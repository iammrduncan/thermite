import { sizeWords } from "../words.ts";
import { type KeepKey, kindOf, onRigs, type RetentionKind } from "./kinds.ts";
import { dayWords, type Removal, type RetentionRule, type RetentionSpec } from "./policy.ts";
import type { RetentionWhen } from "./schedule.ts";

/** A retention policy in words (index.ts): its rule, what it keeps, where, when, what it removed. */
/** The rule in words: "older than 30 days". */
export function ruleWords(p: RetentionRule): string {
  if (p.rule === "older") return `older than ${p.older_n} ${p.older_unit}`;
  if (p.rule === "newest") {
    const per = !onRigs(p.kind) ? "" : p.newest_per === "all" ? " in all" : ` per ${p.newest_per}`;
    return `all but the newest ${p.newest_n}${per}`;
  }
  return `the oldest, until under ${p.size_gib} GiB`;
}

/** What the policy always keeps of its kind, in words; empty when nothing. */
export function keepWords(p: RetentionRule): string {
  const keeps = kindOf(p.kind).keeps;
  return (Object.entries(keeps) as [KeepKey, string][])
    .filter(([k]) => p.keep[k])
    .map(([, w]) => w.toLowerCase())
    .join("; ");
}

/** Where the policy acts, in words: "every rig", "rig-1, rig-2", "control". */
export function whereWords(
  p: Pick<RetentionSpec, "kind" | "where" | "rigs" | "campaigns">,
): string {
  if (!onRigs(p.kind)) return "control";
  if (p.where === "all") return "every rig";
  if (p.where === "rigs") return p.rigs.length ? p.rigs.join(", ") : "no rig chosen";
  return p.campaigns.length ? `the rigs of ${p.campaigns.join(", ")}` : "no campaign chosen";
}

/** When it runs, in words: "every day at 03:00 UTC". */
export function whenWords(w: RetentionWhen): string {
  if (w.when === "daily") return `every day at ${w.time} UTC`;
  if (w.when === "weekly") return `every ${dayWords(w.day)} at ${w.time} UTC`;
  return "only when you press Run now";
}

/** A removal in words: "120 builds on 2 rigs, 4.20 GiB, from 2026-08-01 to 2026-09-30". */
export function removeWords(
  kind: RetentionKind,
  r: Pick<Removal, "count" | "bytes" | "oldest" | "newest"> & { rigs?: number },
): string {
  if (r.count === 0) return "nothing";
  const on = r.rigs ? ` on ${r.rigs} rig${r.rigs > 1 ? "s" : ""}` : "";
  const day = (at: string | null) => (at ?? "").slice(0, 10);
  const span =
    r.oldest && r.newest
      ? day(r.oldest) === day(r.newest)
        ? `, from ${day(r.oldest)}`
        : `, from ${day(r.oldest)} to ${day(r.newest)}`
      : "";
  const unit = r.count === 1 ? kindOf(kind).one : kindOf(kind).unit;
  return `${r.count.toLocaleString("en-US")} ${unit}${on}, ${sizeWords(r.bytes)}${span}`;
}

/** The policy in one line, as the audit log and the command line say it. */
export function policyWords(p: RetentionSpec): string {
  const keep = keepWords(p);
  return `${kindOf(p.kind).label}, ${whereWords(p)}: removes ${ruleWords(p)}${keep ? ` (keeps ${keep})` : ""}, ${whenWords(p)}`;
}

/** The kinds' labels, in words: for a refusal that names them. */
