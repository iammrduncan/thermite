import { randomUUID } from "node:crypto";
import type { OnceKeeping } from "../../../agents/compaction/index.ts";
import { type McpCaller, mcpAgentTools } from "../../../agents/mcp/index.ts";
import { type ModelConfig, withAgentsContext } from "../../../agents/model/index.ts";
import type { Prompt } from "../../../agents/prompt.ts";
import { kbAgentTools } from "../../../agents/tools/index.ts";
import { type Harness, programForApi } from "../../../core/agents.ts";
import type { Contract } from "../../../core/contract.ts";
import type { NoteInput } from "../../../core/journal.ts";
import type { CallUsage } from "../../../core/usage.ts";
import { keepPrompt } from "../../prompts.ts";
import { routeOf } from "../../usage.ts";
import type { CliHarness } from "../cli/index.ts";
import { PLANNER } from "../coordinator.ts";
import type { Ask, PlannerCompaction, PlannerMcp, PlannerPast } from "../planner/index.ts";
import { isCliProgram, programOf } from "../programs.ts";
import { pastResearch } from "./briefs.ts";
import { modelNow, type PlannerCallOptions, type SchedulerContext } from "./context.ts";

/**
 * How the scheduler calls the planner, for the hill climb's and goal campaign's plan (plan.ts)
 * and the research plan (research/plan.ts): its route, where its compactions go, and its notes.
 */

/**
 * The harness a planner call runs in. With a model of its own (`own`), the harness its route names
 * (goal 073): Pi, OpenCode, Claude Code or Codex. Following the workers' route: the program they
 * run in when the planner follows them there (programs.ts: Codex), else Pi. A Claude subscription
 * runs only in Claude Code, and OpenCode's own models only in OpenCode, whatever the route says.
 */
export function plannerHarness(m: ModelConfig | undefined, own: boolean): Harness {
  if (!m) return "pi";
  const only = programForApi(m.api);
  if (only) return only;
  const program = programOf(m);
  return own || program.plannerFollows ? program.id : "pi";
}

/**
 * How the planner is called this round (goals 068, 070, 073, 075): its model, the harness it
 * runs in (`ask` when not Pi), the MCP servers the run's kit gives it, where its model calls are
 * recorded, where its prompts are kept, and the run's past research it may read. The hill climb's and goal campaign's plan
 * and the research plan share it.
 */
