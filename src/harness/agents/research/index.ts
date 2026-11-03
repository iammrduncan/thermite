/**
 * A research run's agents in the harness: its planner, one stateless model call per round
 * (planner.ts), and a research trial in Pi (worker.ts).
 */

export {
  plannerHypotheses,
  planResearch,
  RESEARCH_PLAN_SPEC,
  type ResearchPlannerInput,
  type ResearchPlanResult,
} from "./planner.ts";
export { piResearchPrompt, type ResearchTrialSpec, runResearchTrial } from "./worker.ts";
