/**
 * A research run in the scheduler: its clock (tick.ts), its rounds' plan and tasks (plan.ts,
 * tasks.ts), a lane's research trial (trial.ts), and its end (end.ts).
 */

export { finishClosedResearch, finishEndedResearch } from "./end.ts";
export { researchTick } from "./tick.ts";
