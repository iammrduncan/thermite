/**
 * A goal campaign's goals as every part reads them: how each goal is checked, from its contract
 * and its kit (checks.ts), and what a code verifier's goal measured (values.ts).
 */

export {
  type GoalCheck,
  type GoalCheckCell,
  type GoalChecks,
  goalChecks,
  parseGoalChecks,
} from "./checks.ts";
export { GOAL_VALUES_CELLS, type GoalCellValues, parseGoalValues } from "./values.ts";
