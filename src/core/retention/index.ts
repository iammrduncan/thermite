/**
 * Retention policies (goal 125, T12; the owner's decisions of 2026-11-01): Thermite keeps
 * everything, everywhere, until a policy the owner designed removes some of it. A policy removes
 * one kind of thing, where the owner says, by one rule, at the times the owner chose; it starts
 * off, and shows what it would remove before it does. This module holds what control, the harness
 * and the supervisor share: the kinds (kinds.ts), a policy's shape and the one function that says
 * what a policy removes of a kind's items (policy.ts, wouldRemove), when a policy is due
 * (schedule.ts), the words for each (words.ts), and what a rig reports and records (space.ts).
 *
 * No policy removes a rig's ledger (each event's hash holds the one before it), a results
 * repository (the project's own), or an export (removed only by hand, on the Exports page).
 */

export {
  type KeepKey,
  KINDS_WORDS,
  kindOf,
  NEVER_REMOVED,
  onRigs,
  RETENTION_KIND_KEYS,
  type RetentionKind,
} from "./kinds.ts";
export {
  DAYS,
  dayWords,
  RETENTION_NAME_MAX,
  type RetentionItem,
  type RetentionPolicy,
  RetentionRule,
  RetentionSpec,
  type RetentionSpecInput,
  ruleOf,
  specPart,
  wouldRemove,
} from "./policy.ts";
export { dueAt, dueNow, firstRunWords, nextDueAt } from "./schedule.ts";
export {
  packItems,
  RetentionRemoved,
  RigSpace,
  removedBody,
  SPACE_ITEMS_MAX,
  SpaceInventory,
  unpackItems,
} from "./space.ts";
export { keepWords, policyWords, removeWords, ruleWords, whenWords, whereWords } from "./words.ts";
