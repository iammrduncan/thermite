import { z } from "zod";
import { agentRun, type RunOnRig, type RunView } from "./views/index.ts";

/**
 * A run's detail of a size an agent can read (goal 128), for MCP's get_run and REST's
 * GET /v1/runs/<run>, and one of its attempts (goal 170). A run's view holds lists that grow with the run, such as its
 * journal and timeline: a research run of a day gave 3.2 million characters. Each list is cut to
 * its newest entries (the views keep them oldest first), and the research report to its first
 * characters. Nothing is cut without a word: `cut` says what was left out and how to read it, and
 * `list` with `offset` pages through one list.
 */

/** Entries of each list given by default. */
export const RUN_LIST_LIMIT = 10;
/** Characters of the research report given by default. */
export const REPORT_CHARS = 4000;
/**
 * Characters of the default answer as MCP sends it (indented JSON), well inside an agent's tool
 * output (goal 138): Claude Code refused a 75,689-character answer. Above it, the texts in the
 * lists' entries are cut, shorter each step, until it fits.
 */
export const DETAIL_CHARS = 40_000;
const TEXT_STEPS = [2000, 1000, 500, 250, 120];

/** The arguments, as MCP's schema; REST reads the same from its query. */
export const RUN_DETAIL_INPUT = {
  run: z.string().min(1),
  attempts: z.number().int().min(1).max(500).default(50),
  limit: z.number().int().min(1).max(500).default(RUN_LIST_LIMIT),
  list: z.string().min(1).max(40).optional(),
  offset: z.number().int().min(0).default(0),
  full_report: z.boolean().default(false),
};

/** What get_run gives of a research run (goals 112, 116 and 117), for both of its descriptions. */
export const RESEARCH_DETAIL =
  "for a research run its newest digest (research), its answer cards (cards: each question's newest card the harness kept, by index from 0, with version, certainty, answer, claims cited and gaps of kind evidence or measurement; card_refusals: the newest refused card of a question since its card, with the problems), its hypotheses (each with its question, an index from 0 or null for the whole run; its status: author, pool, promoted, merged with merged_into, or retired; the verified claims supporting it; and status_change: the newest change of its status by the owner or the plan, with why), the review panel's decisions (decisions: each item's decision in each review, oldest first, with its certainty and each dissenting reviewer; standing: each item's newest decision, with stands false when the question's card has a newer version than the one decided on, newer_card), its reviews (each with requested_at, posted_at, what it saw when asked, the owner's decision and note, reviewers: each reviewer's answer on each item with its verdict, certainty, reasons, the claims it cites and the problems code found; decided: the review panel's decision on each item in that review; counts; tries when the rig says), and the progress rule's state at the newest digest (progress: the open questions, those of them that are saturated, the last improvement, since_ms without one and needed_ms, a quarter of the running time)";

/** The arguments' words, for the tool's description. */
export const RUN_DETAIL_WORDS = `Each list that grows with the run (journal, timeline, queue, hypotheses, trials, reviews and the others) gives its newest ${RUN_LIST_LIMIT} entries by default (limit sets how many), and the research report its first ${REPORT_CHARS} characters (full_report: true gives it whole); cut says what was left out. list names one list and gives only it, its newest entries first skipped by offset, to page back through it`;

export interface RunDetailArgs {
  attempts: number;
  limit: number;
  list?: string | undefined;
  offset: number;
  full_report: boolean;
}

const count = (n: number) => n.toLocaleString("en-US");

/** Every text in `v` cut to `max` characters; `cut` counts the texts it cut. */
function clipTexts(v: unknown, max: number, cut: { n: number }): unknown {
  if (typeof v === "string") {
    if (v.length <= max) return v;
    cut.n++;
    return `${v.slice(0, max)}…`;
  }
  if (Array.isArray(v)) return v.map((x) => clipTexts(x, max, cut));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipTexts(x, max, cut)]));
  return v;
}

/**
 * A run's view cut to a readable size, or one of its lists. Attempts, the newest first, are cut
 * by `attempts`, as before; every other list by `limit`.
 */
