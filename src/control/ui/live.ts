import { ago, esc } from "./components/index.ts";

/**
 * The live view's lines, formatted once here for the page and for the lines its server-sent
 * events bring (`<page>/live/stream`), so a line reads the same whichever brought it. Each line
 * has its time. A tool call reads as what it did (the command, the file), not as its JSON
 * arguments, and its result as exit code, duration and the first line of output; everything else
 * is one click away.
 */

export interface LiveEntry {
  id: number;
  at: string;
  source: string;
  lane?: string | null | undefined;
  kind: string;
  text: string;
  signed?: boolean | undefined;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string) => s.split("\n").find((l) => l.trim()) ?? "";

/** The time a line happened: HH:MM:SS UTC, with the date and how long ago on hover. */
export function liveTime(at: string, now = Date.now()): string {
  return `<span class="lv-t" title="${esc(at.replace("T", " ").slice(0, 19))} UTC · ${esc(ago(at, now))} ago">${esc(at.slice(11, 19))}</span>`;
}

/**
 * The string fields of a JSON object cut short (a rig cuts a long tool call's arguments to a
 * line's room, so its JSON may not close): each `"key":"value"` whole, and the last one as far as
 * it goes.
 */
function cutObject(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith("{")) return null;
  const out: Record<string, unknown> = {};
  const field = /"([A-Za-z_][\w-]*)"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g;
  for (let m = field.exec(raw); m; m = field.exec(raw)) {
    const body = m[3]
      ? (m[2] ?? "")
      : (m[2] ?? "").replace(/…$/, "").replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
    try {
      out[m[1] as string] = `${JSON.parse(`"${body}"`)}${m[3] ? "" : "…"}`;
    } catch {
      out[m[1] as string] = body;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** A tool call's name and arguments, from "name {json}" (or "name text"). */
export function parseTool(text: string): {
  name: string;
  args: Record<string, unknown> | null;
  raw: string;
} {
  const sp = text.indexOf(" ");
  const name = sp > 0 ? text.slice(0, sp) : text;
  const raw = sp > 0 ? text.slice(sp + 1) : "";
  try {
    const v = JSON.parse(raw);
    return { name, args: v && typeof v === "object" && !Array.isArray(v) ? v : null, raw };
  } catch {
    return { name, args: cutObject(raw.trim()), raw };
  }
}

/** A tool's name as Live shows it: an MCP tool without its server's prefix. */
const toolName = (name: string) =>
  name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "").replace(/^[a-z0-9_-]+\.(?=[a-z])/i, "");

/** A shell's own wrapper around a command (`bash -lc '…'`), taken off. */
const unwrapShell = (c: string) =>
  /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(c.trim())?.[2] ?? c;

const SHELLS = /^(shell|bash|exec|exec_command|run|sh|terminal|local_shell)$/i;

const lines = (s: string) => s.split("\n").length;
const more = (n: number) => (n > 1 ? ` <span class="muted xs">+${n - 1} lines</span>` : "");
const code = (s: string, n = 120) => `<code>${esc(clip(s, n))}</code>`;
const muted = (s: string) => ` <span class="muted xs">${esc(s)}</span>`;

/**
 * What a tool call did, in a few words, and its full input for the details: a command as `$ …`,
 * a file it read, wrote or edited, what it searched for and where, a page it fetched, a search's
 * words; else its arguments as key=value.
 */
export function toolSummary(text: string): { name: string; what: string; detail: string } {
  const parsed = parseTool(text);
  const { args, raw } = parsed;
  const name = toolName(parsed.name);
  const command = (c: string) => {
    const cmd = unwrapShell(c);
    return {
      name,
      what: `<code class="lv-cmd">$ ${esc(clip(firstLine(cmd), 160))}</code>${more(lines(cmd))}`,
      detail: cmd,
    };
  };
  if (!args) {
    if (SHELLS.test(name) && raw.trim()) return command(raw);
    if (/search/i.test(name) && raw.trim() && !raw.trim().startsWith("{"))
      return { name, what: `“${esc(clip(firstLine(raw), 140))}”`, detail: raw };
    return { name, what: esc(clip(firstLine(raw), 140)), detail: raw };
  }
  const str = (...ks: string[]) => {
    for (const k of ks) if (typeof args[k] === "string" && args[k]) return args[k] as string;
    return undefined;
  };
  const all = JSON.stringify(args, null, 2);
  const cmd = str("command", "cmd", "script");
  if (cmd) return command(cmd);
  if (Array.isArray(args.command) && args.command.every((x) => typeof x === "string"))
    return command((args.command as string[]).join(" "));
  const path = str("file_path", "filePath", "path", "file", "notebook_path");
  const content = str("content", "text");
  const before = str("old_string", "oldString", "old_str");
  const after = str("new_string", "newString", "new_str");
  if (path && (before !== undefined || after !== undefined))
    return {
      name,
      what: `edits ${code(path)}${muted(`−${before ? lines(before) : 0} +${after ? lines(after) : 0} lines`)}`,
      detail: `${before ?? ""}\n──── becomes ────\n${after ?? ""}`,
    };
  if (path && content !== undefined)
    return {
      name,
      what: `writes ${code(path)} <span class="muted xs">${lines(content)} lines</span>`,
      detail: content,
    };
  const pattern = str("pattern", "regex", "glob");
  if (pattern)
    return {
      name,
      what: `${code(pattern, 80)}${path ? ` in ${code(path, 80)}` : ""}${str("glob", "include") && str("glob", "include") !== pattern ? muted(String(str("glob", "include"))) : ""}`,
      detail: all,
    };
  if (path) {
    const from = typeof args.offset === "number" ? args.offset : undefined;
    const n = typeof args.limit === "number" ? args.limit : undefined;
    return {
      name,
      what: `${code(path)}${from !== undefined || n !== undefined ? muted(`lines ${from ?? 1}${n ? `–${(from ?? 1) + n - 1}` : "–"}`) : ""}`,
      detail: all,
    };
  }
  const url = str("url", "uri");
  if (url) return { name, what: code(url, 140), detail: all };
  const query = str("query", "q", "search", "question");
  if (query) return { name, what: `“${esc(clip(query, 140))}”`, detail: all };
  if (Array.isArray(args.todos)) return { name, what: `${args.todos.length} to-dos`, detail: all };
  const about = str("description", "title", "subject");
  if (about) return { name, what: esc(clip(about, 140)), detail: all };
  const pairs = Object.entries(args)
    .map(([k, v]) => `${k}=${clip(typeof v === "string" ? v : JSON.stringify(v), 60)}`)
    .join(" · ");
  return { name, what: esc(clip(pairs, 160)), detail: all };
}

/** A tool result: how long, whether it worked (exit code), and its first line of output. */
export function resultSummary(text: string): { hint: string; detail: string } {
  const m = /^(\S+)( failed)? \((\d+) ms\): ?([\s\S]*)$/.exec(text);
  if (!m) return { hint: "", detail: text };
  const ms = Number(m[3]);
  const took = ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
  const body = m[4] ?? "";
  let exit: number | null = null;
  let out = body;
  try {
    const v = JSON.parse(body) as Record<string, unknown>;
    if (v && typeof v === "object") {
      if (typeof v.exit === "number") exit = v.exit;
      const parts = [v.stdout, v.stderr, v.output].filter((x) => typeof x === "string" && x.trim());
      out = parts.join("\n");
      if (v.killed) out = `killed: ${String(v.killed)}\n${out}`;
    }
  } catch {
    const e = /^exit (\d+)/.exec(body);
    if (e) exit = Number(e[1]);
  }
  const bad = Boolean(m[2]) || (exit !== null && exit !== 0);
  const first = clip(firstLine(out.replace(/^exit \d+\s*/, "")), 90);
  const hint = `<span class="lv-res ${bad ? "bad" : "muted"}">${took}${exit !== null ? ` · exit ${exit}` : m[2] ? " · failed" : ""}${first ? ` · ${esc(first)}` : ""}</span>`;
  return { hint, detail: out || body };
}

/** Who a line is from, in the interleaved view. */
/**
 * The kind of agent a line's source is, for its colour on Live (goal 188): a lane's trial, the
 * planner, the judge, a teacher, the merged by model, the auditor, a reviewer of the review panel,
 * a research writer, or an advisor of another kind and the supervisor's own lines.
 */
export function agentKind(source: string): string {
  if (source.startsWith("trial:")) return "lane";
  if (source === "planner" || source === "judge") return source;
  const name = source.startsWith("advisor:") ? source.slice(8) : "";
  if (/^teacher/.test(name)) return "teacher";
  if (name === "merged-by") return "merger";
  if (name === "auditor") return "auditor";
  if (/^(review|reviewer)/.test(name)) return "reviewer";
  if (name === "synthesizer" || name === "final-writer") return "writer";
  return "advisor";
}

/** An advisor's name as Live shows it: the merged by model is the merger. */
export const advisorLabel = (name: string): string =>
  name === "merged-by" ? "merger" : name === "final-writer" ? "final writer" : name;

const whoOf = (e: LiveEntry, name: (source: string, lane?: string | null) => string) =>
  `<span class="lv-who k-${agentKind(e.source)}">${esc(name(e.source, e.lane))}${e.source.startsWith("trial:") ? ` <span class="muted">${esc(e.source.slice(6, 16))}</span>` : ""}</span>`;

/**
 * One line as HTML. A tool call opens a row its result joins (data-open); a result that finds
 * no open call stands alone.
 */
export function liveEntryHtml(
  e: LiveEntry,
  o: {
    showWho: boolean;
    name: (source: string, lane?: string | null) => string;
    now?: number;
    /** Agents' text as paragraphs, with **bold** and `code` (the run's Live page). */
    md?: boolean;
  },
): string {
  const t = liveTime(e.at, o.now);
  const who = o.showWho ? whoOf(e, o.name) : "";
  const unsigned =
    !e.signed && e.source !== "supervisor" && !e.source.startsWith("advisor:")
      ? `<span class="lv-unsigned">unsigned</span>`
      : "";
  const row = (cls: string, body: string) =>
    `<div class="lv-row ${cls}" data-id="${e.id}">${t}<div class="lv-body">${who}${body}${unsigned}</div></div>`;
  switch (e.kind) {
    case "status":
      return row("lv-status", `<span>${esc(e.text)}</span>`);
    case "text":
      return row(
        "lv-text",
        o.md
          ? `<div class="lv-md">${mdLite(e.text)}</div>`
          : `<div class="lv-said">${esc(e.text)}</div>`,
      );
    case "thinking":
      return row(
        "lv-think",
        `<details><summary>Thinking <span class="muted">· ${esc(clip(firstLine(e.text), 120))}</span></summary><pre>${esc(e.text)}</pre></details>`,
      );
    case "tool": {
      const s = toolSummary(e.text);
      return row(
        "lv-tool",
        `<details data-open="1"><summary><span class="lv-name">${esc(s.name)}</span> ${s.what}<span class="lv-hint"></span></summary><pre>${esc(s.detail)}</pre></details>`,
      );
    }
    case "result": {
      const r = resultSummary(e.text);
      return row(
        "lv-tool",
        `<details><summary><span class="lv-name">result</span> ${r.hint}</summary><pre>${esc(r.detail)}</pre></details>`,
      );
    }
    case "message":
      // A trial's own lines are the agent's, and an unsigned line can claim anything: only the
      // harness's signed lines (planner, supervisor) are shown as the owner's.
      return e.source.startsWith("trial:") || e.signed !== true
        ? row("lv-log", `<span>${esc(e.text)}</span>`)
        : row(
            "lv-msg",
            `<div class="msg"><div class="who">You</div>${esc(e.text.replace(/^Owner( to [^:]+)?(?: \(#\d+[^)]*\))?: /, ""))}</div>`,
          );
    default:
      return row("lv-log", `<span>${esc(e.text)}</span>`);
  }
}

/** A result joined to its call: the hint for the call's summary, the output for its details. */
export function resultJoin(e: LiveEntry): { hint: string; body: string } {
  const r = resultSummary(e.text);
  return { hint: r.hint, body: `<pre class="lv-out">${esc(r.detail)}</pre>` };
}

/** Lines in order, each result joined to the call before it. */
export function liveLinesHtml(
  entries: LiveEntry[],
  o: { showWho: boolean; name: (source: string, lane?: string | null) => string; now?: number },
): string {
  const out: string[] = [];
  let open = -1;
  for (const e of entries) {
    if (e.kind === "result" && open >= 0) {
      const j = resultJoin(e);
      out[open] = (out[open] as string)
        .replace('<span class="lv-hint"></span>', `<span class="lv-hint">${j.hint}</span>`)
        .replace("</pre></details>", `</pre>${j.body}</details>`)
        .replace('data-open="1"', "");
      open = -1;
      continue;
    }
    out.push(liveEntryHtml(e, o));
    open = e.kind === "tool" ? out.length - 1 : -1;
  }
  return out.join("");
}

/** An agent's text, escaped, as paragraphs with **bold**, `code` and line breaks. */
export function mdLite(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p>${esc(p)
          .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
          .replace(/`([^`\n]+)`/g, "<code>$1</code>")
          .replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

/**
 * The harness's line for the owner taking a kept message out of force (unkeep_message): the
 * owner's act, not the advisors'. Only the harness's signed line counts; it is filed under the
 * supervisor's source, with the message's lane when it went to one.
 */
const unkeptLine = (e: LiveEntry) =>
  e.kind === "status" && e.source === "supervisor" && e.signed === true
    ? /^the owner's message #(\d+) is no longer in force$/.exec(e.text)
    : null;

/** The filters a line belongs to on a run's Live page: its lane, planner, judge, advisors, you. */
export function whoTags(e: LiveEntry, to?: string): string {
  const tags = new Set<string>();
  // The owner's message, already checked by the caller against the run's signed events.
  if (to !== undefined) {
    tags.add("you");
    if (/^lane-\d+$/.test(to)) tags.add(to);
    else if (to === "planner") tags.add("planner");
    else if (["advisors", "teachers", "auditor", "review_panel"].includes(to)) tags.add("advisors");
    else if (to === "all") tags.add("all");
    else if (e.source.startsWith("trial:")) tags.add(e.lane ?? "lanes");
    return [...tags].join(" ");
  }
  if (unkeptLine(e)) {
    tags.add("you");
    if (e.lane) tags.add(e.lane);
    return [...tags].join(" ");
  }
  if (e.source.startsWith("trial:")) tags.add(e.lane ?? "lanes");
  else if (e.source === "planner") tags.add("planner");
  else if (e.source === "judge") tags.add("judge");
  else if (e.source === "supervisor") tags.add("advisors");
  else if (e.source.startsWith("advisor:")) {
    // An advisor's own lines (goal 188): its chip, its group's, and all the advisors'.
    const name = e.source.slice(8);
    tags.add("advisors").add(name);
    const kind = agentKind(e.source);
    if (kind === "teacher" || kind === "merger") tags.add("teachers");
    if (kind === "reviewer") tags.add("review_panel");
  }
  return [...tags].join(" ");
}

export const runSourceName = (source: string, lane?: string | null) =>
  source === "planner"
    ? "planner"
    : source === "judge"
      ? "judge"
      : source === "supervisor"
        ? "advisors"
        : source.startsWith("advisor:")
          ? advisorLabel(source.slice(8))
          : (lane ?? "worker");

const RECIPIENT: Record<string, string> = {
  all: "everyone working",
  planner: "the planner",
  advisors: "all the advisors",
  teachers: "the teachers",
  auditor: "the auditor",
  panel: "the review panel",
  review_panel: "the review panel",
};

/**
 * An advisor as a read receipt or an answer names it: a rig's harness of an earlier version wrote
 * "the teacher pair", which Live shows by its name now, the teachers (goal 074).
 */
const advisorName = (said: string | undefined) =>
  said === "the teacher pair" ? "the teachers" : said;

/** The run's owner messages, by id, from its signed events: what message lines are checked against. */
export type RunMessages = ReadonlyMap<number, { to: string; text: string; keep: boolean }>;

/**
 * One line on a run's Live page: tagged with the filters it belongs to (data-who) and its source
 * (data-src, so a result joins its own call). A trial's start and end read as dividers. The
 * owner's message, a read receipt and an advisor's answer show as such only when the harness signed
 * the line: a worker's own line, or the supervisor's unsigned one, can claim anything, so it shows
 * as theirs. The words come from the run's signed event when control has it. A signed line from
 * the harness's own sources (planner, supervisor) shows at once from its own words; one filed
 * under a trial waits for the event (a rig on an older harness let trials post such lines), and
 * is marked so that Live draws it again when the event comes (data-recheck).
 */
export function runEntryHtml(
  e: LiveEntry,
  now?: number,
  messages: RunMessages = new Map(),
): string {
  const lane = e.lane ?? "";
  const plain = () =>
    liveEntryHtml(e, { showWho: true, name: runSourceName, now, md: true }).replace(
      /^<div class="lv-row /,
      `<div data-who="${esc(whoTags(e))}" data-src="${esc(e.source)}" class="lv-row `,
    );
  if (e.kind === "status") {
    const start = /^(?:research )?trial on ([^:]+): ([\s\S]*)$/.exec(e.text);
    if (start)
      return `<div class="lv-div" data-who="${esc(whoTags(e))}" data-src="${esc(e.source)}" data-id="${e.id}"><span><b>${esc(start[1] ?? lane)}</b> · trial started · ${esc(clip(start[2] ?? "", 180))}</span></div>`;
    const end = /^trial ended:? ?([\s\S]*)$/.exec(e.text);
    if (end)
      return `<div class="lv-div" data-who="${esc(whoTags(e))}" data-src="${esc(e.source)}" data-id="${e.id}"><span><b>${esc(lane || "trial")}</b> · trial ended${end[1] ? ` · ${esc(clip(end[1], 160))}` : ""}</span></div>`;
  }
  // The owner removed a kept message: the owner's line, with the message's words.
  const unkept = unkeptLine(e);
  if (unkept) {
    const m = messages.get(Number(unkept[1]));
    return `<div class="lv-row lv-read" data-who="${esc(whoTags(e))}" data-src="${esc(e.source)}" data-id="${e.id}">${liveTime(e.at, now)}<div class="lv-body"><span class="muted">📌 You removed your kept message${m ? `: “${esc(clip(m.text, 120))}”` : ` (#${esc(unkept[1] ?? "")})`}. New trials no longer get it.</span></div></div>`;
  }
  const trial = e.source.startsWith("trial:");
  // A signed line filed under a trial, still waiting for its event: drawn plain until it comes.
  const waits = () => plain().replace('<div data-who="', '<div data-recheck="1" data-who="');
  if (e.kind === "message") {
    const line = /^Owner to ([^\s(:]+) \(#(\d+)(, kept in force)?\): ([\s\S]*)$/.exec(e.text);
    const id = Number(line?.[2]);
    const m =
      messages.get(id) ??
      (line && !trial
        ? { to: line[1] ?? "", text: line[4] ?? "", keep: line[3] !== undefined }
        : undefined);
    // A message to a trial is filed under that trial; every other message under the harness's own sources.
    if (m && e.signed === true && trial === m.to.startsWith("trial:"))
      return `<div class="lv-row lv-you" data-who="${esc(whoTags(e, m.to))}" data-src="${esc(e.source)}" data-id="${e.id}" data-msg="${id}">${liveTime(e.at, now)}<div class="lv-body"><div class="you"><b>To ${esc(RECIPIENT[m.to] ?? m.to)}:</b> ${esc(m.text)}${m.keep ? ` <span class="muted xs">📌 kept in force</span>` : ""}</div></div></div>`;
    return line && e.signed === true && trial ? waits() : plain();
  }
  const read =
    /^(?:(the teachers|the teacher pair|the auditor|the review panel) )?read the owner's message #(\d+)( \(in force\))?: ([\s\S]*)$/.exec(
      e.text,
    );
  if (e.kind === "status" && read) {
    const m =
      messages.get(Number(read[2])) ??
      (!trial ? { to: "", text: read[4] ?? "", keep: read[3] !== undefined } : undefined);
    if (!m && e.signed === true) return waits();
    if (m && e.signed === true && (read[1] !== undefined) === (e.source === "supervisor"))
      return `<div class="lv-row lv-read" data-who="${esc(`${whoTags(e)} you`)}" data-src="${esc(e.source)}" data-id="${e.id}">${liveTime(e.at, now)}<div class="lv-body"><span class="muted">✓ ${esc(advisorName(read[1]) ?? runSourceName(e.source, e.lane))} read your message${m.keep ? " (in force)" : ""}: “${esc(clip(m.text, 120))}”</span></div></div>`;
    return plain();
  }
  const ans =
    /^(the teachers|the teacher pair|the auditor|the review panel)(?: \(([^)]*)\))? answered the owner's message #(\d+): ([\s\S]*)$/.exec(
      e.text,
    );
  if (ans && e.kind === "text" && e.source === "supervisor" && e.signed === true)
    return `<div class="lv-row lv-answer" data-who="advisors you" data-src="${esc(e.source)}" data-id="${e.id}">${liveTime(e.at, now)}<div class="lv-body"><div class="answer"><b>${esc(advisorName(ans[1]) ?? "")}${ans[2] ? ` (${esc(ans[2])})` : ""} answered you:</b> ${mdLite(ans[4] ?? "")}</div></div></div>`;
  return plain();
}

/** A run's lines in order, each result joined to its own source's open call. */
export function runLinesHtml(
  entries: LiveEntry[],
  now?: number,
  messages: RunMessages = new Map(),
): string {
  const out: string[] = [];
  const open = new Map<string, number>();
  for (const e of entries) {
    const at = open.get(e.source);
    if (e.kind === "result" && at !== undefined) {
      const j = resultJoin(e);
      out[at] = (out[at] as string)
        .replace('<span class="lv-hint"></span>', `<span class="lv-hint">${j.hint}</span>`)
        .replace("</pre></details>", `</pre>${j.body}</details>`)
        .replace('data-open="1"', "");
      open.delete(e.source);
      continue;
    }
    out.push(runEntryHtml(e, now, messages));
    if (e.kind === "tool") open.set(e.source, out.length - 1);
    else open.delete(e.source);
  }
  return out.join("");
}
