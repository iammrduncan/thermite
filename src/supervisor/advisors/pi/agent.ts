import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, TSchema } from "@earendil-works/pi-ai";
import type { z } from "zod";
import { TERMINAL_WAIT_MAX_MS } from "../../../agents/cli/index.ts";
import { Compactor, summarizer } from "../../../agents/compaction/index.ts";
import { lastAssistant, linkSession, type SessionLink } from "../../../agents/live-session.ts";
import type { McpForAgent } from "../../../agents/mcp/index.ts";
import {
  buildModel,
  type ModelConfig,
  PiMeter,
  retryAtFrom,
  usageLimitRetry,
} from "../../../agents/model/index.ts";
import { type RoleView, swappableTools, type ViewWait } from "../../../agents/pi-view/index.ts";
import { messageText, type Prompt, systemText } from "../../../agents/prompt.ts";
import { renderAdvisorTurn, renderCompacted } from "../../../agents/roles/index.ts";
import { errorText } from "../../../common/errors.ts";
import type { CallUsage } from "../../../core/usage.ts";
import type { AdvisorCompaction } from "../call.ts";

/**
 * One advisor's call in Pi (goal 166's roles, goal 169's views): one agent with its read-only
 * tools and `answer`, compacted near its window. The supervisor runs it in its own process
 * (headless.ts); on a rig whose agents run in their own terminal, the advisor's own process runs
 * it in its Pi view (main.ts), where the owner's messages come in before its next model call and
 * the owner's console reaches it through its levers. A refused answer is asked again with its
 * problems, until the same problems come back SAME_REFUSALS times running.
 */

/**
 * A Pi advisor whose answer is refused for the same problems this many times running is stuck:
 * its call ends with those problems as its error, and fails as a call with no answer does. An
 * answer that changes what is wrong with it is asked again with no limit.
 */
const SAME_REFUSALS = 3;

/** How often a wait for the provider looks whether its call was stopped meanwhile. */
const WAIT_STEP_MS = 1_000;

/** A tool's answer as Pi takes it: one text. */
export const toolAnswer = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value).slice(0, 30_000),
    },
  ],
  details: {},
});

/** What became of an answer: taken, or refused with its problems and the words its tool gives. */
export type AnswerCheck =
  | { ok: true; output: unknown }
  | { ok: false; problems: string; words: string };

/**
 * An answer checked as every Pi advisor's is: against the role's schema, then the call's own check
 * (`accept`: the final writer's), each refusal in words the advisor can act on.
 */
export async function checkAnswer<S extends z.ZodType>(
  schema: S,
  accept: ((output: z.infer<S>) => Promise<string | undefined>) | undefined,
  answer: unknown,
): Promise<AnswerCheck> {
  const parsed = schema.safeParse(answer);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return {
      ok: false,
      problems,
      words: `refused: ${problems}. Call answer again with a corrected answer.`,
    };
  }
  const refused = accept ? await accept(parsed.data) : undefined;
  if (refused)
    return {
      ok: false,
      problems: refused,
      words: `refused: ${refused}. Fix each problem, then call answer again.`,
    };
  return { ok: true, output: parsed.data };
}

/** What one Pi advisor's call takes, wherever it runs. */
export interface PiAdvisorCall {
  /** The advisor's name: its compactions' records and title. */
  name: string;
  cfg: ModelConfig;
  sent: Prompt;
  /** Its tools but `answer`, with the MCP servers' tools where they go among them. */
  tools(mcp: AgentTool[]): AgentTool[];
  /** The MCP tools the run's kit gives the advisors, and how a tool is made of each. */
  mcp?: { listed: McpForAgent; tools(m: McpForAgent): AgentTool[] } | undefined;
  answerSchema: TSchema;
  /** Checks an answer: taken (the call ends), or refused with its problems. */
  check(answer: unknown): Promise<AnswerCheck>;
  maxTurns?: number | undefined;
  timeoutS?: number | undefined;
  /** Keeps the conversation before compaction `n`: where, in words. Throws when it has no place. */
  keep(n: number, markdown: string): Promise<string>;
  /** A compaction done, for its record. */
  compacted(c: AdvisorCompaction): void;
  /** Keeps each later turn as it is sent (goal 166). */
  later?: ((p: Prompt) => void) | undefined;
  usage(u: CallUsage): void;
  /**
   * In its Pi view (goal 169): the view's console, given the call's levers, and the session's link,
   * which sends its lines to Live and brings the owner's messages in before its next model call.
   */
  view?: RoleView | undefined;
  link?: Pick<SessionLink, "live" | "messages" | "read"> | undefined;
  /**
   * In its Pi view: a model call refused for a usage limit whose reset its provider's words give
   * (or a full ChatGPT plan's), less than a day away, is waited out, told here, and the call goes
   * on in the same conversation (the owner's decision of 2026-10-27). None: the call ends at it.
   */
  waitOut?: ((w: ViewWait) => void) | undefined;
}

