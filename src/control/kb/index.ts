import type { BriefingSeed, QueueSeed } from "../../core/commands.ts";
import { RunId } from "../../core/ids.ts";
import type { KbItemFile, KbKind } from "../../core/kb.ts";
import { clip } from "../../core/kb-index.ts";

/**
 * Thermite's own knowledge base (goals 065 and 175), on control: one collection for each
 * campaign, a collection's runs, a run's slots (one for each writer), a slot's items and their
 * versions. Thermite's code writes each run's records slot from the rigs' signed events as they
 * arrive (core/kb-index.ts reads each): the runs, the trials, the agents' field notes and research
 * notes, the documents lanes wrote, the experiments with their results, attempts with their
 * verdicts, sources with their text, claims, findings and reports, each with its run, who wrote it
 * and when. An agent writes only its own slot, with a `kb_item` event its harness signs. A
 * campaign reads its own collection and, when the owner grants it, other campaigns' collections.
 *
 * Its collections, items, versions, runs, grants, scopes, files and cursor are kept by the store's
 * knowledge base (store/kb/); the files themselves in control's state (files.ts).
 */

export type { KbKind } from "../../core/kb.ts";
export { followKbFiles, KbFiles } from "./files.ts";

/** The field notes' kinds (journal_note); a research note is a note of kind "note". */
export const JOURNAL_KINDS = ["observation", "decision", "surprise", "question", "lesson"] as const;

export interface KbItem {
  id: number;
  /** Increases on every insert and every update of any item: the rigs' sync cursor. */
  seq: number;
  campaign: string;
  rig: string;
  /** The rig's ledger the item came from (a reset starts a new one; items never mix). */
  ledger: string;
  run: string;
  /** Its writer's slot in the run: records (Thermite's code), or an agent's role and lane. */
  slot: string;
  kind: KbKind;
  /** The item's id in its slot (an experiment, an attempt, a claim, a note's number). */
  ref: string;
  /** Its newest version; the older ones stay. */
  version: number;
  title: string;
  body: string;
  /** Who wrote it: a lane, the planner, an advisor, the judge, the owner. */
  by: string;
  url: string | null;
  /** For a note: observation, decision, surprise, question, lesson or note. */
  sub: string | null;
  /** Fields kept apart: an experiment's details, why and direction. */
  meta: Record<string, string>;
  /** A file item's file, by its SHA-256; null for a blurb. */
  file: KbItemFile | null;
  at: string;
  updated_at: string;
}

/** One campaign's collection: its items by kind, its runs, its newest change and its grants. */
export interface KbCollection {
  campaign: string;
  counts: Partial<Record<KbKind, number>>;
  /** Of the notes, how many are field notes (observations, decisions, …), not research notes. */
  journal: number;
  items: number;
  runs: number;
  updated_at: string;
  /** The campaigns granted to read this collection. */
  read_by: string[];
  /** The collections this campaign reads besides its own. */
  reads: string[];
}

/** Items a rig's sync answers at most at once (it asks again while `more` is true). */
export const SYNC_PAGE = 500;

/** The kinds the owner can pick from past research when starting a run, and where each goes. */
export const PICKABLE: Partial<Record<KbKind, "queue" | "briefing">> = {
  experiment: "queue",
  finding: "briefing",
  claim: "briefing",
  note: "briefing",
  report: "briefing",
};

/**
 * A past experiment the owner picked, for a new run's queue: what it tried, who added it and
 * why, and what it gave in its run. Undefined when its run's name is not an id a seed can carry.
 */
export function queueSeedOf(x: KbItem, result: string | null): QueueSeed | undefined {
  if (x.kind !== "experiment" || !RunId.safeParse(x.run).success) return undefined;
  const details = [
    x.meta.details ?? "",
    result ? `In ${x.run} (${x.campaign}) it was ${result}.` : `From ${x.run} (${x.campaign}).`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    title: clip(x.title, 200),
    ...(details ? { details: clip(details, 4000) } : {}),
    ...(x.meta.family ? { family: clip(x.meta.family, 80) } : {}),
    ...(x.meta.why ? { why: clip(x.meta.why, 2000) } : {}),
    by: clip(x.by || "copied", 80),
    state: "queued",
    from: { run: x.run, id: clip(x.ref, 64) },
  };
}

/** A past finding, claim, note or report the owner picked, as background for every brief. */
export function briefingSeedOf(x: KbItem): BriefingSeed | undefined {
  if (PICKABLE[x.kind] !== "briefing" || !RunId.safeParse(x.run).success) return undefined;
  const text = clip(
    x.kind === "report" || x.body.startsWith(x.title.replace(/…$/, ""))
      ? x.body
      : `${x.title}\n${x.body}`,
    4000,
  ).trim();
  if (!text) return undefined;
  return {
    text,
    from: { campaign: x.campaign, rig: x.rig, run: x.run, kind: x.kind, ref: x.ref },
  };
}
