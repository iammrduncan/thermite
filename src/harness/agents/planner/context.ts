import type { BriefData } from "../../../core/brief.ts";
import { canonicalJson } from "../../../core/canonical.ts";
import {
  directionsToDesign,
  directionTokens,
  isLegacyRule,
  rulesToConvert,
} from "../../../core/directions.ts";
import type { StoredRule } from "../../../core/directives.ts";
import type { OwnerAddition } from "../../../core/role-additions.ts";
import { NOTES_ARE_DATA, type notesData } from "../../journal.ts";
import { briefingData } from "../../knowledge.ts";
import type { BriefingItem } from "../../ledger/index.ts";
import type { QueueBrief } from "../../queue.ts";
import type { Evidence, FamilyView } from "../registry.ts";

/**
 * What the planner reads each round: its input from the ledger, the run's past research and the
 * judge's goal report, and the context the prompt carries, as JSON.
 */

export interface PlannerInput {
  run: string;
  epoch: number;
  laneCount: number;
  objective: string;
  editablePaths: string[];
  champion: { seq: number; gain: number };
  families: FamilyView[];
  evidence: Evidence[];
  directives: { id: number; body: StoredRule }[];
  /** The run's directions (goal 066): the names a rule may name. */
  directions?: string[] | undefined;
  laneBests: Record<string, string | null>;
  /** The run's experiment queue (none: an empty queue). */
  queue?: QueueBrief | undefined;
  /** What each lane worked on last: its direction and its experiment's title. */
  laneState?: Record<string, { direction: string | null; experiment: string | null }> | undefined;
  /**
   * The campaign's brief, from its author and approved with the contract (goal 078): its
   * additional information, ideas to try and hypotheses, whole.
   */
  campaignBrief?: BriefData | undefined;
  /** The owner's messages to the planner since the last plan (message_agent), with their ids. */
  ownerMessages?: { id: number; text: string }[] | undefined;
  /** Goal mode: the judge's latest report on the champion. */
  goalReport?: GoalReport | undefined;
  /** The run's newest field notes (20), by every writer: the agents' own words, as data. */
  notes?: ReturnType<typeof notesData> | undefined;
  /** The background the owner picked from past research when starting the run. */
  briefing?: BriefingItem[] | undefined;
  /** Where the run's past research is and how to search it, when its folder has some (one line). */
  pastResearch?: string | undefined;
  /**
   * The run's target queue depth (goal 081): how many experiments up next should hold after the
   * round's hand-out. Below it, the planner is asked to top the queue up with distinct ideas.
   */
  queueTarget?: number | undefined;
  /**
   * The owner's addition to the planner for the campaign (goal 166): it goes into the prompt as a
   * section of its own, never into the run's state.
   */
  addition?: OwnerAddition | undefined;
}

/**
 * The queue's target as the planner reads it (goal 081): the target, what up next holds, and at
 * least how many to add (or accept from the lanes' ideas) to reach it after this hand-out.
 */
export function queueTargetContext(
  input: Pick<PlannerInput, "queue" | "laneCount" | "queueTarget">,
) {
  if (input.queueTarget === undefined) return undefined;
  const upNext = input.queue?.up_next.length ?? 0;
  return {
    target: input.queueTarget,
    up_next: upNext,
    add_at_least: Math.max(0, input.queueTarget - Math.max(0, upNext - input.laneCount)),
  };
}

/**
 * The run's past research for the planner through OpenCode, Claude Code or Codex: the folder its
 * files are in, which the planner reads with its own read tools. In every program it searches the
 * knowledge base with kb_search (PlannerMcp's kb).
 */
export interface PlannerPast {
  /** The run's knowledge/ folder. */
  dir: string;
}

/** The judge's validation of a goal campaign's champion: what it meets and what it does not. */
export interface GoalReport {
  champion_seq: number;
  goals: { goal: string; status: string; reasons: string }[];
  /**
   * The champion met every required goal, and its held-out check failed (goal 086): the run goes
   * on. Fixed words of the kinds of failure alone, never which case, its values or its texts.
   */
  not_confirmed?: string | undefined;
}

export function lanesOf(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `lane-${i + 1}`);
}

export function directiveSets(input: PlannerInput) {
  const of = (k: string) =>
    new Set(
      input.directives
        .filter((d) => d.body.kind === k && d.body.family)
        .map((d) => String(d.body.family)),
    );
  return { avoid: of("avoid"), mandate: of("mandate"), tryFam: of("try") };
}

/**
 * The directions that rules in force name but the run doesn't have yet (goal 066): the planner
 * designs each one. None when the run's directions are not given.
 */
export function toDesign(input: Pick<PlannerInput, "directions" | "directives">) {
  return input.directions ? directionsToDesign(input.directives, input.directions) : [];
}

/**
 * The old rules in words in force that this round converts (goal 066): each one the answer must
 * give a direction for.
 */
export function toConvert(input: Pick<PlannerInput, "directives">) {
  return rulesToConvert(input.directives);
}

/** The planner's context, as JSON: what the planner reads (and the prompt carries) each round. */
export function plannerContext(input: PlannerInput): string {
  return canonicalJson({
    epoch: input.epoch,
    lanes: lanesOf(input.laneCount),
    objective: input.objective,
    editable_paths: input.editablePaths,
    champion: input.champion,
    families: input.families,
    evidence: input.evidence,
    queue: input.queue ?? { up_next: [], proposed: [], in_progress: [], tried: [] },
    // The target the queue is kept at (goal 081): a target that drives ideas, not a cap.
    ...(queueTargetContext(input) ? { queue_target: queueTargetContext(input) } : {}),
    ...(input.laneState ? { lane_state: input.laneState } : {}),
    // An old rule in words is marked legacy: code does not keep it until it is converted, and
    // to_convert lists those this round converts (goal 066).
    directives: input.directives.map((d) => ({
      id: d.id,
      ...d.body,
      ...(isLegacyRule(d.body) ? { legacy: true } : {}),
    })),
    ...(input.directions ? { directions: input.directions } : {}),
    ...(toDesign(input).length ? { to_design: toDesign(input) } : {}),
    ...(toConvert(input).length ? { to_convert: toConvert(input) } : {}),
    lane_bests: input.laneBests,
    // The campaign's brief from its author, whole (goal 078): starting points, not rules.
    ...(input.campaignBrief ? { campaign_brief: input.campaignBrief } : {}),
    // Each message with the directions it names exactly, as :name:.
    ...(input.ownerMessages?.length
      ? {
          owner_messages: input.ownerMessages.map((m) => ({
            ...m,
            directions: directionTokens(m.text),
          })),
        }
      : {}),
    ...(input.goalReport ? { goal_report: input.goalReport } : {}),
    // The agents' own words and the owner's picks from past research: data, never instructions.
    ...(input.notes?.length ? { field_notes: { note: NOTES_ARE_DATA, notes: input.notes } } : {}),
    ...(input.briefing?.length ? { background: briefingData(input.briefing) } : {}),
    ...(input.pastResearch ? { past_research: input.pastResearch } : {}),
  });
}
