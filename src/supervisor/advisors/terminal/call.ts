import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { type CallLink, type MessageInbox, terminalCall } from "../../../agents/cli/index.ts";
import type { OnceKeeping } from "../../../agents/compaction/index.ts";
import type { ModelConfig, ProviderErrorAnswer } from "../../../agents/model/index.ts";
import { messageText } from "../../../agents/prompt.ts";
import { renderAdvisorTurn } from "../../../agents/roles/index.ts";
import type { RoleRunner } from "../../../agents/runner.ts";
import { errorText } from "../../../common/errors.ts";
import { log } from "../../../common/log.ts";
import type { AdvisorRole } from "../../../core/agents.ts";
import type { LiveKind } from "../../../core/live.ts";
import { advisorCallId } from "../../../core/terminal-input.ts";
import type { CallUsage } from "../../../core/usage.ts";
import type { AdvisorCall, AdvisorCompaction, AdvisorResult } from "../call.ts";
import { type AdvisorRuntime, advisorRoute } from "../config.ts";
import { serveAdvisorModel } from "../proxy.ts";
import { callId, cliHarnessModel, parseAnswer } from "../runtimes/index.ts";
import { serveAdvisorTools } from "../tools/index.ts";
import type { AdvisorConsoles } from "./consoles.ts";
import { type AdvisorProgramId, advisorProgram } from "./profiles.ts";
import { serveAdvisorTurns } from "./turns.ts";

/**
 * An advisor's call in its program's own terminal (goal 169; the owner's decision of 2026-10-31:
 * every role, every program, the same way), on the one path every role takes there
 * (src/agents/cli/call.ts): the program's advisor profile (profiles.ts), run by the advisors'
 * runner as an advisor user, in a folder of its own among the runs' root's children. Its prompt is
 * typed in; the owner's messages for its role go in inside its turn, through its hooks or
 * Thermite's plugin and the call's turn routes (turns.ts); the owner's input, which the harness
 * checked and recorded, is typed into it (consoles.ts, relay.ts); Live shows its screen; and a full
 * usage window is waited out, as a worker's is. Its answer is the newest text that ends one of its
 * turns and holds a valid answer. Where no advisors' runner was started with the supervisor, or the
 * rig runs its agents headless, the advisor runs headless.
 */

/** What an advisor's call in its terminal takes from the supervisor. */
export interface AdvisorTerminals {
  /** The advisors' runner, as the runner the agent runtimes share, and its runs' root. */
  runner: RoleRunner;
  root: string;
  consoles: AdvisorConsoles;
  /** The owner's messages that wait for an advisor role in a run, from the harness. */
  waiting(run: string, role: AdvisorRole): Promise<{ id: number; text: string }[]>;
  /** A line in the run's live view, the supervisor's own. */
  live(line: { kind: LiveKind; text: string; run: string }): void;
  /** Whether the rig drains: a call that waits for its usage window ends. */
  draining?: (() => boolean) | undefined;
  /** How often its session log and the owner's messages are read (tests make it short). */
  pollMs?: number | undefined;
}

/** One advisor's call in its terminal: the run it advises, and the role its owner's messages name. */
export interface AdvisorInTerminal {
  terminals: AdvisorTerminals;
  run: string;
  role: AdvisorRole;
  /** The owner's messages its prompt gives: never offered again inside its turn. */
  given: readonly number[];
}

/** The runtimes whose programs run in their own terminal. */
export type TerminalRuntime = Extract<AdvisorRuntime, { runtime: AdvisorProgramId }>;

/** Whether an advisor's runtime runs in its own terminal on a rig set so (Pi's does not yet). */
export const runsInTerminal = (rt: AdvisorRuntime): rt is TerminalRuntime =>
  rt.runtime === "claude-code" || rt.runtime === "codex" || rt.runtime === "opencode";

/** How often the owner's messages for a call are read again from the harness while it runs. */
const MESSAGES_EVERY_MS = 5_000;

/**
 * The owner's messages for one call in its terminal: those the harness says wait for its role in
 * its run, read again every MESSAGES_EVERY_MS while the call runs, but those its prompt gave. The
 * ones its hook or plugin takes are given, and go with its answer to the harness.
 */