export async function plannerRoute(
  sched: SchedulerContext,
  run: string,
  contract: Contract,
  n: number,
): Promise<{
  m: ModelConfig | undefined;
  ask: Ask | undefined;
  mcp: PlannerMcp | undefined;
  usage: ((u: CallUsage) => void) | undefined;
  past: PlannerPast | undefined;
  pastLine: string | undefined;
  /** Keeps each try's prompt (goal 166). */
  sent: (p: Prompt) => void;
}> {
  // The planner's own model when control gave it one; else the workers'. A campaign's own
  // context settings apply to it too: the lower window, and the campaign's point (goal 070).
  const own = sched.o.plannerModel?.();
  const m = withAgentsContext(own ?? modelNow(sched), contract.agents_context);
  // With a model of its own, the planner runs in the harness its route names (goal 073).
  // Following the workers: OpenCode's own models are reached only through OpenCode, a route
  // whose workers run in Codex plans in Codex too, and every other provider plans in Pi.
  // A Claude subscription, only through Claude Code: without it the planner refuses the route.
  // The MCP servers the run's kit gives the planner (goal 068), through the gateway: Pi's
  // tools call it in this process; another harness gets a credential made for the call.
  const caller: McpCaller = { run, kind: "planner", source: "planner" };
  const mcpServers = sched.o.service.mcp.given(run, "planner").map((g) => g.name);
  const via = plannerHarness(m, own !== undefined);
  // Each of the round's model calls, in the run's records (goal 075).
  const usage = m
    ? sched.o.service.usage.recorder(
        run,
        { round: `epoch ${n}`, agent: "planner" },
        routeOf(m, via),
      )
    : undefined;
  // A call through a program of its own (OpenCode, Claude Code or Codex) keeps its conversation
  // before each of its compactions in the run's research folder, as a Pi call does (goal 070).
  const keeping = isCliProgram(via) ? cliPlannerCompaction(sched, run, via) : undefined;
  const withMcp = (o: Parameters<Ask>[2]): PlannerCallOptions => ({
    ...(o?.read !== undefined ? { read: o.read } : {}),
    ...(o?.mcp?.length || o?.kb
      ? { mcp: { auth: sched.o.service.mintMcpToken(caller), servers: o.mcp ?? [], kb: o.kb } }
      : {}),
    usage,
    ...(keeping ? { compaction: keeping() } : {}),
  });
  const through = sched.o.ask;
  const ask: Ask | undefined =
    isCliProgram(via) && m && through
      ? Object.assign(
          (prompt: string, sig?: AbortSignal, o?: Parameters<Ask>[2]) =>
            through(via, m, prompt, sig, withMcp(o)),
          { program: via },
        )
      : undefined;
  // Thermite's knowledge base (goal 175): in Pi its tools run here, for the planner's slot;
  // another program reaches them at the gateway, with the call's credential.
  const kbTools = sched.o.service.kbTools;
  const writes = kbTools.writes(run, "planner");
  const kb = {
    writes,
    tools: ask ? [] : kbAgentTools(kbTools.callFor({ run, slot: "planner" }), writes),
  };
  const mcp: PlannerMcp = {
    servers: mcpServers,
    tools:
      ask || !mcpServers.length
        ? []
        : mcpAgentTools((await sched.o.service.mcp.tools(caller)).tools, (s, t, a) =>
            sched.o.service.mcp.call(caller, s, t, a),
          ),
    kb,
  };
  // The run's past research, read only: kb_search searches it in every program; through
  // OpenCode, Claude Code or Codex, the planner may also read the run's knowledge/ files.
  const knowledge = sched.o.service.knowledge;
  const pastLine = pastResearch(sched, run, ask ? "files" : "tool");
  const past: PlannerPast | undefined = pastLine ? { dir: knowledge.dir(run) } : undefined;
  // Each try's prompt, kept whole in the ledger (goal 166).
  const sent = (p: Prompt) => keepPrompt(sched.o.service.ledger, run, p, { call: `epoch ${n}` });
  return { m, ask, mcp, usage, past, pastLine, sent };
}

/** The planner's field notes, recorded as the planner's; a problem is a line in its live view. */
export function plannerNotes(
  sched: SchedulerContext,
  run: string,
  notes: NoteInput[] | undefined,
): void {
  if (!notes?.length) return;
  const r = sched.o.service.journal.writeAll(run, notes, {
    by: PLANNER,
    actor: PLANNER,
    source: "planner",
  });
  if (r.problems.length)
    sched.o.service.live.append({
      source: "planner",
      kind: "status",
      text: `field notes: ${r.problems.join("; ")}`,
      run,
    });
}

/**
 * Where a planner call's compactions go in Pi (goal 070): the run's research folder keeps each
 * conversation, numbered within the call, and each is recorded as a worker's is.
 */
export function plannerCompaction(
  sched: SchedulerContext,
  run: string,
): PlannerCompaction | undefined {
  const store = sched.o.service.compactions;
  if (!store) return undefined;
  const of = {
    run,
    lane: "planner",
    trial: null,
    who: `planner-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    source: "planner",
  };
  let n = 0;
  return {
    keep: (_n, markdown) => store.keep(of, ++n, markdown),
    done: (r) =>
      store.record(of, {
        number: n,
        tokensBefore: r.tokensBefore,
        tokensAfter: r.tokensAfter,
        how: r.how,
        harness: "pi",
        summary: r.summary,
        error: r.error,
        kept: r.path !== undefined,
      }),
  };
}

/**
 * Where a planner call through OpenCode, Claude Code or Codex keeps its conversation before each
 * of that program's own compactions (goal 070): one place for each call (a plan may take two),
 * in the run's research folder, named as a Pi call's are. The planner is not told it may read
 * the file: its summary names it, for the owner.
 */
function cliPlannerCompaction(
  sched: SchedulerContext,
  run: string,
  harness: CliHarness,
): (() => OnceKeeping) | undefined {
  const store = sched.o.service.compactions;
  if (!store) return undefined;
  return () => {
    const of = {
      run,
      lane: "planner",
      trial: null,
      who: `planner-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      source: "planner",
    };
    return {
      keptAt: store.keptAt(of, false),
      title: "The planner",
      compacted: (c) => store.fromHarness(of, harness, c),
    };
  };
}