export function runDetail(
  view: { id: string; attempts: unknown[] },
  o: RunDetailArgs,
): Record<string, unknown> {
  const run = view as Record<string, unknown> & typeof view;
  const lists = Object.keys(run).filter((k) => k !== "attempts" && Array.isArray(run[k]));
  if (o.list !== undefined) {
    const all = run[o.list];
    if (!Array.isArray(all))
      throw new Error(
        `the run has no list ${o.list}: its lists are ${["attempts", ...lists].join(", ")}`,
      );
    const to = Math.max(0, all.length - o.offset);
    const from = Math.max(0, to - o.limit);
    return { id: run.id, list: o.list, total: all.length, from, to, entries: all.slice(from, to) };
  }
  const out: Record<string, unknown> = { ...run };
  const cut: string[] = [];
  out.attempts = run.attempts.slice(-o.attempts).reverse();
  if (run.attempts.length > o.attempts)
    cut.push(
      `attempts: the newest ${count(o.attempts)} of ${count(run.attempts.length)} (attempts gives more)`,
    );
  for (const k of lists) {
    const all = run[k] as unknown[];
    if (all.length <= o.limit) continue;
    out[k] = all.slice(-o.limit);
    cut.push(
      `${k}: the newest ${count(o.limit)} of ${count(all.length)} entries (list "${k}" with offset reads older ones)`,
    );
  }
  const research = run.research as { report?: unknown } | null | undefined;
  if (
    !o.full_report &&
    typeof research?.report === "string" &&
    research.report.length > REPORT_CHARS
  ) {
    out.research = { ...research, report: `${research.report.slice(0, REPORT_CHARS)}…` };
    cut.push(
      `research.report: its first ${count(REPORT_CHARS)} of ${count(research.report.length)} characters (full_report: true gives it whole)`,
    );
  }
  if (cut.length) out.cut = cut;
  return keepToBudget(out, "list with a list's name gives its entries whole");
}

/**
 * An answer kept under DETAIL_CHARS as MCP sends it (goal 138): above it, the texts in its lists
 * are cut, shorter each step, until it fits, and a line in `cut` says how, and where to read
 * them whole (`whole`).
 */
export function keepToBudget(
  answer: Record<string, unknown>,
  whole: string,
): Record<string, unknown> {
  const out = { ...answer };
  const keys = Object.keys(out).filter((k) => k !== "cut" && Array.isArray(out[k]));
  const kept = keys.map((k) => out[k]);
  const fits = () => JSON.stringify(out, null, 2).length <= DETAIL_CHARS;
  for (const max of TEXT_STEPS) {
    if (fits()) break;
    const clipped = { n: 0 };
    keys.forEach((k, i) => {
      out[k] = clipTexts(kept[i], max, clipped);
    });
    if (clipped.n && (max === TEXT_STEPS.at(-1) || fits()))
      out.cut = [
        ...((answer.cut as string[] | undefined) ?? []),
        `texts in lists: ${count(clipped.n)} cut to their first ${count(max)} characters, to keep the answer under ${count(DETAIL_CHARS)} (${whole})`,
      ];
  }
  return out;
}

/**
 * MCP's run_queue: up next in order, the lanes' ideas, what each lane is on, the newest `tried`,
 * the rules, the directions, the newest hand-outs and the owner's newest messages, kept to the
 * budget (goal 138).
 */
export function runQueue(r: RunView, tried: number): Record<string, unknown> {
  const q = r.queue;
  return keepToBudget(
    {
      run: r.id,
      mode: r.mode,
      status: r.status,
      up_next: q
        .filter((x) => x.state === "queued")
        .sort((x, y) => (x.position ?? 0) - (y.position ?? 0)),
      proposed: q.filter((x) => x.state === "proposed"),
      in_progress: q.filter((x) => x.state === "assigned"),
      at_work: r.at_work,
      tried: q
        .filter((x) => x.state === "done" || x.state === "dropped")
        .sort((x, y) => y.updated_at.localeCompare(x.updated_at))
        .slice(0, tried),
      rules: r.rules,
      directions: r.directions,
      handouts: r.handouts.slice(-10).reverse(),
      messages: r.messages.slice(-20).reverse(),
    },
    'get_run with list "queue" gives the queue whole',
  );
}

/**
 * One attempt of a run (goal 170), as REST's GET /v1/runs/<run>/attempts/<attempt> and MCP's
 * get_attempt give it: the attempt as the run's view has it, the rig it ran on (whether the run
 * is an earlier one, and why), and the champion it became, if any. `agent`: as the agent token
 * reads it, a held-out check as its kinds alone (goal 082).
 */
export function attemptRead(
  x: RunOnRig,
  attempt: string,
  agent = false,
): Record<string, unknown> | { error: string } {
  const r = agent ? agentRun(x.run) : x.run;
  const a = r.attempts.find((y) => y.id === attempt);
  if (!a) return { error: `run ${x.run.id} has no attempt ${attempt}` };
  const champion = x.run.champion.find((c) => c.attempt === attempt && !c.reopened);
  return {
    run: x.run.id,
    campaign: x.run.campaign,
    rig: x.rig.id,
    earlier: x.earlier,
    champion_seq: champion?.seq ?? null,
    attempt: a,
  };
}
