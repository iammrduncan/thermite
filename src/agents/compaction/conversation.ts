import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The conversations Claude Code, the Codex CLI and OpenCode v2 keep of their own (goal 070), as
 * Thermite's own code reads them when one of them compacts: Claude Code's transcript and Codex's
 * rollout (JSON lines), and OpenCode's session messages as Thermite's plugin saved them. Each
 * becomes Markdown, as Pi's kept conversations are: every message and tool result, in order.
 *
 * The agent's own user writes these files, so they are data: read only as regular files, never
 * through a link or from a pipe, and at most OWN_MAX bytes. This module imports nothing of
 * Thermite's, so Claude Code's hook (programs/claude-code/compaction-hook.ts) loads it alone.
 */

/** The most of a CLI's own conversation file read, in bytes. */
export const OWN_MAX = 64 * 1024 * 1024;

/**
 * A regular file's text, read without following a link and without waiting on a pipe; at most
 * `max` bytes (a longer file is cut at its last whole line before that). Undefined when it is
 * missing or not a regular file.
 */
export function readOwn(path: string, max = OWN_MAX): string | undefined {
  return readFd(path, max);
}

/** A safe name of one part of a path: no separator, and not `.` or `..`. */
const safePart = (p: string): boolean => Boolean(p) && p !== "." && p !== ".." && !p.includes("/");

/**
 * A regular file under `root`, by the parts of its path, read as readOwn reads: no part of it may
 * be a link, so a folder the agent's user owns cannot send Thermite's code to read elsewhere. The
 * file is opened first, then its path is checked to be the one asked for and the same file.
 */
export function readUnder(root: string, parts: string[], max = OWN_MAX): string | undefined {
  if (!parts.length || !parts.every(safePart)) return undefined;
  const path = join(root, ...parts);
  let base: string;
  try {
    base = realpathSync(root);
  } catch {
    return undefined;
  }
  return readFd(path, max, (fd) => {
    try {
      const st = fstatSync(fd);
      const now = statSync(path);
      return (
        realpathSync(path) === join(base, ...parts) && now.ino === st.ino && now.dev === st.dev
      );
    } catch {
      return false;
    }
  });
}

/** Lists a folder under `root`, as readUnder reads: no part of its path may be a link. */
export function listUnder(root: string, parts: string[]): string[] {
  if (!parts.every(safePart)) return [];
  try {
    const path = join(root, ...parts);
    if (realpathSync(path) !== join(realpathSync(root), ...parts)) return [];
    if (!lstatSync(path).isDirectory()) return [];
    return readdirSync(path).filter(safePart).sort();
  } catch {
    return [];
  }
}

function readFd(path: string, max: number, check?: (fd: number) => boolean): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    if (check && !check(fd)) return undefined;
    const size = Math.min(st.size, max);
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const got = readSync(fd, buf, off, size - off, off);
      if (got <= 0) break;
      off += got;
    }
    const text = buf.subarray(0, off).toString("utf8");
    if (st.size <= max) return text;
    const end = text.lastIndexOf("\n");
    return end >= 0 ? text.slice(0, end + 1) : "";
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Each line of JSON lines that parses as an object, in order; other lines are left out. */
export function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      // A line cut short, or not JSON: not part of the conversation.
    }
  }
  return out;
}

