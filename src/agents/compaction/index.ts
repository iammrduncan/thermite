import type {
  Agent,
  AgentMessage,
  AgentRequestUpdate,
  PrepareRequestContext,
} from "@earendil-works/pi-agent-core";
import { getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { errorText } from "../../common/errors.ts";
import { COMPACT_AT_DEFAULT } from "../../core/compaction.ts";
import { buildModel, type ModelConfig, type PiMeter } from "../model/index.ts";
import { messageText, type Prompt, systemText, userMessage } from "../prompt.ts";
import { type Compacted, renderCompaction } from "../roles/index.ts";

/**
 * Compaction (goal 070), for the harness's agents and the supervisor's advisors: in Pi (this
 * file); in OpenCode v2, the Codex CLI and Claude Code, which each compact their own conversation
 * (cli.ts); and the conversations those three keep, read when one of them compacts
 * (conversation.ts).
 */

export {
  type CliCompacted,
  CliCompactions,
  codexCompactPrompt,
  compactionTokens,
  type FoundCompaction,
  type KeptAt,
  keptLine,
  type OnCompacted,
  type OnceKeeping,
  type OwnConversation,
  reclaim,
} from "./cli.ts";
export {
  claudeCompactions,
  claudeOwn,
  claudeTranscript,
  codexCompactions,
  codexOwn,
  findCodexRollout,
  type Own,
  opencodeEnded,
  opencodeOwn,
  readOwn,
  readUnder,
} from "./conversation.ts";

/**
 * Compaction in Pi (goal 070): when a conversation's input reaches the compaction point (a share
 * of the model's window), the harness compacts it before the next model call, and the trial goes
 * on. It is never a cap: it ends no trial and asks for no early submission.
 *
 * Each compaction first keeps the whole conversation as a document the agent can read (`keep`),
 * then asks the same model for a summary with a fixed prompt. The conversation becomes the system
 * prompt, the brief, one message with the summary and the document's path (the agent's role
 * renders it: renderCompacted), and the most recent turns that fit (a tool call is never parted
 * from its result). If the summary call fails, the oldest tool results' bodies are left out
 * instead, each with a one-line stub. Only when the provider says the context is full and even
 * that cannot fit the window does the trial end, as `context`, with the reason in words: the token
 * counts here are estimates.
 *
 * It runs in Pi's own hook before each model request (the agent's `prepareRequest`), and sets the
 * agent's transcript to the compacted one, so later prompts build on it too.
 */

/** The most recent turns kept whole after a compaction: a few, within a quarter of the window. */
const KEEP_TURNS = 6;
const KEEP_SHARE = 0.25;
/** A trimmed conversation (the summary failed) is cut until it is at most half the window. */
const TRIM_SHARE = 0.5;
/** The summary call's input: at most this share of the window. */
const SUMMARY_INPUT_SHARE = 0.5;
/** Characters per token, as pi-ai estimates them. */
const CHARS_PER_TOKEN = 3.5;

export interface CompactionReport {
  /** The compaction's number in this conversation, from 1. */
  number: number;
  /** The conversation's input before and after, in tokens (estimated). */
  tokensBefore: number;
  tokensAfter: number;
  /** "summary": the model summarized it; "trimmed": the summary failed, old tool results were cut. */
  how: "summary" | "trimmed";
  summary?: string | undefined;
  /** Why the summary failed, or why the document was not kept. */
  error?: string | undefined;
  /** The kept document, as the agent reads it; none when keeping it failed. */
  path?: string | undefined;
}

export interface CompactionDeps {
  /** The model's context window in tokens; 0: unknown, so only a full context compacts. */
  window: number;
  /** The compaction point, in percent of the window (unset: COMPACT_AT_DEFAULT). */
  at?: number | undefined;
  /** What the agent sends the model: its conversation as converted for each call. */
  convert: (messages: AgentMessage[]) => Message[];
  /** The same model's summary of the conversation so far, with the fixed prompt. */
  summarize: (transcript: string, signal?: AbortSignal) => Promise<string>;
  /** Keeps the whole conversation as a document. Returns where it is, as the agent names it. */
  keep: (n: number, markdown: string) => Promise<{ path: string }>;
  /** A compaction is done: the event and the live view's lines (best effort). */
  done: (c: CompactionReport) => Promise<unknown>;
  /** Even compacted, the conversation does not fit the window: the trial ends, for this reason. */
  stop: (reason: string) => void;
  /** Whose conversation it is, for the document's title: "Trial t-1 (lane-1)". */
  title: string;
  /** The message the agent goes on from, as its role renders it (renderCompacted, goal 166). */
  after: (c: Compacted) => Prompt;
  /** Keeps that message once the compaction stands, as the call's other prompts are kept. */
  sent?: ((p: Prompt) => void) | undefined;
}

/** A conversation, split for compaction. Each turn starts with an assistant message. */
interface Parts {
  system: AgentMessage[];
  brief: AgentMessage | undefined;
  /** Messages after the brief and before the first reply (an earlier summary, say). */
  lead: AgentMessage[];
  turns: AgentMessage[][];
}

const tokensOf = (convert: CompactionDeps["convert"], messages: AgentMessage[]): number =>
  convert(messages).reduce((n, m) => n + estimateMessageTokens(m), 0);

const words = (n: number) => Math.round(n).toLocaleString("en-US");

export class Compactor {
  /** Compactions done so far in this conversation. */
  count = 0;
  private readonly o: CompactionDeps;
  /** The next request compacts first: the provider said the context is full, or the owner asked. */
  private forced: "full" | "asked" | undefined;
  /** After a compaction that stayed above the point: where the next one starts. */
  private next: number | undefined;

  constructor(o: CompactionDeps) {
    this.o = o;
  }

  /** The compaction point in tokens; undefined when the window is unknown. */
  get point(): number | undefined {
    return this.o.window > 0
      ? Math.floor((this.o.window * (this.o.at ?? COMPACT_AT_DEFAULT)) / 100)
      : undefined;
  }

  /**
   * The next request compacts first, whatever its size: the provider said the context is full
   * (`full`), or the owner asked in a worker's Pi view (`asked`, goal 169), when a conversation
   * that still does not fit is left to the provider to refuse.
   */
  force(why: "full" | "asked" = "full"): void {
    if (this.forced !== "full") this.forced = why;
  }

  /** Pi's hook before each model request, for this agent (assigned to `agent.prepareRequest`). */
  hook(agent: Agent) {
    return async (
      req: PrepareRequestContext,
      signal?: AbortSignal,
    ): Promise<AgentRequestUpdate | undefined> => {
      const messages = req.context.messages;
      const before = estimateContextTokens(this.o.convert(messages)).tokens;
      const point = this.next ?? this.point;
      if (!this.forced && (point === undefined || before < point)) return undefined;
      const forced = this.forced === "full";
      this.forced = undefined;
      const compacted = await this.compact(messages, before, forced, signal);
      if (!compacted) return undefined;
      agent.state.messages = compacted;
      return { context: { ...req.context, messages: compacted.slice() } };
    };
  }

  /**
   * Compacts the conversation, or returns undefined when there is nothing to compact yet (no
   * reply after the brief). `forced`: the provider said the context is full. The token counts
   * here are estimates, so a conversation is said not to fit, and its trial ended, only when the
   * provider said so too; otherwise the request goes, and the provider decides.
   */
  private async compact(
    messages: AgentMessage[],
    before: number,
    forced: boolean,
    signal?: AbortSignal,
  ): Promise<AgentMessage[] | undefined> {
    const window = this.o.window;
    const parts = split(messages);
    if (!parts.turns.length) return undefined;
    const n = this.count + 1;
    // The whole conversation first, kept where the agent can read it.
    let kept: Compacted["kept"];
    try {
      kept = await this.o.keep(n, transcriptMarkdown(this.o.title, n, before, messages));
    } catch (err) {
      kept = { error: `the conversation was not kept: ${errorText(err)}` };
    }
    // A full context of unknown size: the room it had is what it filled. The compacted one is
    // measured as the whole one is here, by its text.
    const whole = tokensOf(this.o.convert, messages);
    const room = window > 0 ? window : Math.max(before, whole);
    let summary: string | undefined;
    let summaryError: string | undefined;
    try {
      summary = (
        await this.o.summarize(summaryTranscript(messages, room * SUMMARY_INPUT_SHARE), signal)
      ).trim();
      if (!summary) throw new Error("the model's summary was empty");
    } catch (err) {
      summary = undefined;
      summaryError = `the summary failed: ${errorText(err)}`;
    }
    const path = "path" in kept ? kept.path : undefined;
    const stub = path !== undefined ? ` It is in ${path}.` : "";
    let out: AgentMessage[];
    let said: Prompt;
    if (summary !== undefined) {
      const tail = keepTail(this.o.convert, parts.turns, Math.floor(room * KEEP_SHARE), stub);
      said = this.o.after({ number: n, kept, summary, tail: tail.length > 0 });
      out = [...parts.system, ...(parts.brief ? [parts.brief] : []), userMessage(said), ...tail];
    } else {
      said = this.o.after({ number: n, kept, tail: false });
      out = trim(this.o.convert, parts, userMessage(said), Math.floor(room * TRIM_SHARE), stub);
    }
    const after = tokensOf(this.o.convert, out);
    if (forced && (window > 0 ? after >= window : after >= whole)) {
      this.o.stop(
        `the conversation does not fit the model's context window${window > 0 ? ` of ${words(window)} tokens` : ""} even after compaction (about ${words(after)} tokens: the brief or one message is too large)`,
      );
      return undefined;
    }
    this.count = n;
    this.o.sent?.(said);
    // Still above the point: the next compaction waits until the conversation grows halfway to
    // the window (a twentieth of it at least), so it is not compacted again at once.
    const point = this.point;
    this.next =
      point !== undefined && after >= point
        ? after + Math.max(Math.floor((window - after) / 2), Math.floor(window / 20))
        : undefined;
    const error = ["error" in kept ? kept.error : undefined, summaryError]
      .filter(Boolean)
      .join("; ");
    await this.o
      .done({
        number: n,
        tokensBefore: before,
        tokensAfter: after,
        how: summary !== undefined ? "summary" : "trimmed",
        ...(summary !== undefined ? { summary } : {}),
        ...(error ? { error } : {}),
        ...(path !== undefined ? { path } : {}),
      })
      // Best effort, as the live view is: the compaction stands whether or not it was reported.
      .catch(() => undefined);
    return out;
  }
}

/** The conversation's parts: system messages, the brief, then turns from each reply on. */
function split(messages: AgentMessage[]): Parts {
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const b = rest.findIndex((m) => m.role === "user");
  const brief = b >= 0 ? rest[b] : undefined;
  const lead: AgentMessage[] = [];
  const turns: AgentMessage[][] = [];
  for (const m of rest.slice(b + 1)) {
    if (m.role === "assistant") turns.push([m]);
    else if (turns.length) (turns.at(-1) as AgentMessage[]).push(m);
    else lead.push(m);
  }
  return { system, brief, lead, turns };
}

/** A message's text, whatever its content's form. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type?: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/** A tool result with its text cut to `chars`, saying where the rest is. */
function clipped(m: AgentMessage, chars: number, stub: string): AgentMessage {
  const text = textOf((m as { content?: unknown }).content);
  if (text.length <= chars) return m;
  return {
    ...m,
    content: [
      {
        type: "text",
        text: `${text.slice(0, chars)}\n[cut here to save room: ${words(text.length - chars)} more characters.${stub}]`,
      },
    ],
  } as AgentMessage;
}

/** A tool result's body left out, with a one-line stub. */
function stubbed(m: AgentMessage, stub: string): AgentMessage {
  const r = m as { toolName?: string; content?: unknown };
  const text = textOf(r.content);
  return {
    ...m,
    content: [
      {
        type: "text",
        text: `[left out to save room: ${words(text.length)} characters from ${r.toolName ?? "a tool"}.${stub}]`,
      },
    ],
  } as AgentMessage;
}

/**
 * The most recent turns that fit `budget` tokens, a few at most, whole turns only (a tool call
 * keeps its result). The last turn is always kept; a last turn larger than the budget keeps its
 * tool results cut to fit.
 */
function keepTail(
  convert: CompactionDeps["convert"],
  turns: AgentMessage[][],
  budget: number,
  stub: string,
): AgentMessage[] {
  const last = turns.at(-1) as AgentMessage[];
  let kept: AgentMessage[][] = [last];
  let used = tokensOf(convert, last);
  if (used > budget) {
    const results = last.filter((m) => m.role === "toolResult").length;
    const fixed = tokensOf(
      convert,
      last.filter((m) => m.role !== "toolResult"),
    );
    const each = Math.max(
      2000,
      Math.floor(((budget - fixed) * CHARS_PER_TOKEN) / Math.max(1, results)),
    );
    kept = [last.map((m) => (m.role === "toolResult" ? clipped(m, each, stub) : m))];
    return kept.flat();
  }
  for (let i = turns.length - 2; i >= 0 && kept.length < KEEP_TURNS; i--) {
    const t = turns[i] as AgentMessage[];
    const size = tokensOf(convert, t);
    if (used + size > budget) break;
    kept = [t, ...kept];
    used += size;
  }
  return kept.flat();
}

/**
 * The fallback when the summary fails: every message kept, but the oldest tool results' bodies
 * left out (a stub each), oldest first, until the conversation is within `target` tokens. The
 * last turn's results stay whole unless nothing else is left to cut.
 */
function trim(
  convert: CompactionDeps["convert"],
  parts: Parts,
  notice: AgentMessage,
  target: number,
  stub: string,
): AgentMessage[] {
  const turns = parts.turns.map((t) => t.slice());
  const build = () => [
    ...parts.system,
    ...(parts.brief ? [parts.brief] : []),
    notice,
    ...parts.lead,
    ...turns.flat(),
  ];
  let size = tokensOf(convert, build());
  for (let i = 0; i < turns.length - 1 && size > target; i++) {
    const t = turns[i] as AgentMessage[];
    for (let j = 0; j < t.length; j++)
      if (t[j]?.role === "toolResult") t[j] = stubbed(t[j] as AgentMessage, stub);
    size = tokensOf(convert, build());
  }
  if (size > target) {
    const last = turns.at(-1) as AgentMessage[];
    const results = last.filter((m) => m.role === "toolResult").length;
    const each = Math.max(
      2000,
      Math.floor(
        ((target - (size - tokensOf(convert, last))) * CHARS_PER_TOKEN) / Math.max(1, results),
      ),
    );
    turns[turns.length - 1] = last.map((m) =>
      m.role === "toolResult" ? clipped(m, each, stub) : m,
    );
  }
  return build();
}

/** A fence for a block of text: longer than any run of backticks inside it. */
function fenced(text: string, lang = "text"): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/**
 * The whole conversation as Markdown: every message and tool result, in order, with each reply's
 * thinking, text and tool calls.
 */
export function transcriptMarkdown(
  title: string,
  n: number,
  tokens: number,
  messages: AgentMessage[],
): string {
  const out = [
    `# ${title}: the conversation before compaction ${n}`,
    "",
    `Kept by the harness at ${new Date().toISOString()}, at about ${words(tokens)} tokens. Every message and tool result, in order.`,
  ];
  messages.forEach((m, i) => {
    const k = i + 1;
    if (m.role === "system") {
      const tools = (m as { toolsAdded?: { name?: string }[] }).toolsAdded ?? [];
      out.push(
        "",
        `## ${k}. System`,
        "",
        fenced(getSystemMessageText(m)),
        ...(tools.length ? ["", `Tools: ${tools.map((t) => t.name ?? "?").join(", ")}`] : []),
      );
    } else if (m.role === "user") {
      out.push("", `## ${k}. User`, "", fenced(textOf(m.content)));
    } else if (m.role === "assistant") {
      out.push("", `## ${k}. Assistant`);
      for (const b of m.content as {
        type: string;
        text?: string;
        thinking?: string;
        name?: string;
        id?: string;
        arguments?: unknown;
      }[]) {
        if (b.type === "thinking" && b.thinking) out.push("", "Thinking:", "", fenced(b.thinking));
        else if (b.type === "text" && b.text) out.push("", fenced(b.text));
        else if (b.type === "toolCall")
          out.push(
            "",
            `Tool call \`${b.name}\` (${b.id}):`,
            "",
            fenced(JSON.stringify(b.arguments ?? {}, null, 2), "json"),
          );
      }
      const a = m as { stopReason?: string; errorMessage?: string };
      if (a.stopReason && a.stopReason !== "stop" && a.stopReason !== "toolUse")
        out.push(
          "",
          `(The reply ended: ${a.stopReason}${a.errorMessage ? `; ${a.errorMessage}` : ""}.)`,
        );
    } else if (m.role === "toolResult") {
      const r = m as { toolName?: string; toolCallId?: string; isError?: boolean };
      out.push(
        "",
        `## ${k}. Tool result: ${r.toolName ?? "?"} (${r.toolCallId ?? "?"})${r.isError ? ", an error" : ""}`,
        "",
        fenced(textOf(m.content)),
      );
    }
  });
  return `${out.join("\n")}\n`;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} [… cut]` : s);

/**
 * The conversation as the summary call reads it: every message after the system prompt, with
 * long tool results and arguments cut. Over `budget` tokens, the brief and the newest messages
 * that fit are kept, and the cut is marked.
 */
export function summaryTranscript(messages: AgentMessage[], budget: number): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "user") parts.push(`## User\n\n${cut(textOf(m.content), 8000)}`);
    else if (m.role === "assistant") {
      const lines: string[] = [];
      for (const b of m.content as {
        type: string;
        text?: string;
        name?: string;
        arguments?: unknown;
      }[]) {
        if (b.type === "text" && b.text) lines.push(cut(b.text, 4000));
        else if (b.type === "toolCall")
          lines.push(`Tool call ${b.name}: ${cut(JSON.stringify(b.arguments ?? {}), 1500)}`);
      }
      if (lines.length) parts.push(`## Assistant\n\n${lines.join("\n\n")}`);
    } else if (m.role === "toolResult") {
      const r = m as { toolName?: string; isError?: boolean };
      parts.push(
        `## Tool result (${r.toolName ?? "?"}${r.isError ? ", an error" : ""})\n\n${cut(textOf(m.content), 2000)}`,
      );
    }
  }
  const max = Math.max(4000, Math.floor(budget * CHARS_PER_TOKEN));
  const all = parts.join("\n\n");
  if (all.length <= max || parts.length < 2) return all.slice(0, max);
  const first = parts[0] as string;
  const kept: string[] = [];
  let used = first.length;
  for (let i = parts.length - 1; i >= 1; i--) {
    const p = parts[i] as string;
    if (used + p.length + 2 > max) break;
    kept.unshift(p);
    used += p.length + 2;
  }
  const left = parts.length - 1 - kept.length;
  return [
    first.slice(0, max),
    ...(left ? [`[${left} earlier messages are left out here to fit; the newest follow.]`] : []),
    ...kept,
  ].join("\n\n");
}

/**
 * The same model's summary call, with the fixed compaction prompt. `meter`: the agent's own, which
 * records the call's usage with the agent's other calls (goal 075).
 */
export function summarizer(cfg: ModelConfig, meter?: PiMeter | undefined) {
  const { models, model, thinkingLevel } = buildModel(cfg);
  return async (transcript: string, signal?: AbortSignal): Promise<string> => {
    const sent = renderCompaction({ program: "pi", transcript });
    const reply = await models.completeSimple(
      model,
      {
        systemPrompt: systemText(sent),
        messages: [{ role: "user", content: messageText(sent), timestamp: Date.now() }],
      },
      {
        // The model's own reply limit, or (none known) none sent (goal 079).
        ...(cfg.maxTokens ? { maxTokens: cfg.maxTokens } : {}),
        ...(signal ? { signal } : {}),
        ...(thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
        ...(meter ? { fetch: meter.fetch } : {}),
      },
    );
    meter?.reply(reply);
    if (reply.stopReason === "error" || reply.stopReason === "aborted")
      throw new Error(reply.errorMessage ?? `the call ended: ${reply.stopReason}`);
    return textOf(reply.content);
  };
}
