import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpCaller } from "../../../agents/mcp/index.ts";
import { promptRecord } from "../../../agents/prompt.ts";
import { kbCall } from "../../../agents/tools/index.ts";
import { log, redact } from "../../../common/env.ts";
import { errorText } from "../../../common/errors.ts";
import type { AdvisorRole } from "../../../core/agents.ts";
import {
  ADVISOR_MESSAGES,
  CODE_DIFF,
  CODE_FILE,
  CODE_FILES,
  EVIDENCE,
  JOURNAL,
  MODEL_CALLS,
  MODEL_CALLS_MAX,
  QUEUE,
  QUEUE_PART_MAX,
  type QueueAdd,
  type QueueMove,
  RESEARCH_FILE,
  RESEARCH_SEARCH,
  RESEARCH_SOURCE,
  REVIEW_TRIES,
  type Read,
  RUNS,
  type RunRow,
  researchList,
  TRY_ERROR_MAX,
} from "../../../core/api/harness/advisors.ts";
import { type ADVISOR_PROMPT_ROLES, KEEP_PROMPT } from "../../../core/api/harness/prompts.ts";
import {
  RESEARCH_KINDS,
  type ResearchKind,
  SEARCH_QUERY_MAX,
} from "../../../core/api/harness/research.ts";
import { KB_WRITE, KB_WRITES, type KbAdvisorSlot } from "../../../core/api/harness/supervisor.ts";
import type { NoteInput } from "../../../core/journal.ts";
import type { LiveKind } from "../../../core/live.ts";
import type { RunAdditions } from "../../../core/role-additions.ts";
import { type AdvisorAgent, AGENT_WORDS } from "../../../core/usage.ts";
import { askControl } from "../../kb/index.ts";
import type { AdvisorKeeper, AdvisorMcp, AdvisorTools, AdvisorUsage, SentPrompt } from "../call.ts";
import { type RunningAdvisors, withRunContext } from "../config.ts";
import { advisorFetcher } from "../fetcher.ts";
import type { AdvisorInTerminal } from "../terminal/index.ts";
import type { AdvisorCode, AdvisorKb, AdvisorResearch } from "../tools/index.ts";
import { kbSearchFor } from "./kb.ts";
import { advisorKeeper } from "./keeper.ts";
import { clip, harnessOf } from "./shared.ts";
import { type AdviseConfig, type AdviseState, MAX_TRIES } from "./state.ts";

/**
 * What the parts of one pass of the loop (adviseOnce) share, made once at its start: the harness's
 * API, the state the pass returns, its clock and its tries, the advisors' tools for a run, a run's
 * advisors with its campaign's context settings, the day's spending, and how an advisor's work is
 * counted, kept, said in Live and posted to the harness. Each part (a module of this folder) takes
 * what it needs.
 */
