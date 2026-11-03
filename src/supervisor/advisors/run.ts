import type { z } from "zod";
import { messageText } from "../../agents/prompt.ts";
import { advisorLiveSource } from "../../core/live.ts";
import type { AdvisorCall, AdvisorResult, SentPrompt } from "./call.ts";
import { runPi } from "./pi/index.ts";
import { runClaudeCode, runCli, runCliHarness } from "./runtimes/index.ts";
import { runInPiView, runInTerminal, runsInTerminal } from "./terminal/index.ts";

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
  const sent: SentPrompt[] = [];
  const input: AdvisorCall<S> = {
    ...call,
    prompt: (f) => {
      const p = call.prompt(f);
      sent.push(p);
      return p;
    },
    later: (p) => sent.push(p),
  };
  // A headless call's tool calls on Live, under the advisor's own source (goal 188); a call in
  // its terminal shows them from its transcript. Either way, a line when it starts and one when
  // it ends, with its answer or why it has none: its chip shows from its start.
  const live = call.live;
  const source = advisorLiveSource(call.runtime.name);
  const status = (text: string) =>
    live?.line({ source, kind: "status", text: `${call.runtime.name} ${text}`, run: live.run });
  if (live && !call.terminal)
    input.tools = {
      ...input.tools,
      said: (tool, args) =>
        live.line({ source, kind: "tool", text: toolLine(tool, args), run: live.run }),
    };
  const started = Date.now();
  status(`starts, ${whereItRuns(call)}`);
  const r = await dispatch(input);
  const took = minutes(Date.now() - started);
  status(
    r.output !== undefined
      ? `answered after ${took}`
      : `has no answer after ${took}: ${(r.error ?? "no output").slice(0, 400)}`,
  );
  return sent.length ? { ...r, sent } : r;
}

const PROGRAMS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  openai: "Pi",
};

/** Where a call runs, as its first line on Live says it. */
function whereItRuns(call: AdvisorCall<z.ZodType>): string {
  const rt = call.runtime;
  if (rt.runtime === "cli") return "as its command";
  const program = PROGRAMS[rt.runtime] ?? rt.runtime;
  if (call.terminal && rt.runtime === "openai") return "in its Pi view";
  if (call.terminal && runsInTerminal(rt)) return `in ${program}'s own terminal`;
  return `headless in ${program}`;
}

const minutes = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

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
  // On a rig whose agents run in their own terminal (goal 169): Pi in its Pi view, the other
  // programs in their own terminal UI.
  if (input.terminal && rt.runtime === "openai") return runInPiView(rt, input, input.terminal);
  if (input.terminal && runsInTerminal(rt)) return runInTerminal(rt, input, input.terminal);
  if (rt.runtime === "claude-code") return runClaudeCode(rt, input);
  if (rt.runtime === "opencode" || rt.runtime === "codex") return runCliHarness(rt, input);
  return runPi(rt, input);
}

/** A tool call as Live reads it: its name, then its arguments as JSON, cut to a line's room. */
const toolLine = (tool: string, args: unknown) => {
  const json = JSON.stringify(args ?? {});
  return `${tool} ${json.length > 2000 ? `${json.slice(0, 1990)}…` : json}`;
};
