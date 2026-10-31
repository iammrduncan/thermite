import type { ControlStore } from "../../src/control/store/index.ts";
import { callUsage } from "../../src/core/usage.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "./control-stack.ts";
import { ingestReport } from "./control-store.ts";

/**
 * A research run as control sees it from a rig's events (goals 116 and 117), for control's tests:
 * three questions with their answer cards, the author's hypotheses and a pool (one promoted, one
 * merged, one retired), research tasks with their question and yield, three reviews (one not
 * passed with each reviewer's answers and a problem code found, one passed after three tries and
 * accepted by the owner with the owner's message to the review panel and its answer, one waiting)
 * with the review panel's model calls, and the progress rule's state; and a control to read it
 * with: its pages, MCP and the dashboard's command form.
 */

export { ADMIN };
export const RIG_TOKEN = "t-a-abcdef";
export const RUN = "/ui/campaigns/survey/runs/s-1";
const t0 = Date.now() - 10 * 3_600_000;
export const at = (h: number) => new Date(t0 + h * 3_600_000).toISOString();
export type Ev = { kind: string; subject: string; body: Record<string, unknown>; at?: string };

export async function researchControl() {
  const { store, control: api } = controlOnly({ tokens: { rigs: { "rig-a": RIG_TOKEN } } });
  const ui = await signIn(api);
  const { page } = ui;
  const mcp = async (tool: string, args: Record<string, unknown>) => {
    const client = await mcpClient(api);
    const r = (await client.callTool({ name: tool, arguments: args })) as {
      content: { text: string }[];
    };
    await client.close();
    return JSON.parse(r.content[0]?.text ?? "null");
  };
  let id = 0;
  /** The rig's report of these events, once control applied them from the events stream. */
  const ingest = async (events: Ev[]) => {
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: id,
      next: id + events.length,
      events: events.map((e) => ({
        id: ++id,
        at: e.at ?? at(id / 100),
        actor: "harness",
        kind: e.kind,
        subject: e.subject,
        body: e.body,
      })),
      summary: {},
    });
  };
  /** A form as the page's script sends it: with fetch, asking for JSON. */
  const send = async (form: Record<string, string>) => {
    const csrf = ui.csrfOf(await page(RUN));
    const r = await ui.post("/ui/commands", { csrf, ...form }, { accept: "application/json" });
    return { status: r.status, answer: JSON.parse(await r.text()) as Record<string, unknown> };
  };
  /** A form posted as the browser posts it, without the page's script: the answer as it comes. */
  const post = async (path: string, form: Record<string, string>) => {
    const csrf = ui.csrfOf(await page(RUN));
    return await ui.post(path, { csrf, ...form });
  };
  return { store, page, mcp, ingest, send, post };
}

export const ev = (
  kind: string,
  body: Record<string, unknown>,
  h?: number,
  subject = "s-1",
): Ev => ({
  kind,
  subject,
  body,
  ...(h === undefined ? {} : { at: at(h) }),
});

export const LONG = `Four guides agree that a benchmark must record its machine state. ${"They name the clocks, the temperature and the driver with each result. ".repeat(8)}The end.`;

