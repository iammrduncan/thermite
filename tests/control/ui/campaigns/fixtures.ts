import type { RigView, RunView } from "../../../../src/control/views/index.ts";

/** Runs and a rig for the Campaigns pages' words, as control's views give them. */

export const rig = { id: "rig-a" } as unknown as RigView;

/** A run for the status words (goal 099): its state, mode, start and its goals' end. */
export const statusRun = (
  id: string,
  status: string,
  created_at: string,
  more: Partial<RunView> = {},
): RunView =>
  ({
    id,
    campaign: "quality",
    status,
    mode: "goal",
    created_at,
    goals_complete: false,
    audits: [],
    pending_promotions: [],
    conclusions: [],
    reviews: [],
    attempts: [],
    timeline: [],
    champion: [],
    goals: [],
    research: null,
    ...more,
  }) as unknown as RunView;
