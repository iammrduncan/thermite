/**
 * A rig over several machines on the bus (goal 205): the leader's supervisor carries its harness's
 * asks of its followers (carry.ts), and a follower's answers them from its harness (answer.ts),
 * which is all a follower's supervisor does (follower.ts).
 */

export { answerLeaderAsks } from "./answer.ts";
export { carryFollowerAsks } from "./carry.ts";
export { startFollowerSupervisor } from "./follower.ts";
