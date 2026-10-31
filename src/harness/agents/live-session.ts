import type { Agent } from "@earendil-works/pi-agent-core";
import { type Prompt, userMessage } from "../../agents/prompt.ts";
import { renderWorkerTurn } from "../../agents/roles/index.ts";
import { log } from "../../common/env.ts";
import type { InTurn, MessageHow } from "../../core/agents.ts";
import { type LiveKind, liveText, summarizeArgs } from "../../core/live.ts";

/**
 * Links an agent session to control's live view: its turns go to the live log, and the owner's
 * messages (message_agent) come back in as user turns, injected after the current turn. Both are
 * best effort: a failing link never stops the session.
 *
 * A message is confirmed (its read receipt) only when the agent takes it into its conversation
 * for its next model call. One fetched on a turn that a time or turn limit stops is never given,
 * so it is not confirmed and waits for the lane's next trial.
 */
export interface SessionLink {
  live?: ((entries: { kind: LiveKind; text: string }[]) => Promise<unknown>) | undefined;
  /** The owner's messages waiting for this trial (fetching them gives nothing to the agent). */
  messages?: (() => Promise<{ id: number; text: string }[]>) | undefined;
  /** Confirms that these messages reached the agent. */
  read?: ((ids: number[]) => Promise<unknown>) | undefined;
  /** The session's counters so far, after each turn: kept by the harness if the trial dies. */
  progress?: ((p: TrialProgress) => Promise<unknown>) | undefined;
  /** Its open model call, every REPLY_REPORT_MS while one is open; null once it ends (goal 143). */
  reply?: ((r: ReplyNow | null) => Promise<unknown>) | undefined;
  /**
   * An owner's message as the agent's role puts it to the agent, a later turn of its call (goal
   * 166); by default, a worker's.
   */
  ownerTurn?: ((m: { id: number; text: string }) => Prompt) | undefined;
  /** Keeps a later turn once it enters the conversation (goal 166). */
  sent?: ((p: Prompt) => void) | undefined;
}

/**
 * A model call that is open (goal 143): since when the turn waits or streams, and how many
 * characters of text, thinking and tool-call arguments the model has sent so far. On the lab a
 * trial sent nothing for more than four hours; this says whether it waits, or streams one long
 * reply.
 */
export interface ReplyNow {
  since: string;
  text: number;
  thinking: number;
  tool_args: number;
}

/** How often an open model call is reported. A shorter call is never reported. */
export const REPLY_REPORT_MS = 30_000;

/** The owner's messages for a running trial, as an in-process harness adapter reads them. */
export interface MessageInbox {
  /** Messages waiting for the trial (fetching them gives nothing to the agent). */
  waiting(): { id: number; text: string }[];
  /** These messages were given to the agent, `how` (goal 169): their read receipts. */
  given(ids: number[], how?: MessageHow): void;
}

/**
 * How a running trial in Claude Code, Codex or OpenCode takes the owner's messages inside its
 * turn (goal 169), through its hook or Thermite's plugin, which ask the trial's routes
 * (core/api/harness/turn.ts).
 */
export interface TurnDelivery {
  /**
   * The next message waiting, as the agent's role puts it, held for the hook that asked until
   * its receipt; undefined when none waits or no run is under way. Nothing is read yet.
   */
  offer(at: InTurn): { offer: string; text: string } | undefined;
  /** The hook gave the offer's text to its program: it is read now. The ids read. */
  taken(offer: string): number[];
}

export interface TrialProgress {
  turns: number;
  tool_calls: number;
  tokens_in: number;
  tokens_out: number;
}

type Block = { type?: string; text?: string; thinking?: string };

function textOf(content: unknown, type: "text" | "thinking"): string {
  if (typeof content === "string") return type === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .filter((b) => b.type === type)
    .map((b) => (type === "text" ? b.text : b.thinking) ?? "")
    .join("\n")
    .trim();
}

function resultText(result: unknown): string {
  const r = result as { content?: unknown } | undefined;
  const t = textOf(r?.content, "text");
  return t || summarizeArgs(result, 600);
}

/**
 * Steers a later turn into a running session, for its next model call (goal 166), or, as a
 * follow-up, for when the agent would stop (`follow-up`: the owner's choice in a trial's Pi view,
 * goal 169). `entered`: once it enters the conversation; a turn that a stop overtakes never does,
 * and was never sent.
 */
export function steerTurn(
  agent: Agent,
  p: Prompt,
  entered: () => void,
  when: "next-call" | "follow-up" = "next-call",
): void {
  const message = userMessage(p);
  const off = agent.subscribe((event, signal) => {
    if (event.type !== "message_end" || event.message !== message) return;
    off();
    if (!signal.aborted) entered();
  });
  if (when === "follow-up") agent.followUp(message);
  else agent.steer(message);
}

