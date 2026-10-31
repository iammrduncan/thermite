import type { HarnessClient } from "../../../common/api/harness.ts";
import { ADVISOR_MESSAGES_WAITING } from "../../../core/api/harness/advisors.ts";
import { AdvisorRoleRunner, advisorRunner } from "../../advisor-runs/index.ts";
import type { AdvisorTerminals } from "./call.ts";
import { AdvisorConsoles } from "./consoles.ts";

/**
 * The supervisor's terminals for its advisors (goal 169), as its start makes them: its own consoles,
 * and, where an advisors' runner was started with it, what an advisor's call in its terminal takes:
 * the runner, as the runner the agent runtimes share, and the owner's messages from the harness.
 * Without a runner (development, tests), the advisors run headless, whatever the rig's setting.
 */
export function advisorTerminals(o: { harness: HarnessClient; live: AdvisorTerminals["live"] }): {
  consoles: AdvisorConsoles;
  terminals: AdvisorTerminals | undefined;
} {
  const consoles = new AdvisorConsoles();
  const runner = advisorRunner();
  if (!runner) return { consoles, terminals: undefined };
  return {
    consoles,
    terminals: {
      runner: new AdvisorRoleRunner(runner),
      root: runner.root,
      consoles,
      waiting: async (run, role) =>
        (await o.harness.call(ADVISOR_MESSAGES_WAITING, { query: { run, role } })).messages,
      live: o.live,
    },
  };
}