export function adviseContext(cfg: AdviseConfig, state: AdviseState) {
  const harness = harnessOf(cfg);
  const next: AdviseState = structuredClone(state);
  next.tries ??= {};
  next.ownerSeen ??= {};
  next.ideasSeen ??= {};
  const s = next.stats;
  const now = Date.now();
  const retryMs = cfg.retryMs ?? 30 * 60_000;
  /** Retried every retryMs, at most MAX_TRIES times (then the owner decides). */
  const due = (key: string) => {
    const t = next.tried[key];
    if ((next.tries[key] ?? 0) >= MAX_TRIES) return false;
    return !t || now - Date.parse(t) >= retryMs;
  };
  const mark = (key: string) => {
    next.tried[key] = new Date().toISOString();
    next.tries[key] = (next.tries[key] ?? 0) + 1;
  };
  // Web fetch only for listed domains; with an open fetch ("*"), no knowledge-base search in the
  // same agent, so private notes and the open web never meet in one injectable context. An
  // outside knowledge base's search goes only to the advisors of the campaigns granted it.
  const domains = cfg.advisors.fetch_domains;
  const fetchUrl = domains.length ? advisorFetcher(cfg.home, domains) : undefined;
  const toolsFor = (): AdvisorTools => ({
    ...(fetchUrl ? { fetchUrl } : {}),
    ...(domains.includes("*") ? {} : { kbSearch: kbSearchFor(cfg.advisors) }),
  });
  // Thermite's knowledge base for an advisor's call (goal 175): kb_search and kb_read asked of
  // control for the run, from the run's scope, and kb_write recorded by the harness in the
  // advisor's own slot, when the run's campaign lets that slot write. None without a control.
  const kbFor = async (run: string, slot: KbAdvisorSlot): Promise<AdvisorKb | undefined> => {
    const control = cfg.kb;
    if (!control) return undefined;
    let writes: string[] = [];
    try {
      writes = (await harness.call(KB_WRITES, { query: { run, slot } })).kinds;
    } catch (err) {
      // It reads, and writes nothing, until the harness answers.
      log(
        "supervisor",
        "an advisor's kinds to write not read",
        { run, slot, error: errorText(err) },
        "warn",
      );
    }
    return {
      writes,
      call: kbCall({
        run,
        ask: (kind, ask) => askControl(control, kind, ask),
        write: (args) => harness.call(KB_WRITE, { body: { run, slot, args } }),
      }),
    };
  };
  // The run's code and evidence for its teachers, read only, through the harness (goal 081): the
  // champion's tree, a file of it, an attempt's diff, and the judge's public findings.
  /** A read of the run's, by its route: the teacher gets the answer as it came. */
  const readOf =
    (run: string) => (route: Read, params: Record<string, string | number | undefined>) =>
      harness.call(route, { query: { run, ...params } });
  const codeFor = (run: string): AdvisorCode => {
    const get = readOf(run);
    return {
      listFiles: (path) => get(CODE_FILES, { path }),
      readFile: (path, offset, limit) => get(CODE_FILE, { path, offset, limit }),
      readDiff: (attempt, offset) => get(CODE_DIFF, { attempt, offset }),
      evidence: (attempt) => get(EVIDENCE, { attempt }),
    };
  };
  // The run's own research for its teachers, read only, through the harness (goal 098): each kind
  // a page at a time, a source's archived text, a file of its research folder, and a search.
  const researchFor = (run: string): AdvisorResearch => {
    const get = readOf(run);
    return {
      list: (kind, o) =>
        (RESEARCH_KINDS as readonly string[]).includes(kind)
          ? get(researchList(kind as ResearchKind), o)
          : Promise.reject(
              new Error(`no kind ${kind.slice(0, 40)}: the kinds are ${RESEARCH_KINDS.join(", ")}`),
            ),
      readSource: (source, offset, limit) => get(RESEARCH_SOURCE, { source, offset, limit }),
      readFile: (path, offset, limit) => get(RESEARCH_FILE, { path, offset, limit }),
      search: (query, o) =>
        get(RESEARCH_SEARCH, {
          q: query.slice(0, SEARCH_QUERY_MAX),
          kinds: o.kinds?.length ? o.kinds.join(",") : undefined,
          limit: o.limit,
        }),
    };
  };
  // The MCP servers a run's kit gives its advisors (goal 068), from the harness's list of runs
  // (read once a round). The supervisor calls them; advisors that may fetch any page get none,
  // which the run's live view says once.
  let runRows: RunRow[] | undefined;
  const runsNow = async () => {
    runRows ??= (await harness.call(RUNS)).runs;
    return runRows;
  };
  // A run's advisors with the campaign's own context settings (goal 070): each runtime's window
  // is the lower of its own and the campaign's, and the campaign's point replaces its own.
  const configFor = async (run: string | undefined): Promise<RunningAdvisors> => {
    const ctx = run ? (await runsNow()).find((r) => r.id === run)?.agents_context : undefined;
    if (!ctx) return cfg.advisors;
    const a = cfg.advisors;
    return {
      ...a,
      teachers: a.teachers.map((t) => withRunContext(t, ctx)),
      merged_by: a.merged_by ? withRunContext(a.merged_by, ctx) : undefined,
      auditor: a.auditor ? withRunContext(a.auditor, ctx) : undefined,
      review_panel: a.review_panel.map((p) => withRunContext(p, ctx)),
      synthesizer: a.synthesizer ? withRunContext(a.synthesizer, ctx) : undefined,
      final_writer: a.final_writer ? withRunContext(a.final_writer, ctx) : undefined,
    };
  };
  // The owner's additions to the roles of a run's campaign (goal 166), from the harness's list of
  // runs: each advisor's goes in its prompt.
  const additionsFor = async (run: string | undefined): Promise<RunAdditions> =>
    run ? ((await runsNow()).find((r) => r.id === run)?.role_additions ?? undefined) : undefined;
  // Each call's conversation before a compaction, kept with the supervisor's records (goal 070).
  /**
   * A call of the teachers, the auditor or a reviewer in its program's own terminal (goal 169), on
   * a rig set so, for a run: the owner's messages its prompt gives (`given`) are never offered again
   * inside its turn. None: headless.
   */
  const terminalFor = (
    run: string | undefined,
    role: AdvisorRole,
    given: readonly number[],
  ): AdvisorInTerminal | undefined =>
    cfg.terminals && run ? { terminals: cfg.terminals, run, role, given } : undefined;
  const keeperFor = (run: string | undefined): AdvisorKeeper =>
    advisorKeeper(cfg.home, run, (text) => say(run, "status", text));
  const mcpFor = async (run: string | undefined): Promise<AdvisorMcp | undefined> => {
    const m = cfg.mcp;
    if (!run || !m) return undefined;
    m.uses.set(run, (await runsNow()).find((r) => r.id === run)?.mcp_servers ?? []);
    const servers = m.gateway.given(run, "advisors").map((g) => g.name);
    if (!servers.length) return undefined;
    if (domains.includes("*")) {
      next.mcpOffSaid ??= {};
      if (!next.mcpOffSaid[run]) {
        next.mcpOffSaid[run] = true;
        say(
          run,
          "status",
          `the advisors may fetch any web page (fetch_domains "*"), so they get no MCP server: ${servers.join(", ")}`,
        );
      }
      return undefined;
    }
    const caller: McpCaller = { run, kind: "advisors", source: "supervisor" };
    const { tools } = await m.gateway.tools(caller);
    return {
      servers,
      tools,
      call: (s, t, a) => m.gateway.call(caller, s, t, a),
      serverFor: (s) => m.gateway.serverFor(caller, s),
      relist: (fresh) => m.gateway.tools(caller, fresh),
    };
  };
  // A daily spending limit for all advisors of the rig, when the owner set one.
  const day = new Date().toISOString().slice(0, 10);
  if (next.spend?.day !== day) next.spend = { day, usd: 0 };
  const spend = next.spend as { day: string; usd: number };
  const limit = cfg.advisors.max_usd_per_day;
  const overBudget = () => limit !== undefined && spend.usd >= limit;
  const count = (r: { tokensIn: number; tokensOut: number; usd: number }) => {
    s.tokens_in += r.tokensIn;
    s.tokens_out += r.tokensOut;
    s.usd += r.usd;
    spend.usd += r.usd;
  };
  const record = (kind: string, data: unknown) => {
    const dir = join(cfg.home, "advisors");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}.json`),
      `${JSON.stringify(data, null, 2)}\n`,
    );
  };
  const say = (run: string | undefined, kind: LiveKind, text: string) =>
    cfg.live?.({ kind, text, ...(run ? { run } : {}) });
  /**
   * A review try that could not be posted (goal 116): kept with the review, so its Reviews tab and
   * get_run say why. A harness from before it has no route for this; the Live line still says it.
   */
  const tryFailed = async (review: number, attempt: number, err: unknown) => {
    try {
      const error = redact(errorText(err)).slice(0, TRY_ERROR_MAX) || "no answer";
      await harness.call(REVIEW_TRIES, {
        params: { id: review },
        body: { try: Math.max(1, attempt), error },
      });
    } catch {
      // An older harness: nothing more to keep than the Live line.
    }
  };
  const fail = (what: string, err: unknown, run?: string) => {
    s.errors++;
    s.last_error = redact(`${what}: ${errorText(err)}`).slice(0, 500);
    log("supervisor", "advisor error", { error: s.last_error }, "error");
    say(run, "status", `${clip(s.last_error, 400)}`);
  };
  /**
   * The prompts an advisor's call sent (goal 166), handed to the harness to keep with its run,
   * whole. A failure is the advisor's error line; the advisor's work stands.
   */
  const promptsOut = async (
    run: string | undefined,
    call: string,
    sent: SentPrompt[] | undefined,
  ) => {
    if (!run) return;
    for (const p of sent ?? []) {
      try {
        const record =
          "sections" in p ? { ...p, lane: null, trial: null, call } : promptRecord(p, { call });
        await harness.call(KEEP_PROMPT, {
          body: { ...record, run, role: record.role as (typeof ADVISOR_PROMPT_ROLES)[number] },
        });
      } catch (err) {
        fail(`the ${p.role}'s prompt for ${run}`, err, run);
        return;
      }
    }
  };
  /**
   * An advisor's model usage in a run (goal 075), handed to the harness with its round: the
   * harness records each call in the run's history. A failure is the advisor's error line, and
   * those calls are not recorded; the advisor's work stands.
   */
  const usageOut = async (
    run: string | undefined,
    round: string,
    agent: AdvisorAgent,
    u: AdvisorUsage | undefined,
  ) => {
    if (!run || !u?.calls.length) return;
    const { calls, ...route } = u;
    for (let i = 0; i < calls.length; i += MODEL_CALLS_MAX) {
      try {
        const part = calls.slice(i, i + MODEL_CALLS_MAX);
        await harness.call(MODEL_CALLS, { body: { run, round, agent, ...route, calls: part } });
      } catch (err) {
        fail(`the model usage of the ${AGENT_WORDS[agent].toLowerCase()} for ${run}`, err, run);
        return;
      }
    }
  };
  /**
   * Tells the harness which of the owner's messages an advisor role was given and what it
   * answered (only answers to messages it was given). A failure here never stops the advisor's
   * own work: the messages then stay waiting and are given again.
   */
  const receipts = async (
    run: string,
    role: AdvisorRole,
    given: number[],
    answers: { message: number; text: string; advisor?: string | undefined }[],
  ) => {
    if (!given.length) return;
    try {
      await harness.call(ADVISOR_MESSAGES, {
        body: {
          run,
          role,
          read: given,
          answers: answers.filter((a) => given.includes(a.message) && a.text.length > 0),
        },
      });
    } catch (err) {
      fail(`the owner's messages to the ${role} for ${run}`, err, run);
    }
  };

  /**
   * An advisor's experiments and moves for a run's queue, recorded with its role as who made
   * them. A failure is the advisor's error line; the advisor's other work stands.
   */
  const toQueue = async (
    run: string,
    role: "teacher" | "auditor",
    add: QueueAdd[],
    move: QueueMove[],
  ): Promise<unknown> => {
    if (!add.length && !move.length) return undefined;
    try {
      // In parts, as the harness takes them: the teachers' portfolio has no count.
      const r = { added: [] as string[], moved: [] as string[], refused: [] as string[] };
      for (let i = 0; i === 0 || i < add.length; i += QUEUE_PART_MAX) {
        const part = await harness.call(QUEUE, {
          body: {
            run,
            role,
            add: add.slice(i, i + QUEUE_PART_MAX),
            move: i === 0 ? move : [],
          },
        });
        r.added.push(...part.added);
        r.moved.push(...part.moved);
        r.refused.push(...part.refused);
      }
      const who = role === "teacher" ? "the teachers" : "the auditor";
      say(
        run,
        "text",
        [
          r.added.length
            ? `${who} added to the queue: ${add
                .filter(
                  (a) => !r.refused.some((x) => x.startsWith(`add "${a.title.slice(0, 120)}"`)),
                )
                .map((a) => clip(a.title, 120))
                .join("; ")}`
            : "",
          r.moved.length ? `${who} moved ${r.moved.join(", ")}` : "",
          r.refused.length ? `refused: ${r.refused.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join(". "),
      );
      return r;
    } catch (err) {
      fail(`the queue for ${run}`, err, run);
      return undefined;
    }
  };

  /**
   * An advisor's field notes, posted after its work was: the harness records them as written by
   * `<role>:<name>` (each note checked on its own). A failure is the advisor's error line; its
   * review, audit or verdict stands.
   */
  const notesOut = async (
    run: string,
    role: AdvisorRole,
    by: string,
    notes: NoteInput[],
  ): Promise<unknown> => {
    if (!notes.length) return undefined;
    try {
      const r = await harness.call(JOURNAL, { body: { run, role, by, notes } });
      if (r.problems.length)
        say(run, "status", `the field notes of ${by}: ${clip(r.problems.join("; "), 400)}`);
      return r;
    } catch (err) {
      fail(`the field notes of ${by} for ${run}`, err, run);
      return undefined;
    }
  };
  return {
    cfg,
    harness,
    // The state the pass returns, with the teachers' markers (ownerSeen, ideasSeen) made above.
    next: next as AdviseState & Required<Pick<AdviseState, "ownerSeen" | "ideasSeen">>,
    s,
    now,
    retryMs,
    due,
    mark,
    domains,
    toolsFor,
    kbFor,
    codeFor,
    researchFor,
    configFor,
    additionsFor,
    keeperFor,
    terminalFor,
    mcpFor,
    limit,
    overBudget,
    count,
    record,
    say,
    tryFailed,
    fail,
    usageOut,
    promptsOut,
    receipts,
    toQueue,
    notesOut,
  };
}

/** The loop's context: what the parts of one pass share (adviseContext). */
export type AdviseContext = ReturnType<typeof adviseContext>;
