import { Agent } from "@earendil-works/pi-agent-core";
import { Compactor, summarizer } from "../../../agents/compaction/index.ts";
import { lastAssistant, linkSession, steerTurn } from "../../../agents/live-session.ts";
import type { McpForAgent } from "../../../agents/mcp/index.ts";
import { buildModel, PiMeter } from "../../../agents/model/index.ts";
import { swappableTools } from "../../../agents/pi-view/index.ts";
import { messageText, type Prompt, systemText } from "../../../agents/prompt.ts";
import {
  renderCompacted,
  renderWorker,
  renderWorkerTurn,
  type TrialProgram,
  type WorkerTurn,
  windowFit,
} from "../../../agents/roles/index.ts";
import { NoteLimit } from "../../../agents/tools/index.ts";
import { errorText } from "../../../common/errors.ts";
import { laneLimits } from "../../../core/contract.ts";
import {
  classifyProviderError,
  type FailureCount,
  failingOf,
  ProviderWatch,
} from "../provider-errors.ts";
import { guardRepeats } from "../repeats.ts";
import { TrialClock } from "../trial-clock.ts";
import { keepGoing } from "./keep-going.ts";
import type { TrialDeps, TrialResult, TrialSpec } from "./spec.ts";
import { watchedStream, withoutPastThinking } from "./stream.ts";
import { trialTools } from "./tools.ts";

export type { McpForAgent } from "../../../agents/mcp/index.ts";
export {
  type KeepGoingOptions,
  keepGoing,
  stopNudging,
  type TrialEnd,
} from "./keep-going.ts";
export type {
  CompactionLink,
  ProviderWait,
  SubmitOutcome,
  TrialDeps,
  TrialSpec,
} from "./spec.ts";
export { TrialResult } from "./spec.ts";
export { watchedStream, withoutPastThinking } from "./stream.ts";

/**
 * One worker trial: a fresh agent session (Pi) with Thermite's tools, in the lane's own
 * workspace, ending with at most one submission. Every tool acts as the lane's user through the
 * broker; the agent never touches the judge, the ledger or the model key. No state survives
 * the trial except what the harness records.
 *
 * Its parts are modules in worker/: what a trial takes and gives (spec.ts), its tools (tools.ts),
 * what goes to the provider (stream.ts), and how the trial goes on until it ends (keep-going.ts).
 */

/** Pi, as a trial's prompt names it. */
export const PI_TRIAL: TrialProgram = {
  id: "pi",
  name: "Pi",
  turnWords: "each model reply is one",
};

/** A trial's prompt in Pi (goal 166), from the worker's definition, ending at `startedAt` plus its length. */
export function piTrialPrompt(
  spec: TrialSpec,
  mcpServers: readonly string[],
  startedAt: number,
  fit?: number,
): Prompt {
  return renderWorker({
    program: PI_TRIAL,
    brief: spec.brief,
    mcpServers,
    kbWrites: spec.kbWrites,
    limits: spec.limits ?? laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }),
    editablePaths: spec.editablePaths,
    minutes: spec.wallMs !== undefined ? Math.round(spec.wallMs / 60_000) : undefined,
    maxTurns: spec.maxTurns,
    endsAt: spec.wallMs !== undefined ? startedAt + spec.wallMs : undefined,
    fit,
    addition: spec.addition,
  });
}

