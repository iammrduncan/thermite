import type {
  EventRow,
  HomeAnswer,
  NeedRow,
  RunOverviewAnswer,
  RunRow,
  SessionAnswer,
} from "@core/api/control/dashboard.ts";

/**
 * Made-up answers of control for the gallery (gallery.tsx): each screen in each of its states,
 * with no control behind it. Every name here is invented.
 */

/** A time some minutes ago, as control writes one. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const none = { campaign: null, run: null, rig: null, lane: null, attempt: null };

const needs: NeedRow[] = [
  {
    key: "promotion:rig-a:run-0007:a-0412:0",
    kind: "promotion",
    tone: "needs",
    label: "Approve a win",
    headline: "“Sort runs of eight keys with a network” is 4.1% faster than the champion.",
    why: "This campaign asks you before a win becomes the champion.",
    where: { ...none, campaign: "sorting-speed", run: "run-0007", rig: "rig-a", lane: "lane-2" },
    since: ago(18),
    page: "/ui",
  },
  {
    key: "audit:rig-b:run-0003::1",
    kind: "audit",
    tone: "wrong",
    label: "Audit failed",
    headline: "The auditor found a change that reads the judge's answers.",
    why: "A win with a failed audit is not promoted until you decide.",
    where: { ...none, campaign: "parser-goals", run: "run-0003", rig: "rig-b" },
    since: ago(95),
    page: "/ui",
  },
  {
    key: "question:rig-a:run-0002::2",
    kind: "question",
    tone: "working",
    label: "A question",
    headline: "The planner asks whether the benchmark may use more than one thread.",
    why: "The agents wait for your answer on this direction only.",
    where: { ...none, campaign: "reading-notes", run: "run-0002", rig: "rig-a" },
    since: ago(240),
    page: "/ui",
  },
];

const hill: RunRow = {
  campaign: "sorting-speed",
  run: "run-0007",
  rig: "rig-a",
  mode: "hill_climb",
  mode_words: "hill climb",
  state: { word: "running", tone: "working" },
  judge_only: false,
  figure: {
    text: "+23.7%",
    steps: [
      { seq: 1, at: ago(600), gain: 0 },
      { seq: 2, at: ago(520), gain: 0.052 },
      { seq: 3, at: ago(410), gain: 0.118 },
      { seq: 4, at: ago(260), gain: 0.131 },
      { seq: 5, at: ago(140), gain: 0.204 },
      { seq: 6, at: ago(35), gain: 0.237 },
    ],
    goals: [],
  },
  champion: 6,
  started_at: ago(610),
  now: [
    {
      who: "lane-1",
      text: "Replace the insertion sort of short runs with a sorting network",
      since: ago(12),
      busy: true,
      tone: "working",
    },
    {
      who: "lane-2",
      text: "next: try a branch-free merge for the last pass",
      since: null,
      busy: false,
      tone: "none",
    },
    {
      who: "judge",
      text: "measuring “Skip the copy when the halves are in order” · 1 more queued",
      since: ago(3),
      busy: true,
      tone: "working",
    },
  ],
  needs: 1,
};

const goal: RunRow = {
  campaign: "parser-goals",
  run: "run-0003",
  rig: "rig-b",
  mode: "goal",
  mode_words: "goal",
  state: { word: "running", tone: "working" },
  judge_only: false,
  figure: {
    text: "3/5 goals",
    steps: [],
    goals: [
      {
        goal: "Parses every file of the sample set",
        state: { word: "met", tone: "good" },
        reasons: "",
      },
      {
        goal: "Reports the line of a syntax error",
        state: { word: "met", tone: "good" },
        reasons: "",
      },
      { goal: "Keeps comments in its output", state: { word: "met", tone: "good" }, reasons: "" },
      {
        goal: "Reads a 100 MB file in under two seconds",
        state: { word: "not met", tone: "wrong" },
        reasons: "2.9 s on the judge's machine; the limit is 2 s.",
      },
      {
        goal: "Uses no more memory than the file's size",
        state: { word: "not checked", tone: "none" },
        reasons: "",
      },
    ],
  },
  champion: null,
  started_at: ago(300),
  now: [
    {
      who: "lane-1",
      text: "Read the file in pieces instead of all at once",
      since: ago(41),
      busy: true,
      tone: "working",
    },
    { who: "judge", text: "idle", since: null, busy: false, tone: "none" },
  ],
  needs: 1,
};

const research: RunRow = {
  campaign: "reading-notes",
  run: "run-0002",
  rig: "rig-a",
  mode: "research",
  mode_words: "research",
  state: { word: "running", tone: "working" },
  judge_only: false,
  figure: { text: "12 verified claims", steps: [], goals: [] },
  champion: null,
  started_at: ago(95),
  now: [
    {
      who: "lane-1",
      text: "Compare three ways to cache the parsed notes",
      since: ago(22),
      busy: true,
      tone: "working",
    },
    {
      who: "planner",
      text: "waiting for your answer before the next round",
      since: null,
      busy: false,
      tone: "needs",
    },
    { who: "judge", text: "idle, 2 queued", since: null, busy: false, tone: "none" },
  ],
  needs: 1,
};

const happened: EventRow[] = [
  {
    at: ago(3),
    tone: "working",
    text: "The judge started to measure “Skip the copy when the halves are in order”.",
    rig: "rig-a",
    campaign: "sorting-speed",
    run: "run-0007",
    attempt: "a-0415",
  },
  {
    at: ago(35),
    tone: "good",
    text: "“Sort runs of eight keys with a network” became champion #6: +23.7% over the start.",
    rig: "rig-a",
    campaign: "sorting-speed",
    run: "run-0007",
    attempt: "a-0412",
  },
  {
    at: ago(58),
    tone: "none",
    text: "“Unroll the inner loop four times” was no faster than the champion.",
    rig: "rig-a",
    campaign: "sorting-speed",
    run: "run-0007",
    attempt: "a-0409",
  },
  {
    at: ago(95),
    tone: "wrong",
    text: "The auditor failed “Answer from a table of the test's inputs”.",
    rig: "rig-b",
    campaign: "parser-goals",
    run: "run-0003",
    attempt: "a-0077",
  },
  {
    at: ago(180),
    tone: "needs",
    text: "rig-c stopped reporting.",
    rig: "rig-c",
    campaign: null,
    run: null,
    attempt: null,
  },
];

export const homeFull: HomeAnswer = {
  at: ago(0),
  counts: { needs: 3, running: 3, judging: 1, queued: 3, rigs: 3, offline: 1 },
  needs,
  at_work: [hill, goal, research],
  happened,
  nav: {
    folders: ["Speed"],
    campaigns: [
      {
        name: "parser-goals",
        mode: "goal",
        state: { word: "running", tone: "working" },
        folder: null,
        run: "run-0003",
      },
      {
        name: "reading-notes",
        mode: "research",
        state: { word: "running", tone: "working" },
        folder: null,
        run: "run-0002",
      },
      {
        name: "sorting-speed",
        mode: "hill_climb",
        state: { word: "running", tone: "working" },
        folder: "Speed",
        run: "run-0007",
      },
      {
        name: "hashing-speed",
        mode: "hill_climb",
        state: { word: "done", tone: "good" },
        folder: "Speed",
        run: "run-0001",
      },
    ],
  },
};

export const homeEmpty: HomeAnswer = {
  at: ago(0),
  counts: { needs: 0, running: 0, judging: 0, queued: 0, rigs: 0, offline: 0 },
  needs: [],
  at_work: [],
  happened: [],
  nav: { folders: [], campaigns: [] },
};

const facts = (r: RunRow) => [
  { label: "Campaign", value: r.campaign },
  { label: "Mode", value: r.mode_words },
  { label: "Rig", value: r.rig },
  { label: "Started", value: "10 hours ago" },
  { label: "Changes judged", value: "41, of which 5 became champions" },
];

export const runs: Record<"hill" | "goal" | "research" | "new", RunOverviewAnswer> = {
  hill: {
    at: ago(0),
    row: hill,
    said: "The run is at work. Its champion is 23.7% faster than the starting point, and one win waits for you.",
    held: null,
    needs: needs.slice(0, 1),
    metric: { name: "Sort time", unit: "ms", better: "lower is better" },
    questions: [],
    facts: facts(hill),
    recent: happened.filter((e) => e.run === hill.run),
    page: "/ui",
  },
  goal: {
    at: ago(0),
    row: goal,
    said: "The run is at work. Three of its five goals are met.",
    held: null,
    needs: needs.slice(1, 2),
    metric: null,
    questions: [],
    facts: facts(goal),
    recent: happened.filter((e) => e.run === goal.run),
    page: "/ui",
  },
  research: {
    at: ago(0),
    row: research,
    said: "The run is at work on three questions. One has an answer the judge verified.",
    held: "The planner waits for your answer before it plans the next round.",
    needs: needs.slice(2, 3),
    metric: null,
    questions: [
      {
        index: 1,
        question: "Which cache keeps the notes current at the least cost?",
        state: { word: "answered", tone: "good" },
        answer: "A cache keyed by each file's hash: 12 claims verified, none refuted.",
      },
      {
        index: 2,
        question: "Does the cache help on a cold start?",
        state: { word: "open", tone: "working" },
        answer: "",
      },
      {
        index: 3,
        question: "What does it cost in memory?",
        state: { word: "not started", tone: "none" },
        answer: "",
      },
    ],
    facts: facts(research),
    recent: [],
    page: "/ui",
  },
  // A run that has just started: every section in its empty state.
  new: {
    at: ago(0),
    row: {
      ...hill,
      run: "run-0008",
      state: { word: "starting", tone: "working" },
      figure: { text: null, steps: [], goals: [] },
      champion: null,
      now: [
        {
          who: "lanes",
          text: "waiting for the first round",
          since: null,
          busy: false,
          tone: "none",
        },
      ],
      needs: 0,
    },
    said: "The run has just started. The judge measures the starting point first.",
    held: null,
    needs: [],
    metric: { name: "Sort time", unit: "ms", better: "lower is better" },
    questions: [],
    facts: facts(hill).slice(0, 3),
    recent: [],
    page: "/ui",
  },
};

export const session: SessionAnswer = {
  signed_in: true,
  token: "made-up",
  session_days: 30,
  control: { version: "0.0.0", commit: "0123abc" },
};
