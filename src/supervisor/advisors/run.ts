import type { z } from "zod";
import { messageText, type Prompt } from "../../agents/prompt.ts";
import type { AdvisorCall, AdvisorResult } from "./call.ts";
import { runClaudeCode, runCli, runCliHarness, runPi } from "./runtimes/index.ts";

/**
 * Runs one advisor call: a role prompt, the tools, and an output schema. The model answers by
 * calling `answer` with an object that must match the schema. In Pi a refused answer is asked
 * again with its problems, until the same problems come back SAME_REFUSALS times running.
 */
export async function runAdvisor<S extends z.ZodType>(
  call: AdvisorCall<S>,
): Promise<AdvisorResult<z.infer<S>>> {
  // Each prompt its runtime renders and sends, its later turns too, for the harness to keep
  // (goal 166).
  const sent: Prompt[] = [];
  const input: AdvisorCall<S> = {
    ...call,
    prompt: (f) => {
      const p = call.prompt(f);
      sent.push(p);
      return p;
    },
    later: (p) => sent.push(p),
  };
  const r = await dispatch(input);
  return sent.length ? { ...r, sent } : r;
}

function dispatch<S extends z.ZodType>(input: AdvisorCall<S>): Promise<AdvisorResult<z.infer<S>>> {
  const rt = input.runtime;
  if (rt.runtime === "cli")
    return runCli(
      rt,
      messageText(
        input.prompt({ program: "cli", mcpServers: [], answerSchema: input.answerSchema }),
      ),
      input.schema,
    );
  if (rt.runtime === "claude-code") return runClaudeCode(rt, input);
  if (rt.runtime === "opencode" || rt.runtime === "codex") return runCliHarness(rt, input);
  return runPi(rt, input);
}