/** A fence for a block of text: longer than any run of backticks inside it. */
export function fenced(text: string, lang = "text"): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** JSON as a block, cut to `max` characters. */
function json(v: unknown, max = 20_000): string {
  let s: string;
  try {
    s = JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}\n[… cut: ${s.length - max} more characters]` : s;
}

/** A tool call's arguments: JSON shown as JSON, other text as it is. */
function args(v: unknown): string {
  if (typeof v === "string") {
    try {
      return fenced(json(JSON.parse(v)), "json");
    } catch {
      return fenced(v);
    }
  }
  return fenced(json(v), "json");
}

/** The text of a content value: a string, or the text parts of a list of parts. */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  return arr(v)
    .map((p) => {
      const o = obj(p);
      const t = str(o.type);
      if (typeof o.text === "string") return o.text;
      if (t === "image" || t === "input_image") return "[an image]";
      if (t) return `[${t}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** The document's head: whose conversation, which compaction, and where it came from. */
function head(title: string, n: number, from: string): string[] {
  return [
    `# ${title}: the conversation before compaction ${n}`,
    "",
    `Kept by Thermite at ${new Date().toISOString()}, from ${from}. Every message and tool result, in order.`,
  ];
}

/** Markdown from numbered sections. */
class Sections {
  readonly lines: string[];
  private k = 0;
  constructor(lines: string[]) {
    this.lines = lines;
  }
  add(heading: string, ...body: string[]): void {
    this.k++;
    this.lines.push("", `## ${this.k}. ${heading}`, ...body.flatMap((b) => ["", b]));
  }
  /** More of the last section, under its heading. */
  more(...body: string[]): void {
    this.lines.push(...body.flatMap((b) => ["", b]));
  }
  get text(): string {
    return `${this.lines.join("\n")}\n`;
  }
}

// ---------------------------------------------------------------- Claude Code

/** Whether a line of Claude Code's transcript is one of its compaction boundaries. */
export const isClaudeBoundary = (e: Record<string, unknown>): boolean =>
  e.type === "system" && e.subtype === "compact_boundary";

/**
 * Claude Code's transcript (`~/.claude/projects/<project>/<session>.jsonl`) as Markdown: each
 * user and assistant message with its text, thinking, tool calls and tool results, and each
 * earlier compaction where it came, with the summary Claude Code went on from.
 */
export function claudeTranscriptMarkdown(title: string, n: number, jsonl: string): string {
  const s = new Sections(head(title, n, "Claude Code's own transcript of the session"));
  const tools = new Map<string, string>();
  let lastAssistant: string | undefined;
  for (const e of jsonLines(jsonl)) {
    const m = obj(e.message);
    if (e.type === "assistant") {
      const id = str(m.id) || undefined;
      const blocks = arr(m.content).map(obj);
      const body: string[] = [];
      for (const b of blocks) {
        if (b.type === "text" && str(b.text)) body.push(fenced(str(b.text)));
        else if (b.type === "thinking" && str(b.thinking))
          body.push("Thinking:", fenced(str(b.thinking)));
        else if (b.type === "tool_use") {
          const name = str(b.name) || "tool";
          if (str(b.id)) tools.set(str(b.id), name);
          body.push(`Tool call \`${name}\` (${str(b.id) || "?"}):`, args(b.input ?? {}));
        }
      }
      if (typeof m.content === "string" && m.content) body.push(fenced(m.content));
      if (!body.length) continue;
      if (id && id === lastAssistant) s.more(...body);
      else s.add("Assistant", ...body);
      lastAssistant = id;
      continue;
    }
    lastAssistant = undefined;
    if (e.type === "user") {
      if (e.isCompactSummary === true) {
        s.add("The summary Claude Code went on from", fenced(textOf(m.content)));
        continue;
      }
      if (typeof m.content === "string") {
        s.add("User", fenced(m.content));
        continue;
      }
      for (const b of arr(m.content).map(obj)) {
        if (b.type === "tool_result") {
          const id = str(b.tool_use_id);
          s.add(
            `Tool result: ${tools.get(id) ?? "tool"} (${id || "?"})${b.is_error === true ? ", an error" : ""}`,
            fenced(textOf(b.content)),
          );
        } else {
          const t = textOf([b]);
          if (t) s.add("User", fenced(t));
        }
      }
      continue;
    }
    if (isClaudeBoundary(e)) {
      const c = obj(e.compactMetadata ?? e.compact_metadata);
      const pre = c.preTokens ?? c.pre_tokens;
      s.add(
        `Claude Code compacted the conversation here${typeof pre === "number" ? `, at about ${pre.toLocaleString("en-US")} tokens` : ""}`,
      );
    }
  }
  return s.text;
}

/**
 * The summary Claude Code went on from after its compaction `n`: the first message marked as a
 * compaction's summary after its `n`th boundary. Undefined when the transcript has none yet.
 */
export function claudeSummary(jsonl: string, n: number): string | undefined {
  let seen = 0;
  for (const e of jsonLines(jsonl)) {
    if (isClaudeBoundary(e)) seen++;
    else if (seen === n && e.type === "user" && e.isCompactSummary === true)
      return textOf(obj(e.message).content).trim() || undefined;
    else if (seen > n) return undefined;
  }
  return undefined;
}

/** The tokens Claude Code said its conversation had at its `n`th compaction, if it said. */
export function claudeTokensBefore(jsonl: string, n: number): number | undefined {
  const b = jsonLines(jsonl).filter(isClaudeBoundary)[n - 1];
  const c = obj(b?.compactMetadata ?? b?.compact_metadata);
  const pre = c.preTokens ?? c.pre_tokens;
  return typeof pre === "number" ? pre : undefined;
}

/** How many compactions a Claude Code transcript shows. */
export const claudeCompactions = (jsonl: string): number =>
  jsonLines(jsonl).filter(isClaudeBoundary).length;

/**
 * The lines of a Claude Code transcript before its `n`th compaction boundary (all of it when it
 * has fewer), as JSON lines.
 */
export function claudeBefore(jsonl: string, n: number): string {
  const out: string[] = [];
  let seen = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      if (isClaudeBoundary(obj(JSON.parse(line))) && ++seen === n) break;
    } catch {
      // not JSON: kept as it is, and left out when the document is made
    }
    out.push(line);
  }
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------- Codex

/** Whether a line of a Codex rollout is one of its compactions. */
const isCodexCompacted = (e: Record<string, unknown>): boolean => e.type === "compacted";

/**
 * A Codex rollout's lines before its `n`th compaction (all of them when it has fewer), and that
 * compaction's summary when the rollout has it.
 */
export function codexBefore(
  jsonl: string,
  n: number,
): { lines: Record<string, unknown>[]; summary: string | undefined } {
  const lines: Record<string, unknown>[] = [];
  let seen = 0;
  for (const e of jsonLines(jsonl)) {
    if (isCodexCompacted(e) && ++seen === n)
      return { lines, summary: str(obj(e.payload).message).trim() || undefined };
    lines.push(e);
  }
  return { lines, summary: undefined };
}

/** How many compactions a Codex rollout shows. */
export const codexCompactions = (jsonl: string): number =>
  jsonLines(jsonl).filter(isCodexCompacted).length;

/** A function call's output, as Codex records it: text, or a list of content items. */
function codexOutput(v: unknown): string {
  if (typeof v === "string") return v;
  const o = obj(v);
  if (typeof o.content === "string") return o.content;
  if (Array.isArray(o.content)) return textOf(o.content);
  if (Array.isArray(v)) return textOf(v);
  return json(v);
}

/**
 * A Codex rollout (`$CODEX_HOME/sessions/…/rollout-…-<thread>.jsonl`) as Markdown: each message,
 * each reasoning summary, each tool call and its output, and each earlier compaction with its
 * summary. Codex's own records of the session (its settings, its events) are left out.
 */
export function codexRolloutMarkdown(
  title: string,
  n: number,
  lines: Record<string, unknown>[],
): string {
  const s = new Sections(head(title, n, "the Codex CLI's own rollout of the thread"));
  for (const e of lines) {
    const p = obj(e.payload);
    if (isCodexCompacted(e)) {
      s.add(
        "Codex compacted the conversation here; the summary it went on from",
        fenced(str(p.message)),
      );
      continue;
    }
    if (e.type !== "response_item") continue;
    switch (p.type) {
      case "message": {
        const role = str(p.role);
        const text = textOf(p.content);
        if (!text) break;
        s.add(
          role === "assistant"
            ? "Assistant"
            : role === "user"
              ? "User"
              : `Instructions (${role || "?"})`,
          fenced(text),
        );
        break;
      }
      case "reasoning": {
        const text = textOf(p.summary);
        if (text) s.add("Thinking (its summary)", fenced(text));
        break;
      }
      case "function_call":
        s.add(
          `Tool call \`${str(p.name) || "tool"}\` (${str(p.call_id) || "?"})`,
          args(p.arguments),
        );
        break;
      case "custom_tool_call":
        s.add(`Tool call \`${str(p.name) || "tool"}\` (${str(p.call_id) || "?"})`, args(p.input));
        break;
      case "function_call_output":
      case "custom_tool_call_output":
        s.add(`Tool result (${str(p.call_id) || "?"})`, fenced(codexOutput(p.output)));
        break;
      case "local_shell_call":
        s.add(`Shell (${str(p.call_id) || "?"})`, args(obj(p.action).command ?? p.action));
        break;
      default:
        if (typeof p.type === "string")
          s.add(p.type.replace(/_/g, " "), fenced(json(p, 4000), "json"));
    }
  }
  return s.text;
}

/**
 * The rollout of thread `thread` (else the newest) under a Codex home's sessions folder
 * (`sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`), as the parts of its path under `root`, found
 * as listUnder lists; undefined when there is none.
 */
export function findCodexRollout(
  root: string,
  codexHome: string[],
  thread?: string | undefined,
): string[] | undefined {
  if (thread !== undefined && !/^[A-Za-z0-9-]{1,100}$/.test(thread)) return undefined;
  const found: string[][] = [];
  const visit = (parts: string[], depth: number): void => {
    for (const name of listUnder(root, parts)) {
      if (/^rollout-.*\.jsonl$/.test(name)) {
        if (!thread || name.endsWith(`-${thread}.jsonl`)) found.push([...parts, name]);
      } else if (depth < 3 && /^\d+$/.test(name)) visit([...parts, name], depth + 1);
    }
  };
  visit([...codexHome, "sessions"], 0);
  return found.at(-1);
}

// ---------------------------------------------------------------- OpenCode

/**
 * What Thermite's OpenCode plugin keeps before each compaction (`<n>.json` in its folder): the
 * session's messages since its last compaction, the earlier compaction's summary first.
 */
export interface OpencodeDrop {
  session?: string | undefined;
  messages: unknown[];
}

/** A tool's state in OpenCode's message: its input, and its output or error. */
function opencodeTool(t: Record<string, unknown>): string[] {
  const st = obj(t.state);
  const out = [
    `Tool call \`${str(t.name) || "tool"}\` (${str(t.id) || "?"}), ${str(st.status) || "?"}:`,
    args(st.input ?? {}),
  ];
  const content = textOf(st.content);
  if (content) out.push("Its result:", fenced(content));
  const err = obj(st.error);
  if (str(err.message)) out.push(`Its error: ${str(err.message)}`);
  return out;
}

/**
 * OpenCode's session as Markdown, from what its plugin kept before each compaction up to `n`:
 * each part opens with the earlier compaction's summary (OpenCode's session holds the messages
 * since its last compaction), so together they are the whole conversation.
 */
export function opencodeSessionMarkdown(title: string, n: number, drops: OpencodeDrop[]): string {
  const s = new Sections(
    head(title, n, "OpenCode's own session, as Thermite's plugin saved it before each compaction"),
  );
  drops.forEach((d, i) => {
    if (i > 0) s.add(`OpenCode compacted the conversation here (compaction ${i})`);
    for (const raw of d.messages) {
      const m = obj(raw);
      switch (m.type) {
        case "user":
          s.add("User", fenced(str(m.text)));
          break;
        case "synthetic":
        case "system":
          if (str(m.text))
            s.add(m.type === "system" ? "System" : "Added by OpenCode", fenced(str(m.text)));
          break;
        case "skill":
          s.add(`Skill ${str(m.name) || "?"}`, fenced(str(m.text)));
          break;
        case "shell":
          s.add(
            `Shell: ${str(m.command)}`,
            fenced(typeof m.output === "string" ? m.output : json(m.output ?? "")),
          );
          break;
        case "assistant": {
          const body: string[] = [];
          for (const c of arr(m.content).map(obj)) {
            if (c.type === "text" && str(c.text)) body.push(fenced(str(c.text)));
            else if (c.type === "reasoning" && str(c.text))
              body.push("Thinking:", fenced(str(c.text)));
            else if (c.type === "tool") body.push(...opencodeTool(c));
          }
          const err = obj(m.error);
          if (str(err.message)) body.push(`(The reply ended with an error: ${str(err.message)})`);
          if (body.length) s.add("Assistant", ...body);
          break;
        }
        case "compaction":
          if (str(m.summary))
            s.add(
              "The summary OpenCode went on from",
              fenced(str(m.summary)),
              ...(str(m.recent)
                ? ["The recent conversation it kept beside it:", fenced(str(m.recent))]
                : []),
            );
          break;
        default:
          // OpenCode's own records (the agent or model chosen, an idle marker): not the conversation.
          break;
      }
    }
  });
  return s.text;
}

// ---------------------------------------------------------------- the program's own conversation

/** A CLI's own conversation before one compaction, as Markdown, and its summary when known. */
export interface Own {
  markdown: string;
  summary?: string | undefined;
  /** The conversation's tokens before the compaction, when the program's records say. */
  tokensBefore?: number | undefined;
}

/** A session's or a thread's id, as the CLIs make them: never a path. */
const isId = (s: string | undefined): s is string => !!s && /^[A-Za-z0-9_-]{1,100}$/.test(s);

/**
 * Claude Code's live transcript under its home (`<home>/.claude/projects/<project>/`): the
 * session's, else (`session` unknown) the first one there.
 */
export function claudeTranscript(
  root: string,
  home: string[],
  session?: string | undefined,
): string | undefined {
  const projects = [...home, ".claude", "projects"];
  for (const p of listUnder(root, projects)) {
    const names = isId(session)
      ? [`${session}.jsonl`]
      : listUnder(root, [...projects, p]).filter((f) => f.endsWith(".jsonl"));
    for (const name of names) {
      const t = readUnder(root, [...projects, p, name]);
      if (t !== undefined) return t;
    }
  }
  return undefined;
}

/**
 * Claude Code's own conversation before compaction `n`: the copy its PreCompact hook made in
 * `drops` (programs/claude-code/compaction-hook.ts), else its transcript up to that compaction;
 * with the summary it went on from, as its PostCompact hook kept it, else from its transcript.
 * Claude Code keeps its transcript private to the agent's user, so in a trial only the hooks'
 * copies are readable; an advisor's runs as the supervisor's own user. All under `root`, read
 * with readUnder.
 */
export function claudeOwn(o: {
  root: string;
  drops: string[];
  home: string[];
  title: string;
  session?: (() => string | undefined) | undefined;
}): (n: number) => Own | undefined {
  return (n) => {
    const transcript = claudeTranscript(o.root, o.home, o.session?.());
    const before =
      readUnder(o.root, [...o.drops, `${n}.jsonl`]) ??
      (transcript !== undefined && claudeCompactions(transcript) >= n
        ? claudeBefore(transcript, n)
        : undefined);
    if (before === undefined) return undefined;
    const kept = readUnder(o.root, [...o.drops, `${n}.summary.md`])?.trim();
    return {
      markdown: claudeTranscriptMarkdown(o.title, n, before),
      summary: kept || (transcript !== undefined ? claudeSummary(transcript, n) : undefined),
      tokensBefore: transcript !== undefined ? claudeTokensBefore(transcript, n) : undefined,
    };
  };
}

/**
 * Codex's own conversation before compaction `n`: its rollout of the thread (in its home under
 * `root`) up to that compaction, with the summary it went on from.
 */
export function codexOwn(o: {
  root: string;
  home: string[];
  title: string;
  thread?: (() => string | undefined) | undefined;
}): (n: number) => Own | undefined {
  return (n) => {
    const parts = findCodexRollout(o.root, o.home, o.thread?.());
    const text = parts ? readUnder(o.root, parts) : undefined;
    if (text === undefined) return undefined;
    const { lines, summary } = codexBefore(text, n);
    if (!lines.length) return undefined;
    return { markdown: codexRolloutMarkdown(o.title, n, lines), summary };
  };
}

/** A JSON object read from a file under `root`, or undefined. */
function readJson(root: string, parts: string[]): Record<string, unknown> | undefined {
  const t = readUnder(root, parts);
  if (t === undefined) return undefined;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The compactions OpenCode's plugin saw end (`<n>.done.json` in `drops`), by number, in order. */
export function opencodeEnded(root: string, drops: string[]): number[] {
  return listUnder(root, drops)
    .map((f) => /^(\d+)\.done\.json$/.exec(f)?.[1])
    .filter((x): x is string => x !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * OpenCode's own conversation before compaction `n`: what Thermite's plugin kept before each
 * compaction up to `n` (programs/opencode/plugin.ts), with the summary it saw at the end of
 * compaction `n`.
 */
export function opencodeOwn(o: {
  root: string;
  drops: string[];
  title: string;
}): (n: number) => Own | undefined {
  return (n) => {
    const kept: OpencodeDrop[] = [];
    for (let k = 1; k <= n; k++) {
      const d = readJson(o.root, [...o.drops, `${k}.json`]);
      if (!d || !Array.isArray(d.messages)) {
        if (k === n) return undefined;
        continue;
      }
      kept.push({ session: str(d.session) || undefined, messages: d.messages });
    }
    const done = readJson(o.root, [...o.drops, `${n}.done.json`]);
    return {
      markdown: opencodeSessionMarkdown(o.title, n, kept),
      summary: str(done?.summary).trim() || undefined,
    };
  };
}