export function linkSession(agent: Agent, link: SessionLink): void {
  // A long line is cut and marked, as the harness's own are; a refusal is logged, the first of
  // a streak (goal 171).
  let refused = false;
  const send = (kind: LiveKind, text: string) => {
    if (!link.live || !text) return;
    link.live([{ kind, text: liveText(text) }]).then(
      () => {
        refused = false;
      },
      (err) => {
        if (!refused)
          log("worker", "a live line was not taken", { kind, error: String(err) }, "warn");
        refused = true;
      },
    );
  };
  const counted: TrialProgress = { turns: 0, tool_calls: 0, tokens_in: 0, tokens_out: 0 };
  const reply = replyReports(link);
  const offered = new Set<number>();
  let owned = 0;
  const ownerTurn =
    link.ownerTurn ??
    ((m: { text: string }) =>
      renderWorkerTurn({ program: "pi", turn: ++owned, kind: "owner", text: m.text }));
  agent.subscribe(async (event, signal) => {
    switch (event.type) {
      case "turn_start":
        reply.open();
        break;
      case "message_update":
        reply.grew(event.assistantMessageEvent);
        break;
      case "agent_end":
        reply.close();
        break;
      case "message_end": {
        const m = event.message as {
          role?: string;
          content?: unknown;
          stopReason?: string;
          errorMessage?: string;
          usage?: { input?: number; output?: number };
        };
        if (m.role !== "assistant") break;
        reply.close();
        counted.tokens_in += m.usage?.input ?? 0;
        counted.tokens_out += m.usage?.output ?? 0;
        const thinking = textOf(m.content, "thinking");
        if (thinking) send("thinking", thinking.slice(0, 2000));
        send("text", textOf(m.content, "text"));
        // A reply that ended other than normally says how, so an anomaly shows its cause.
        if (m.stopReason && m.stopReason !== "toolUse" && m.stopReason !== "stop") {
          send(
            "text",
            `(reply ended: ${m.stopReason}; ${m.usage?.input ?? "?"} tokens in, ${m.usage?.output ?? "?"} out${m.errorMessage ? `; ${m.errorMessage.slice(0, 300)}` : ""})`,
          );
        }
        break;
      }
      case "tool_execution_start":
        counted.tool_calls++;
        send("tool", `${event.toolName} ${summarizeArgs(event.args)}`);
        break;
      case "tool_execution_end":
        send(
          "result",
          `${event.toolName}${event.isError ? " failed" : ""}${event.durationMs !== undefined ? ` (${Math.round(event.durationMs)} ms)` : ""}: ${resultText(event.result).slice(0, 1200)}`,
        );
        break;
      case "turn_end": {
        counted.turns++;
        link.progress?.({ ...counted }).catch(() => undefined);
        if (!link.messages) break;
        // A turn that a limit or a failure ended has no next model call to carry a message.
        const stop = (event.message as { stopReason?: string }).stopReason;
        if (signal.aborted || stop === "aborted" || stop === "error") break;
        let msgs: { id: number; text: string }[] = [];
        try {
          msgs = await link.messages();
        } catch {
          break;
        }
        if (signal.aborted) break;
        for (const msg of msgs) {
          if (offered.has(msg.id)) continue;
          offered.add(msg.id);
          // It enters the conversation for the next model call: it is read and kept then, unless
          // the session is being stopped (then that call never happens).
          const p = ownerTurn(msg);
          steerTurn(agent, p, () => {
            link.read?.([msg.id]).catch(() => undefined);
            link.sent?.(p);
          });
        }
        break;
      }
    }
  });
}

/**
 * The open model call's reports: one every REPLY_REPORT_MS from the turn's start until its reply
 * ends, and null at its end when any was sent. Best effort, as every report of the link.
 */
function replyReports(link: SessionLink) {
  let now: ReplyNow | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sent = false;
  const send = (r: ReplyNow | null) => {
    link.reply?.(r ? { ...r } : null).catch(() => undefined);
  };
  return {
    open(): void {
      if (!link.reply) return;
      this.close();
      now = { since: new Date().toISOString(), text: 0, thinking: 0, tool_args: 0 };
      timer = setInterval(() => {
        if (!now) return;
        sent = true;
        send(now);
      }, REPLY_REPORT_MS);
      timer.unref?.();
    },
    grew(e: { type: string; delta?: string }): void {
      if (!now || typeof e.delta !== "string") return;
      if (e.type === "text_delta") now.text += e.delta.length;
      else if (e.type === "thinking_delta") now.thinking += e.delta.length;
      else if (e.type === "toolcall_delta") now.tool_args += e.delta.length;
    },
    close(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (now && sent) send(null);
      now = null;
      sent = false;
    },
  };
}
