import { type LiveKind, liveText, summarizeArgs } from "../../../core/live.ts";
import { type CallUsage, callUsage } from "../../../core/usage.ts";
import type { FoundCompaction } from "../../compaction/index.ts";

/** The Codex CLI's JSON output (`codex exec --json`), read into a tally of turns, calls and usage. */

/** What the Codex CLI's JSON output (`codex exec --json`) has said so far. */
export interface CodexTally {
  /** Each message and each tool call the model made is one turn. */
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** The thread's id, which `codex exec resume` takes. */
  session?: string | undefined;
  errors: string[];
  lastText: string;
  /** Completed tool calls: their tool and what they returned (the model check reads these). */
  tools: { tool: string; output: string; ok: boolean }[];
  /** Its last lines that were not JSON, and its non-fatal error items. */
  notes: string[];
  /** Items already shown as started in the live view. */
  started: Set<string>;
  /** Compactions it reported since they were last taken (goal 070). */
  compactions: FoundCompaction[];
  /** Each turn's model usage, since they were last taken (goal 075). */
  calls: CallUsage[];
  /** The thread's totals at its last completed turn, and when the turn under way started. */
  totals?: CodexUsage | undefined;
  turnAt?: number | undefined;
}

export const newCodexTally = (): CodexTally => ({
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  errors: [],
  lastText: "",
  tools: [],
  notes: [],
  started: new Set(),
  compactions: [],
  calls: [],
});

/** The usage a `turn.completed` gives (codex exec's Usage): the thread's totals so far. */
interface CodexUsage {
  /** Every input token, the cached ones included. */
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  /** Every output token, the reasoning ones included. */
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/**
 * A turn's usage (goal 075): what the thread's totals grew by since its last turn (Codex keeps the
 * totals when a thread is resumed), or the totals themselves for a new thread, whose totals start
 * again. A turn makes one or more model calls and Codex says neither how many nor how long they
 * took: those are not reported.
 */
function turnUsage(now: CodexUsage, was: CodexUsage | undefined, at: number): CallUsage {
  const keys = [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
  ] as const;
  const grew = was !== undefined && keys.every((k) => (now[k] ?? 0) >= (was[k] ?? 0));
  const less = (k: (typeof keys)[number]) =>
    now[k] === undefined ? null : now[k] - (grew ? (was?.[k] ?? 0) : 0);
  return callUsage({
    at,
    calls: null,
    tokensIn: less("input_tokens") ?? 0,
    cachedIn: less("cached_input_tokens"),
    tokensOut: less("output_tokens") ?? 0,
    reasoning: less("reasoning_output_tokens"),
    firstTokenMs: null,
    callMs: null,
  });
}

type Item = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: { path?: string; kind?: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown[] } | null;
  error?: { message?: string } | null;
  query?: string;
  message?: string;
};
type Event = {
  type?: string;
  thread_id?: string;
  item?: Item;
  usage?: CodexUsage;
  error?: { message?: string };
  message?: string;
};

/** A tool item's name and the line the live view shows when it starts. */
function toolOf(i: Item): { tool: string; call: string } | undefined {
  switch (i.type) {
    case "command_execution":
      return { tool: "shell", call: `shell ${String(i.command ?? "")}` };
    case "file_change": {
      const paths = (i.changes ?? []).map((c) => `${c.kind ?? "update"} ${c.path ?? ""}`);
      return { tool: "apply_patch", call: `apply_patch ${paths.join(", ")}` };
    }
    case "mcp_tool_call": {
      const tool = `${i.server ?? "mcp"}.${i.tool ?? "tool"}`;
      return { tool, call: `${tool} ${summarizeArgs(i.arguments)}` };
    }
    case "web_search":
      return { tool: "web_search", call: `web_search ${String(i.query ?? "")}` };
    case "agent_message":
    case "reasoning":
    case "todo_list":
    case "error":
    case undefined:
      return undefined;
    default:
      return { tool: i.type, call: i.type };
  }
}