export async function runTrial(spec: TrialSpec, deps: TrialDeps): Promise<TrialResult> {
  const result: TrialResult = {
    stopped: "no_submission",
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };

  // Without the contract's limits: the defaults (the server enforces the contract's own).
  const limits = spec.limits ?? laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });
  const clock = new TrialClock(spec.wallMs); // the trial's length, when it has one (goal 144)
  // Its prompt, as the harness rendered and recorded it; else rendered here, naming the MCP
  // servers that gave it tools.
  const sent =
    spec.sent ??
    piTrialPrompt(
      spec,
      [...new Set((deps.mcp?.tools ?? []).map((t) => t.server))],
      clock.started,
      windowFit(deps.model.contextWindow, deps.model.compactAt),
    );
  const notes = new NoteLimit(limits.notesPerTurn); // the notes of one reply (goal 147)
  // Its tools, with the MCP tools the gateway listed; the owner may have them listed again in the
  // trial's Pi view (goal 169).
  let mcp = deps.mcp;
  const toolsWith = (m: McpForAgent | undefined) =>
    clock.wrap(
      guardRepeats(
        trialTools(spec, { ...deps, mcp: m }, result, { limits, clock, notes }),
        () => compactor.count,
      ),
    );

  // The later turns of this trial (goal 166), numbered after its first message.
  let said = 0;
  /** A later turn of this trial: from the worker's definition, kept, then sent. */
  const later = (t: WorkerTurn): Prompt => {
    const p = renderWorkerTurn({ program: "pi", turn: ++said, ...t });
    deps.sent?.(p);
    return p;
  };

  const { models, model, thinkingLevel } = buildModel(deps.model);
  // Each model call's usage, the compaction summaries' included (goal 075).
  const meter = deps.modelUsage ? new PiMeter(deps.modelUsage) : undefined;
  // The provider's error answers, for a rate limit's time (goal 079).
  const watch = new ProviderWatch();
  const agent = new Agent({
    initialState: {
      systemPrompt: systemText(sent),
      model,
      tools: toolsWith(mcp),
      thinkingLevel,
    },
    streamFn: watchedStream(models, watch, meter),
    convertToLlm: withoutPastThinking,
    // One tool call at a time: lane processes are killed by user when a tool finishes, so parallel
    // calls would kill each other, and a submission must end the trial before anything else runs.
    toolExecution: "sequential",
  });
  meter?.watch(agent);
  // Near the model's window the conversation is compacted and the trial goes on (goal 070): a
  // conversation that grows never ends a trial nor asks for an early submission.
  const compactor = new Compactor({
    window: deps.model.contextWindow,
    at: deps.model.compactAt,
    convert: withoutPastThinking,
    summarize: summarizer(deps.model, meter),
    keep: async (n, markdown) => {
      if (!deps.compaction) throw new Error("this trial has no place to keep it");
      const { path } = await deps.compaction.keep(n, markdown);
      return { path };
    },
    done: async (r) => deps.compaction?.done(r),
    after: (c) => renderCompacted({ role: "worker", turn: ++said, ...c }),
    sent: deps.sent,
    stop: (reason) => {
      if (result.submitted) return;
      result.stopped = "context";
      result.error = reason;
      agent.abort();
    },
    title: `Trial ${spec.trialId} (${spec.lane})`,
  });
  agent.prepareRequest = compactor.hook(agent);
  // A budget the campaign or the rig set is stated up front, and the worker is told once when it
  // is nearly spent, so a trial ends with its best change submitted rather than cut off with
  // nothing. Without one, a trial lasts until it submits or stops (goal 079).
  const { started, wallMs } = clock;
  const minutes = wallMs !== undefined ? Math.round(wallMs / 60_000) : undefined;
  let warned = false;
  const warn = (left: { turnsLeft: number } | { msLeft: number }) => {
    if (warned || result.submitted) return;
    warned = true;
    const p = renderWorkerTurn({
      program: "pi",
      turn: ++said,
      kind: "nearly-spent",
      ...left,
    });
    steerTurn(agent, p, () => deps.sent?.(p));
  };
  const maxTurns = spec.maxTurns;
  const warnTurns = maxTurns === undefined ? undefined : Math.max(1, maxTurns - 10);
  agent.subscribe((event) => {
    if (event.type === "turn_end") {
      result.turns++;
      notes.reset();
      const usage = (event.message as { usage?: { input?: number; output?: number } }).usage;
      result.tokensIn += usage?.input ?? 0;
      result.tokensOut += usage?.output ?? 0;
      if (maxTurns !== undefined && result.turns >= maxTurns && !result.submitted) {
        result.stopped = "turns";
        agent.abort();
      } else if (maxTurns !== undefined && warnTurns !== undefined && result.turns >= warnTurns) {
        warn({ turnsLeft: maxTurns - result.turns });
      } else if (wallMs !== undefined && Date.now() - started >= wallMs * 0.85) {
        warn({ msLeft: clock.leftMs() ?? 0 });
      }
    }
  });
  // After the turn cap above: the owner's messages are not fetched on the turn it stops. After a
  // submission none are taken either: the trial is over, and the lane's next trial, which can
  // act on them, reads them in its brief.
  const link = deps.link;
  const waiting = link?.messages;
  if (link)
    linkSession(agent, {
      ...link,
      messages: waiting ? async () => (result.submitted ? [] : waiting()) : undefined,
      ownerTurn: (m) =>
        renderWorkerTurn({ program: "pi", turn: ++said, kind: "owner", text: m.text }),
      sent: deps.sent,
    });
  // Its Pi view's console (goal 169): each of the owner's calls is one of these levers.
  const swapTools = deps.view ? swappableTools(agent) : undefined;
  deps.view?.attach({
    agent,
    compact: () => compactor.force("asked"),
    ownerTurn: (text) => renderWorkerTurn({ program: "pi", turn: ++said, kind: "owner", text }),
    sent: deps.sent,
    mcp: () => mcp,
    setMcp: (m) => {
      mcp = m;
      swapTools?.(toolsWith(m));
    },
    status: () => ({
      turns: result.turns,
      toolCalls: result.toolCalls,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      compactions: compactor.count,
      msLeft: clock.leftMs(),
      maxTurns,
      model: deps.model.model,
    }),
    closed: () =>
      result.submitted
        ? "the trial has submitted its change: nothing more goes to its agent"
        : result.stopped !== "no_submission"
          ? `the trial is ending (${result.stopped})`
          : undefined,
  });
  const wall =
    wallMs !== undefined
      ? setTimeout(() => {
          if (!result.submitted) result.stopped = "wall";
          agent.abort();
        }, wallMs)
      : undefined;
  // The trial's failed model calls in a row, and since when (goal 079), over all its replies.
  const failures: FailureCount = { failures: 0, rateWaits: 0 };
  try {
    await agent.prompt(messageText(sent));
    // A model that stops of its own accord without submitting is told to go on (goal 079): for
    // as long as it keeps working (a tool call since the last nudge), with no number unless the
    // campaign sets lanes.limits.nudges. A nudge it answers without any work ends the trial, its
    // own choice; the lane's next one starts afresh. Cut-off replies and failed calls never end
    // it (keepGoing).
    let nudges = 0;
    let callsAtNudge = -1;
    for (;;) {
      const end = await keepGoing(
        agent,
        () => result.submitted !== undefined || result.stopped !== "no_submission",
        deps.model.contextWindow,
        compactor,
        {
          failuresInARow: spec.limits?.failuresInARow,
          cutoffsInARow: spec.limits?.cutoffsInARow,
          watch,
          onWait: deps.waiting,
          count: failures,
          say: later,
        },
      );
      if (end && !result.submitted) {
        result.stopped = end.stopped;
        result.error = end.error;
        if (end.kind) result.errorKind = end.kind;
        break;
      }
      if (result.submitted || result.stopped !== "no_submission") break;
      // The owner interrupted the reply in the trial's Pi view (goal 169): not the agent's own
      // stop, so no nudge is counted. The trial goes on at once with the owner's words that wait,
      // or with its nudge.
      if (deps.view?.interrupted()) {
        if (agent.hasQueuedMessages()) await agent.continue();
        else await agent.prompt(messageText(later({ kind: "nudge" })));
        continue;
      }
      if (nudges > 0 && result.toolCalls === callsAtNudge) break;
      if (spec.limits?.nudges !== undefined && nudges >= spec.limits.nudges) break;
      nudges++;
      callsAtNudge = result.toolCalls;
      await agent.prompt(messageText(later({ kind: "nudge" })));
    }
  } catch (err) {
    if (result.stopped === "no_submission") {
      result.stopped = "error";
      result.error = errorText(err);
    }
  } finally {
    if (wall) clearTimeout(wall);
  }
  if (compactor.count) result.compactions = compactor.count;
  // Why the model stopped, for a trial that ended without a submission. A trial stopped at its
  // own turn or time limit says so, and one whose conversation does not fit even compacted has
  // its reason already; the call the stop aborted is not the model's error.
  const last = lastAssistant(agent);
  if (!result.submitted && (result.stopped === "turns" || result.stopped === "wall")) {
    result.error =
      result.stopped === "turns"
        ? `the trial reached its limit of ${maxTurns} turns before a submission`
        : `the trial reached its ${minutes}-minute limit before a submission`;
  } else if (!result.submitted && !result.error && last && last.stopReason !== "toolUse") {
    result.error = `the model stopped (${last.stopReason})${last.errorMessage ? `: ${last.errorMessage.slice(0, 300)}` : ""}`;
    if (last.stopReason === "error" && result.stopped === "no_submission") {
      result.stopped = "error";
      result.errorKind ??= classifyProviderError(last.errorMessage ?? "").kind;
    }
  }
  const failing = failingOf(failures);
  if (failing && !result.submitted) result.failing = failing;
  return result;
}
