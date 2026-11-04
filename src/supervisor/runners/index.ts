/**
 * A rig's core and its runners on the bus (goal 206): the core's supervisor carries its harness's
 * asks of its runners (carry.ts), and a runner's answers them from its harness (answer.ts),
 * which is all a runner's supervisor does (runner.ts).
 */

export { answerCoreAsks } from "./answer.ts";
export { carryRunnerAsks } from "./carry.ts";
export { startRunnerSupervisor } from "./runner.ts";
