/** What the planner's tests share: a campaign's input to the planner, and a model route. */

import type { PlannerInput } from "../../../../src/harness/agents/planner/index.ts";

/** A hill climb's second round, with two lanes and two live directions. */
export const base: PlannerInput = {
  run: "i",
  epoch: 2,
  laneCount: 2,
  objective: "increase x",
  editablePaths: ["src/**"],
  champion: { seq: 1, gain: 0 },
  families: [
    {
      id: "tiling",
      description: "tile loops",
      status: "live",
      attempts: 3,
      verdicts: {},
      best_delta: 0.1,
    },
    {
      id: "unroll",
      description: "unroll loops",
      status: "live",
      attempts: 1,
      verdicts: {},
      best_delta: null,
    },
  ],
  evidence: [],
  directives: [],
  laneBests: { "lane-1": null, "lane-2": null },
};

/** A model route to a fake model at `url`. */
export const model = (url: string) => ({
  baseUrl: url,
  model: "m",
  apiKey: "k",
  contextWindow: 32000,
  maxTokens: 2000,
});