/** What a completed tool item returned, and whether it worked. */
function resultOf(i: Item): { output: string; ok: boolean } {
  switch (i.type) {
    case "command_execution":
      return {
        output: String(i.aggregated_output ?? ""),
        ok: i.status === "completed" && (i.exit_code ?? 0) === 0,
      };
    case "file_change":
      return {
        output: (i.changes ?? []).map((c) => `${c.kind ?? "update"} ${c.path ?? ""}`).join("\n"),
        ok: i.status === "completed",
      };
    case "mcp_tool_call":
      return {
        output: i.error?.message ?? summarizeArgs(i.result?.content ?? [], 4000),
        ok: i.status === "completed" && !i.error,
      };
    default:
      return { output: String(i.query ?? i.status ?? ""), ok: i.status !== "failed" };
  }
}

/**
 * The warning the Codex CLI gives (as an error item in `codex exec --json`) once it has compacted
 * its conversation on its own, as it does for a provider other than OpenAI's own: the only sign of
 * a compaction in its JSON output.
 */
export const CODEX_COMPACTED =
  /Long threads and multiple compactions can cause the model to be less accurate/;

/** Reads lines of the Codex CLI's JSON output into the tally; returns them as live-view lines. */
export function readCodexEvents(
  lines: string[],
  t: CodexTally,
): { kind: LiveKind; text: string }[] {
  const live: { kind: LiveKind; text: string }[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: Event;
    try {
      e = JSON.parse(line) as Event;
    } catch {
      t.notes = [...t.notes, line.slice(0, 500)].slice(-5);
      continue;
    }
    switch (e.type) {
      case "thread.started":
        if (e.thread_id) t.session = e.thread_id;
        break;
      case "turn.started":
        t.turnAt = Date.now();
        break;
      case "item.started": {
        const i = e.item ?? {};
        const tool = toolOf(i);
        if (!tool) break;
        if (i.id) t.started.add(i.id);
        live.push({ kind: "tool", text: liveText(tool.call) });
        break;
      }
      case "item.completed": {
        const i = e.item ?? {};
        if (i.type === "agent_message") {
          t.turns++;
          if (i.text) {
            t.lastText = i.text;
            live.push({ kind: "text", text: liveText(i.text) });
          }
          break;
        }
        if (i.type === "reasoning") {
          if (i.text) live.push({ kind: "thinking", text: liveText(i.text) });
          break;
        }
        if (i.type === "error") {
          const message = String(i.message ?? "error").slice(0, 500);
          // The warning Codex gives after each compaction of its own conversation (goal 070): no
          // tokens are said. The compaction is recorded in words instead of the warning.
          if (CODEX_COMPACTED.test(message)) {
            t.compactions.push({ at: live.length, tokensBefore: null, tokensAfter: null });
            break;
          }
          t.notes = [...t.notes, message].slice(-5);
          live.push({ kind: "text", text: `(Codex: ${message})` });
          break;
        }
        const tool = toolOf(i);
        if (!tool) break;
        t.turns++;
        t.toolCalls++;
        // A file change is only ever completed; an item may also end without having started.
        if (!i.id || !t.started.delete(i.id))
          live.push({ kind: "tool", text: liveText(tool.call) });
        const r = resultOf(i);
        t.tools.push({ tool: tool.tool, output: r.output.slice(0, 4000), ok: r.ok });
        live.push({
          kind: "result",
          text: `${tool.tool}${r.ok ? "" : " failed"}: ${r.output.slice(0, 1200)}`,
        });
        break;
      }
      // The thread's tokens so far: Codex keeps the total when a thread is resumed.
      case "turn.completed": {
        t.tokensIn = Math.max(t.tokensIn, e.usage?.input_tokens ?? 0);
        t.tokensOut = Math.max(t.tokensOut, e.usage?.output_tokens ?? 0);
        const now = e.usage ?? {};
        t.calls.push(turnUsage(now, t.totals, t.turnAt ?? Date.now()));
        t.totals = now;
        t.turnAt = undefined;
        break;
      }
      case "turn.failed":
      case "error": {
        const message = String(e.error?.message ?? e.message ?? "error").slice(0, 500);
        t.errors.push(message);
        live.push({ kind: "text", text: `(Codex: ${message})` });
        break;
      }
    }
  }
  return live;
}
