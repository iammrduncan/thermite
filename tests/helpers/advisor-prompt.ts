import { section } from "../../src/agents/prompt.ts";
import { type AdvisorFrame, advisorPromptOf } from "../../src/agents/roles/shared.ts";

/**
 * An advisor's prompt for a test of the advisors' runtimes: a system text and a package, framed
 * for the call's program as every advisor's prompt is (advisorPromptOf).
 */
export const testPrompt = (system: string, pkg: string) => (f: AdvisorFrame) =>
  advisorPromptOf(
    "test",
    [section("system", "role", system)],
    [section("package", "package", pkg)],
    f,
  );