class CallInbox implements MessageInbox {
  private seen: { id: number; text: string }[] = [];
  readonly taken: number[] = [];
  private timer: NodeJS.Timeout | undefined;
  private failing = false;
  private readonly o: {
    read: () => Promise<{ id: number; text: string }[]>;
    given: readonly number[];
    everyMs: number;
    fields: Record<string, unknown>;
  };

  constructor(o: CallInbox["o"]) {
    this.o = o;
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.o.everyMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** The waiting messages, read again; on a failure, the last ones stand, as the log says once. */
  private async refresh(): Promise<void> {
    try {
      this.seen = await this.o.read();
      this.failing = false;
    } catch (err) {
      if (!this.failing)
        log(
          "supervisor",
          "the owner's messages for an advisor in its terminal could not be read: the last ones stand",
          { ...this.o.fields, error: errorText(err) },
          "warn",
        );
      this.failing = true;
    }
  }

  waiting(): { id: number; text: string }[] {
    return this.seen.filter((m) => !this.o.given.includes(m.id) && !this.taken.includes(m.id));
  }

  given(ids: number[]): void {
    this.taken.push(...ids.filter((id) => !this.taken.includes(id)));
  }
}

/** The model a terminal runtime reaches, and the key its proxy adds; else why not, in words. */
function modelOf(rt: TerminalRuntime): { model: ModelConfig; key?: string | undefined } | string {
  if (rt.runtime !== "claude-code") {
    const m = cliHarnessModel(rt);
    return typeof m === "string" ? m : { model: m.model, ...(m.native ? {} : { key: m.key }) };
  }
  // A Claude subscription's token goes to Claude Code alone, on its file descriptor.
  return {
    model: {
      api: "claude",
      harness: "claude-code",
      baseUrl: "",
      model: rt.model,
      apiKey: rt.token,
      contextWindow: rt.context_window ?? 0,
      ...(rt.compact_at !== undefined ? { compactAt: rt.compact_at } : {}),
      maxTokens: 0,
      effort: rt.effort,
    },
  };
}

/** The supervisor's count of its advisors' calls in their terminals, for their ids. */
let count = 0;

/** One advisor call in its program's own terminal; it answers as runAdvisor's other runtimes do. */
export async function runInTerminal<S extends z.ZodType>(
  rt: TerminalRuntime,
  input: AdvisorCall<S>,
  at: AdvisorInTerminal,
): Promise<AdvisorResult<z.infer<S>>> {
  const fail = (error: string) => ({ output: undefined, error, tokensIn: 0, tokensOut: 0, usd: 0 });
  const route = modelOf(rt);
  if (typeof route === "string") return fail(route);
  const { model, key } = route;
  const t = at.terminals;
  const id = advisorCallId(rt.name, at.run, ++count);
  const fields = { advisor: rt.name, run: at.run, call: id };
  const tools = input.tools;
  const usage: CallUsage[] = [];
  const compactions: AdvisorCompaction[] = [];
  /** The provider's newest error answer, which the call's proxy saw (Codex's usage window). */
  let answered: (ProviderErrorAnswer & { at: number }) | undefined;
  const inbox = new CallInbox({
    read: () => t.waiting(at.run, at.role),
    given: at.given,
    everyMs: t.pollMs ?? MESSAGES_EVERY_MS,
    fields,
  });
  let served: Awaited<ReturnType<typeof serveAdvisorTools>> | undefined;
  let proxy: Awaited<ReturnType<typeof serveAdvisorModel>> | undefined;
  let turns: Awaited<ReturnType<typeof serveAdvisorTurns>> | undefined;
  try {
    if (tools?.kb || tools?.mcp?.servers.length || tools?.code || tools?.research || tools?.paper)
      served = await serveAdvisorTools({
        kb: tools.kb,
        mcp: tools.mcp,
        code: tools.code,
        research: tools.research,
        paper: tools.paper,
      });
    if (key !== undefined)
      proxy = await serveAdvisorModel({ api: model.api, baseUrl: model.baseUrl, key }, (a) => {
        answered = { ...a, at: Date.now() };
      });
    turns = await serveAdvisorTurns();
    const first = input.prompt({
      program: rt.runtime,
      // The kit's servers: Thermite's own has its own part of the prompt (goal 175).
      mcpServers: tools?.mcp?.servers ?? [],
      kbWrites: tools?.kb?.writes,
      answerSchema: input.answerSchema,
    });
    // Before each of the program's own compactions, the conversation is kept with the round's
    // records (goal 070), as for a headless call.
    const keeper = input.keeper;
    const kept = callId();
    const keptAt = keeper?.at?.(rt.name, kept);
    const compaction: OnceKeeping | undefined =
      keeper && keptAt
        ? {
            keptAt,
            title: `Advisor ${rt.name}`,
            compacted: (c) => {
              let where: string | null = null;
              let error: string | undefined;
              try {
                where = keeper.keep(rt.name, kept, c.number, c.markdown);
              } catch (err) {
                error = `the conversation was not kept: ${errorText(err)}`;
              }
              const done: AdvisorCompaction = {
                advisor: rt.name,
                number: c.number,
                tokens_before: c.tokensBefore,
                tokens_after: c.tokensAfter,
                how: "harness",
                harness: rt.runtime,
                kept: where,
                ...(c.summary ? { summary: c.summary.slice(0, 4000) } : {}),
                ...(error ? { error } : {}),
              };
              compactions.push(done);
              keeper.done?.(done);
            },
          }
        : undefined;
    const call = turns;
    const link: CallLink = {
      id,
      auth: call.auth,
      title: `Advisor ${rt.name}`,
      messages: inbox,
      turn: (turn, n) => renderAdvisorTurn(first.role, { ...turn, program: rt.runtime, turn: n }),
      sent: input.later,
      live: (entries) => {
        for (const e of entries)
          t.live({ kind: e.kind, text: `${rt.name}: ${e.text}`, run: at.run });
      },
      console: (c) =>
        c
          ? t.consoles.set({ id, run: at.run, role: rt.name.slice(0, 40) }, c)
          : t.consoles.ended(id),
      inTurn: (d) => call.set(d),
      providerAnswer: (since) => (answered && answered.at >= since ? answered : undefined),
      // A full usage window is not a failed try: the advisor waits for the reset (the owner's
      // decision of 2026-10-27), and Live says so.
      waiting: (w) =>
        t.live({
          kind: "status",
          text: `${rt.name} waits for its usage window to reset, until ${w.until}: ${w.words}`,
          run: at.run,
        }),
      draining: t.draining,
      pollMs: t.pollMs,
    };
    inbox.start();
    log("supervisor", "an advisor's call starts in its program's own terminal", {
      ...fields,
      program: rt.runtime,
    });
    const root = t.root;
    const tally = await terminalCall(
      advisorProgram(rt.runtime, { tools: served, proxy }),
      model,
      messageText(first),
      {
        runner: t.runner,
        apiUrl: call.url,
        scratchDir: root,
        // One of the runs' root's children, which the advisors' runner hands to its user.
        folder: () => mkdtempSync(join(root, "thermite-advisor-")),
      },
      {
        role: id,
        link,
        signal: rt.timeout_s !== undefined ? AbortSignal.timeout(rt.timeout_s * 1000) : undefined,
        // None of Claude Code's own tools: only the advisor's MCP tools.
        tools: rt.runtime === "claude-code" ? "" : undefined,
        compaction,
        usage: (u) => usage.push(u),
        answer: (text) => parseAnswer(text, input.schema).ok,
      },
    );
    const answer = parseAnswer(tally.lastText, input.schema);
    const where = advisorRoute(rt);
    const result = {
      tokensIn: tally.tokensIn,
      tokensOut: tally.tokensOut,
      usd: 0,
      ...(where ? { usage: { ...where, calls: usage } } : {}),
      ...(compactions.length ? { compactions } : {}),
      ...(inbox.taken.length ? { given: [...inbox.taken] } : {}),
    };
    if (answer.ok) return { output: answer.value, ...result };
    // Why there is no answer: its last text, else its last error or words on its screen.
    const why = tally.lastText || tally.errors.at(-1) || tally.notes.at(-1) || "no output";
    return { output: undefined, error: `no valid answer: ${why.slice(-300)}`, ...result };
  } catch (err) {
    return fail(`${rt.name} could not run in its terminal: ${errorText(err)}`);
  } finally {
    inbox.stop();
    await turns?.close();
    await proxy?.close();
    await served?.close();
  }
}
