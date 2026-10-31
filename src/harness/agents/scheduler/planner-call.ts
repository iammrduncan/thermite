import { randomUUID } from "node:crypto";
import type { OnceKeeping } from "../../../agents/compaction/index.ts";
import { type McpCaller, mcpAgentTools } from "../../../agents/mcp/index.ts";
import { type ModelConfig, withAgentsContext } from "../../../agents/model/index.ts";
import type { Prompt } from "../../../agents/prompt.ts";
import { renderPlannerTurn, renderResearchPlannerTurn } from "../../../agents/roles/index.ts";
import { kbAgentTools } from "../../../agents/tools/index.ts";
import { type Harness, programForApi } from "../../../core/agents.ts";
import type { PlannerAnswer } from "../../../core/api/harness/planner.ts";
import type { Contract } from "../../../core/contract.ts";
import type { NoteInput } from "../../../core/journal.ts";
import { plannerCallId } from "../../../core/terminal-input.ts";
import type { CallUsage } from "../../../core/usage.ts";
import type { CompactionOf } from "../../compactions.ts";
import { messageText } from "../../messages.ts";
import { keepPrompt } from "../../prompts.ts";
import { routeOf } from "../../usage.ts";
import type { CliHarness, TerminalCallLink } from "../cli/index.ts";
import { PLANNER } from "../coordinator.ts";
import type { MessageInbox } from "../live-session.ts";
import type {
  Ask,
  PlannerCompaction,
  PlannerMcp,
  PlannerPast,
  PlannerView,
} from "../planner/index.ts";
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
  /**
   * Its role, for its later turns in its own terminal, and the input that holds the owner's
   * messages its prompt gave: one that goes in inside its turn joins them (goal 169).
   */
  call: { role: "planner" | "research-planner"; owner: { id: number; text: string }[] },
): Promise<{
  m: ModelConfig | undefined;
  ask: Ask | undefined;
  /** In Pi, in its own process and its Pi view, on a rig whose agents run in their terminal. */
  view: PlannerView | undefined;
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
  // On a rig whose agents run in their own terminal, the call runs in its program's (goal 169),
  // with a credential bound to it for the proxy, the gateway and the owner's messages.
  const inTerminal = sched.o.service.settings.get().program_mode === "terminal";
  const withMcp = (o: Parameters<Ask>[2], terminal?: TerminalCallLink): PlannerCallOptions => ({
    ...(o?.read !== undefined ? { read: o.read } : {}),
    ...(o?.mcp?.length || o?.kb
      ? {
          mcp: {
            auth: terminal?.auth ?? sched.o.service.mintMcpToken(caller),
            servers: o.mcp ?? [],
            kb: o.kb,
          },
        }
      : {}),
    usage,
    ...(keeping ? { compaction: keeping() } : {}),
    ...(terminal ? { terminal } : {}),
  });
  const through = sched.o.ask;
  const ask: Ask | undefined =
    isCliProgram(via) && m && through
      ? Object.assign(
          async (prompt: string, sig?: AbortSignal, o?: Parameters<Ask>[2]) => {
            if (!inTerminal) return through(via, m, prompt, sig, withMcp(o));
            const auth = sched.o.service.mintCallToken({ id: callId, caller, model: m });
            try {
              return await through(via, m, prompt, sig, withMcp(o, terminalLink(auth)));
            } finally {
              sched.o.service.endCall(auth);
            }
          },
          { program: via },
        )
      : undefined;
  // Its console's and screens' id: both tries of a round take it (goal 169).
  const callId = plannerCallId(run, n);
  const side = () =>
    plannerTerminal(sched, { run, n, id: callId, role: call.role, via, owner: call.owner });
  const terminalLink = (auth: string): TerminalCallLink => ({ ...side(), auth });
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
  // In Pi on a rig whose agents run in their own terminal, each try runs in a process of its own,
  // in its Pi view (goal 169), which reaches the harness with a credential bound to the call: its
  // tools, compactions, usage, later turns, lines and the owner's messages, and its answer.
  const inView = sched.o.planInView;
  const view: PlannerView | undefined =
    inTerminal && via === "pi" && m && inView
      ? async (prompt, spec, signal) => {
          let answer: PlannerAnswer | undefined;
          const s = side();
          const store = sched.o.service.compactions;
          const auth = sched.o.service.mintCallToken({
            id: callId,
            caller,
            model: m,
            own: {
              run,
              call: `epoch ${n}`,
              live: s.live,
              messages: s.messages,
              usage,
              compaction: store ? plannerOf(run) : undefined,
              answer: (a) => {
                answer ??= a;
              },
            },
          });
          try {
            return await inView(
              {
                model: m,
                link: { ...s, auth },
                mcpServers: mcp.tools.length ? mcpServers : [],
                kbWrites: writes,
                heading: `Thermite's view of the ${call.role === "planner" ? "planner" : "research planner"} in Pi · run ${run} · round ${n} · ${m.model}`,
                answer: () => answer,
              },
              prompt,
              spec,
              signal,
            );
          } finally {
            sched.o.service.endCall(auth);
          }
        }
      : undefined;
  return { m, ask, view, mcp, usage, past, pastLine, sent };
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
 * A planner call's place for its compactions (goal 070): in the run's research folder, named for
 * the call, recorded as the planner's.
 */
function plannerOf(run: string): CompactionOf {
  return {
    run,
    lane: "planner",
    trial: null,
    who: `planner-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    source: "planner",
  };
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
  const of = plannerOf(run);
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
    const of = plannerOf(run);
    return {
      keptAt: store.keptAt(of, false),
      title: "The planner",
      compacted: (c) => store.fromHarness(of, harness, c),
    };
  };
}

/**
 * What a planner's call in its program's own terminal, or in its Pi view, takes from the harness
 * (goal 169), but its credential: its console and screens under its id, its live lines, the
 * owner's messages that go in inside its turn (each read once its program has it, and joined to
 * the messages its prompt gave, so a rule it asks for names it), its later turns kept, and a wait
 * for its usage window recorded as the run's.
 */
function plannerTerminal(
  sched: SchedulerContext,
  c: {
    run: string;
    n: number;
    id: string;
    role: "planner" | "research-planner";
    /** The program it runs in, as its prompt names it. */
    via: string;
    owner: { id: number; text: string }[];
  },
): Omit<TerminalCallLink, "auth"> & { messages: MessageInbox } {
  const svc = sched.o.service;
  const run = c.run;
  const given = new Set(c.owner.map((m) => m.id));
  const render = c.role === "planner" ? renderPlannerTurn : renderResearchPlannerTurn;
  return {
    id: c.id,
    title: "The planner",
    messages: {
      waiting: () =>
        svc.messages
          .waitingForPlanner(run)
          .filter((m) => !given.has(m.id))
          .map((m) => ({ id: m.id, text: messageText(m) })),
      given: (ids, how) => {
        const now = svc.messages.waitingForPlanner(run).filter((m) => ids.includes(m.id));
        for (const m of now) {
          given.add(m.id);
          c.owner.push({ id: m.id, text: messageText(m) });
        }
        svc.messages.read(
          now.map((m) => m.id),
          "planner",
          { round: c.n, how },
        );
      },
    },
    turn: (t, turn) => render({ ...t, program: c.via, turn }),
    sent: (p) => keepPrompt(svc.ledger, run, p, { call: `epoch ${c.n}` }),
    live: (entries) => {
      for (const e of entries)
        svc.live.append({ source: "planner", kind: e.kind, text: e.text, run });
    },
    console: (term, piView) =>
      term
        ? svc.consoles.setCall(c.id, { run, lane: "planner", source: "planner" }, term, piView)
        : svc.consoles.ended(c.id),
    inTurn: (d) => svc.inTurn(c.id, d),
    providerAnswer: (since) => svc.providerAnswerSince(c.id, since),
    waiting: (w) => svc.trialWait({ id: c.id, run, lane: "planner", source: "planner" }, w),
    draining: () => svc.draining !== undefined,
  };
}