/** How a Pi advisor's call ended: answered or not, why not, its tokens and its compactions. */
export interface PiAdvisorEnd {
  answered: boolean;
  error?: string | undefined;
  tokensIn: number;
  tokensOut: number;
  compactions: AdvisorCompaction[];
}

export async function piAdvisor(o: PiAdvisorCall): Promise<PiAdvisorEnd> {
  const end: PiAdvisorEnd = { answered: false, tokensIn: 0, tokensOut: 0, compactions: [] };
  const { cfg, sent } = o;
  let problems = "";
  const answer = {
    name: "answer",
    label: "answer",
    description: "Give your final answer. Call it once.",
    parameters: o.answerSchema,
    execute: async (_id: string, params: unknown) => {
      const r = await o.check(params);
      if (!r.ok) {
        problems = r.problems;
        return toolAnswer(r.words);
      }
      end.answered = true;
      return { ...toolAnswer("recorded"), terminate: true };
    },
  } as AgentTool;
  const toolsWith = (mcp: AgentTool[]) => [...o.tools(mcp), answer];
  const { models, model, thinkingLevel } = buildModel(cfg);
  const meter = new PiMeter(o.usage);
  const agent = new Agent({
    // The effort chosen for this advisor; without it the agent would never think.
    initialState: {
      systemPrompt: systemText(sent),
      model,
      thinkingLevel,
      tools: toolsWith(o.mcp ? o.mcp.tools(o.mcp.listed) : []),
    },
    streamFn: meter.streamFn(models),
    toolExecution: "sequential",
  });
  meter.watch(agent);
  // Near the window the call's conversation is compacted and the advisor goes on (goal 070), as
  // the planner's is: its tools' results (past research, MCP servers) can fill the window. It has
  // no file tool, so its summary names where the supervisor keeps the conversation.
  let tooBig: string | undefined;
  // Its later turns (goal 166), numbered after its first message.
  let said = 0;
  const compactor = new Compactor({
    window: cfg.contextWindow,
    at: cfg.compactAt,
    convert: (messages: AgentMessage[]) =>
      messages.filter(
        (m) =>
          m.role === "system" ||
          m.role === "user" ||
          m.role === "assistant" ||
          m.role === "toolResult",
      ) as Message[],
    summarize: summarizer(cfg, meter),
    keep: async (n, markdown) => ({ path: await o.keep(n, markdown) }),
    done: async (r) => {
      const c: AdvisorCompaction = {
        advisor: o.name,
        number: r.number,
        tokens_before: r.tokensBefore,
        tokens_after: r.tokensAfter,
        how: r.how,
        kept: r.path ?? null,
        ...(r.error ? { error: r.error } : {}),
      };
      end.compactions.push(c);
      o.compacted(c);
    },
    stop: (reason) => {
      tooBig = reason;
      stopped = true;
      agent.abort();
    },
    title: `Advisor ${o.name}`,
    // What it goes on from, in its role's words (goal 166).
    after: (c) => renderCompacted({ role: sent.role, turn: ++said, ...c }),
    sent: o.later,
  });
  agent.prepareRequest = compactor.hook(agent);
  let turns = 0;
  let stopped = false;
  // No time or turn limit on a call unless the advisors file sets one (goal 079).
  const timeout = o.timeoutS;
  const deadline =
    timeout !== undefined
      ? setTimeout(() => {
          end.error = `timed out after ${timeout} s`;
          stopped = true;
          agent.abort();
        }, timeout * 1000)
      : undefined;
  // The problems of the answer's last refusal, and how many turns running they came back.
  let refusal = "";
  let same = 0;
  agent.subscribe((event) => {
    if (event.type === "turn_end") {
      turns++;
      const usage = (event.message as { usage?: { input?: number; output?: number } }).usage;
      end.tokensIn += usage?.input ?? 0;
      end.tokensOut += usage?.output ?? 0;
      if (o.maxTurns !== undefined && turns >= o.maxTurns && !end.answered) agent.abort();
      // A refused answer: Pi's own check of the tool's schema (its words, without the arguments
      // it quotes back), or ours above (problems). The same problems SAME_REFUSALS turns running
      // end the call.
      const answers = event.toolResults.filter((m) => m.toolName === "answer");
      if (!answers.length || end.answered) return;
      for (const m of answers.filter((a) => a.isError))
        problems = (
          m.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("")
            .split("\n\nReceived arguments")[0] ?? ""
        ).trim();
      same = problems === refusal ? same + 1 : 1;
      refusal = problems;
      if (same >= SAME_REFUSALS) {
        end.error = `the answer was refused ${same} times running for the same problems: ${problems}`;
        agent.abort();
      }
    }
  });
  attachView(o, agent, {
    toolsWith,
    compact: () => compactor.force("asked"),
    compactions: () => compactor.count,
    turn: () => ++said,
    closed: () => (end.answered ? "the advisor has answered: nothing more goes in" : undefined),
  });
  try {
    // Its first message, then what it goes on from after each usage limit it waited out.
    let next: Prompt = sent;
    for (;;) {
      await agent.prompt(messageText(next));
      const w = end.answered || stopped || !o.waitOut ? undefined : limitOf(agent);
      if (!w) break;
      o.waitOut?.(w);
      while (!stopped && Date.now() < Date.parse(w.until))
        await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
      if (stopped) break;
      // In its role's words, as an advisor in its program's own terminal goes on.
      next = renderAdvisorTurn(sent.role, {
        program: "pi",
        turn: ++said,
        kind: "failed",
        words: w.words,
      });
      o.later?.(next);
    }
  } catch (err) {
    end.error ??= errorText(err);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
  if (tooBig && !end.answered) end.error ??= tooBig;
  if (!end.answered && !end.error && o.view?.interrupted())
    end.error = "the owner stopped its reply from its Pi view";
  if (!end.answered && !end.error) end.error = problems || "no answer";
  return end;
}

/**
 * The usage limit its last model call met, when its provider said when it resets (or a ChatGPT
 * plan's, which says none: CHATGPT_LIMIT_WAIT_MS), less than a day away; else none.
 */
function limitOf(agent: Agent): ViewWait | undefined {
  const last = lastAssistant(agent);
  if (last?.stopReason !== "error") return undefined;
  const words = last.errorMessage ?? "";
  const until = usageLimitRetry(words) ?? retryAtFrom(words);
  if (!until || Date.parse(until) - Date.now() > TERMINAL_WAIT_MAX_MS) return undefined;
  return { until, kind: "rate_limit", words: words.slice(0, 1000) };
}

/**
 * In its Pi view (goal 169): the owner's messages come in before its next model call, read once its
 * agent has them, until it has answered; the view's console reaches the call through its levers.
 */
function attachView(
  o: PiAdvisorCall,
  agent: Agent,
  call: {
    toolsWith(mcp: AgentTool[]): AgentTool[];
    compact(): void;
    compactions(): number;
    turn(): number;
    closed(): string | undefined;
  },
): void {
  const role = o.sent.role;
  const ownerTurn = (text: string, id?: number) =>
    renderAdvisorTurn(role, {
      program: "pi",
      turn: call.turn(),
      kind: "owner",
      ...(id !== undefined ? { id } : {}),
      text,
    });
  if (o.link) {
    const waiting = o.link.messages;
    linkSession(agent, {
      ...o.link,
      messages: waiting ? async () => (call.closed() ? [] : waiting()) : undefined,
      ownerTurn: (m) => ownerTurn(m.text, m.id),
      sent: o.later,
    });
  }
  const view = o.view;
  if (!view) return;
  const counts = { turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
  agent.subscribe((e) => {
    if (e.type === "turn_end") counts.turns++;
    else if (e.type === "tool_execution_start") counts.toolCalls++;
    else if (e.type === "message_end" && e.message.role === "assistant") {
      const u = (e.message as { usage?: { input?: number; output?: number } }).usage;
      counts.tokensIn += u?.input ?? 0;
      counts.tokensOut += u?.output ?? 0;
    }
  });
  const swap = swappableTools(agent);
  const mcp = o.mcp;
  let listed = mcp?.listed;
  view.attach({
    agent,
    compact: call.compact,
    ownerTurn: (text) => ownerTurn(text),
    sent: o.later,
    mcp: () => listed,
    setMcp: (m) => {
      listed = m;
      swap(call.toolsWith(mcp ? mcp.tools(m) : []));
    },
    status: () => ({
      ...counts,
      compactions: call.compactions(),
      model: o.cfg.model,
      ...(o.maxTurns !== undefined ? { maxTurns: o.maxTurns } : {}),
    }),
    closed: call.closed,
  });
}