/** One research run with three questions, its hypotheses, tasks, cards, three reviews and the progress rule. */
export function researchRunEvents(): Ev[] {
  const item = (
    kind: string,
    key: string | number,
    verdict: string,
    certainty: string | null,
    o: { version?: number | null; problems?: string[] } = {},
  ) => ({
    kind,
    key,
    card_version: o.version ?? null,
    verdict,
    certainty,
    reasons: `Why ${verdict}: the cited claims say so.`,
    claims: [`c-${key}1`, `c-${key}2`],
    problems: o.problems ?? [],
  });
  const decided = (
    review: number,
    kind: string,
    key: string | number,
    decision: string,
    certainty: string | null,
    version: number | null,
    dissent: Record<string, unknown>[] = [],
    h = 0,
  ) =>
    ev(
      "item_decided",
      { review, kind, key, card_version: version, decision, certainty, dissent },
      h,
    );
  const task = (
    id: string,
    q: number,
    title: string,
    h: number,
    yld: Record<string, unknown> | null,
  ) => [
    ev(
      "experiment_added",
      { id, title, family: "explore", question: q, by: "planner", state: "queued" },
      h,
    ),
    ...(yld === undefined
      ? []
      : [
          ev("experiment_assigned", { id, lane: "lane-1", trial: `t-${id}` }, h + 0.05),
          ...(yld
            ? [
                ev(
                  "experiment_finished",
                  { id, lane: "lane-1", trial: `t-${id}`, result: "finished", yield: yld },
                  h + 0.3,
                ),
              ]
            : []),
        ]),
  ];
  const usage = (round: string, h: number) =>
    ev(
      "model_call",
      {
        trial: null,
        round,
        agent: "review_panel",
        harness: "pi",
        provider: "p",
        model: "m",
        ...callUsage({ at: at(h), calls: 2, tokensIn: 40_000, tokensOut: 1_500, callMs: 90_000 }),
      },
      h,
    );
  return [
    ev(
      "run_created",
      { campaign: "survey", version: 1, mode: "research", seed: { repo: "research" } },
      0,
    ),
    ev("run_status", { status: "running", reason: null }, 0),
    // The author's hypotheses: one from a harness before the pool (no status, no lane).
    ev(
      "hypothesis_added",
      { hypothesis: "h-a1", lane: null, text: "Clocks drift.", supporting: [] },
      0,
    ),
    ev(
      "hypothesis_added",
      {
        hypothesis: "h-a2",
        lane: null,
        text: "Heat <b>matters</b>.",
        supporting: [],
        from: "brief",
        question: null,
        status: "author",
      },
      0,
    ),
    ev(
      "hypothesis_added",
      {
        hypothesis: "h-p1",
        lane: "lane-1",
        text: "Boost clocks vary the most.",
        supporting: ["c-1", "c-2"],
        question: 1,
        status: "pool",
      },
      1,
    ),
    ev(
      "hypothesis_added",
      {
        hypothesis: "h-p2",
        lane: "lane-2",
        text: "Warm-up runs remove outliers.",
        supporting: ["c-3"],
        question: 0,
        status: "pool",
      },
      1.1,
    ),
    ev(
      "hypothesis_added",
      {
        hypothesis: "h-p3",
        lane: "lane-1",
        text: "Boost clock varies most.",
        supporting: [],
        question: 1,
        status: "pool",
      },
      1.2,
    ),
    ev(
      "hypothesis_added",
      {
        hypothesis: "h-p4",
        lane: "lane-2",
        text: "Daemons cause outliers.",
        supporting: [],
        question: 2,
        status: "pool",
      },
      1.3,
    ),
    ev(
      "hypothesis_merged",
      {
        hypothesis: "h-p3",
        into: "h-p1",
        lane: "lane-1",
        text: "Boost clocks vary the most.",
        question: 1,
        supporting: [],
      },
      1.4,
    ),
    ev(
      "hypothesis_status",
      {
        hypothesis: "h-p2",
        status: "promoted",
        by: "control:owner:ui",
        reason: "Question 1 turns on it.",
      },
      1.5,
    ),
    ev(
      "hypothesis_status",
      { hypothesis: "h-p4", status: "retired", by: "planner", reason: "Out of scope." },
      1.6,
    ),
    // Tasks: two done with a yield, one in progress, one queued whose title names no question.
    ...task("x-1", 0, "Question 1 (index 0): survey the guides", 2, {
      verified_claims: 3,
      by_question: [{ question: 0, verified_claims: 3, new_domain_claims: 2 }],
      new_domains: 2,
      domains: ["example.org"],
      findings: 1,
      card_changes: 1,
    }),
    ...task("x-2", 1, "Question 2 (index 1): find vendor documents", 2.5, {
      verified_claims: 0,
      by_question: [],
      new_domains: 0,
      domains: [],
      findings: 0,
      card_changes: 0,
    }),
    ...task("x-3", 1, "Question 2 (index 1): look for contradictions", 3, null),
    ev(
      "experiment_added",
      {
        id: "x-4",
        title: "read the driver notes",
        family: "primary",
        question: 2,
        by: "owner",
        state: "queued",
      },
      3.1,
    ),
    // Cards: question 1's long answer, question 2's with both kinds of gap and a refusal since.
    ev(
      "card_written",
      {
        question: 0,
        version: 1,
        certainty: "high",
        claims: 2,
        gaps: 0,
        by: "teacher-1",
        through: "c-2",
        answer: LONG,
        cited: ["c-1", "c-2"],
        gap_list: [],
      },
      3.2,
    ),
    ev(
      "card_written",
      {
        question: 1,
        version: 2,
        certainty: "low",
        claims: 1,
        gaps: 2,
        by: "teacher-1",
        through: "c-5",
        answer: "Boost clocks, by one site.",
        cited: ["c-5"],
        gap_list: [
          { kind: "evidence", text: "A second site on boost clocks." },
          { kind: "measurement", text: "Measure the variance with clocks locked." },
        ],
      },
      3.3,
    ),
    ev(
      "card_refused",
      {
        question: 1,
        by: "teacher-1",
        count: 1,
        problems: ["the number 30 is not in the claims it cites"],
      },
      3.4,
    ),
    // Review 1: not passed; reviewer-3's answer on question 2 failed code's check.
    ev(
      "review_requested",
      {
        review: 1,
        goal: "research",
        commit: "corpus:9",
        questions: 3,
        hypotheses: 2,
        verified_claims: 9,
      },
      4,
    ),
    ev(
      "review_items",
      {
        review: 1,
        reviewer: "reviewer-1",
        items: [
          item("question", 0, "answered", "moderate", { version: 1 }),
          item("question", 1, "open", null, { version: 2 }),
          item("hypothesis", "h-a1", "supported", null),
        ],
      },
      4.2,
    ),
    ev(
      "review_items",
      {
        review: 1,
        reviewer: "reviewer-3",
        items: [
          item("question", 0, "answered", "low", { version: 1 }),
          item("question", 1, "answered", "low", {
            version: 2,
            problems: ["the number 12 is not in the claims it cites"],
          }),
          item("hypothesis", "h-a1", "undecided", null),
        ],
      },
      4.2,
    ),
    decided(1, "question", 0, "answered", "moderate", 1, [], 4.25),
    decided(1, "question", 1, "open", null, 2, [], 4.25),
    decided(
      1,
      "hypothesis",
      "h-a1",
      "supported",
      null,
      null,
      [
        {
          reviewer: "reviewer-3",
          verdict: "undecided",
          certainty: null,
          reasons: "One site only.",
        },
      ],
      4.25,
    ),
    ev(
      "review_panel",
      { review: 1, goal: "research", result: "review_failed", reviewers: 3, decided: 2, open: 1 },
      4.3,
    ),
    usage("review 1", 4.2),
    // A reviewer's field note, written once review 1 was posted.
    ev(
      "journal_note",
      {
        id: 1,
        by: "review_panel:reviewer-1",
        kind: "observation",
        text: "Question 2 rests on one site.",
        about: { type: "run", id: "s-1" },
      },
      4.35,
    ),
    // The owner's message to the review panel, read and answered with review 2.
    ev(
      "agent_message",
      { id: 5, to: "review_panel", text: "Judge question 2 by what sources can say." },
      4.5,
    ),
    // Review 2: passed after three tries; question 2 at the best available; the owner accepted it.
    ev(
      "review_requested",
      {
        review: 2,
        goal: "research",
        commit: "corpus:14",
        questions: 3,
        hypotheses: 3,
        verified_claims: 14,
      },
      5,
    ),
    // Two tries that could not be posted before the third did.
    ev(
      "review_try_failed",
      { review: 2, try: 1, error: "2 of 3 reviewers of the review panel answered" },
      5.2,
    ),
    ev(
      "review_try_failed",
      { review: 2, try: 2, error: "reviewer-2: the answer was not JSON" },
      5.4,
    ),
    decided(2, "question", 0, "answered", "high", 1, [], 5.6),
    decided(2, "question", 1, "insufficient", null, 2, [], 5.6),
    decided(2, "hypothesis", "h-p2", "supported", null, null, [], 5.6),
    ev(
      "review_panel",
      {
        review: 2,
        goal: "research",
        result: "review_passed",
        reviewers: 3,
        decided: [0, 1, "h-p2"],
        open: [],
        tries: 3,
      },
      5.7,
    ),
    ev("agent_message_read", { message: 5, by: "review_panel" }, 5.71),
    ev(
      "advisor_answer",
      {
        message: 5,
        role: "review_panel",
        advisor: "reviewer-1",
        text: "Question 2 is the best available.",
      },
      5.71,
    ),
    ev(
      "review_decided",
      { review: 2, goal: "research", decision: "accepted", note: "Good enough." },
      5.8,
    ),
    usage("review 2", 5.6),
    // Question 1's card changed since review 2 decided it.
    ev(
      "card_written",
      {
        question: 0,
        version: 2,
        certainty: "high",
        claims: 2,
        gaps: 0,
        by: "teacher-1",
        through: "c-9",
        answer: LONG,
        cited: ["c-1", "c-2"],
        gap_list: [],
      },
      6,
    ),
    // Review 3: asked, and waiting.
    ev(
      "review_requested",
      {
        review: 3,
        goal: "research",
        commit: "corpus:20",
        questions: 3,
        hypotheses: 3,
        verified_claims: 20,
      },
      7,
    ),
    ev(
      "research_progress",
      {
        open: [0, 2],
        saturated: [2],
        last_improvement: at(6),
        since_ms: 3_600_000,
        needed_ms: 7_200_000,
      },
      8,
    ),
    ev(
      "research_digest",
      {
        questions: [
          { question: "What makes a benchmark repeatable?", verified: 8 },
          { question: "Which noise dominates?", verified: 4 },
          { question: "How many repetitions?", verified: 0 },
        ],
        verified: 12,
        elapsed_ms: 8 * 3_600_000,
        min_ms: 2 * 3_600_000,
        unsupported_numbers: 0,
        report: "# Report",
      },
      8,
    ),
  ];
}

/** The supervisor's Live lines for review 3: a failed try, with a line that holds markup. */
export function reviewLiveLines(store: ControlStore) {
  store.liveLines.add(
    "rig-a",
    "sup-log",
    [
      "review 3 of the research questions, reviewer-1: fail. <script>alert(1)</script>",
      "review 3: 2 of 3 reviewers of the review panel answered (reviewer-2: the provider refused: 429)",
    ].map((text, i) => ({
      seq: i + 1,
      at: at(7.5 + i * 0.1),
      source: "supervisor",
      kind: "status" as const,
      text,
      run: "s-1",
    })),
    false,
  );
}

/** The part of a page from one marker to the next (or the end). */
export const part = (html: string, from: string, to?: string) => {
  const i = html.indexOf(from);
  if (i < 0) return "";
  const j = to ? html.indexOf(to, i + from.length) : -1;
  return html.slice(i, j < 0 ? undefined : j);
};
