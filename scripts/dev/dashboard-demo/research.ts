import { researchReviews } from "./reviews.ts";
import { iso, Rig } from "./shared.ts";

/** The research campaign benchmark-noise's run noise-survey, on cpu-1. */
export function researchRig(): Rig {
  // A research campaign (goals 112, 116 and 117): its questions' answer cards, the review panel's
  // item reviews and decisions, the hypotheses (the author's, the pool, promoted, merged, retired),
  // research tasks with their question and yield, and the progress rule's state.
  const c1 = new Rig("cpu-1");
  const RS = "noise-survey";
  const QUESTIONS = [
    "What makes a benchmark representative and repeatable?",
    "How are differences between measurements tested for significance?",
    "Which sources of run-to-run noise dominate on GPUs?",
    "How many repetitions are enough?",
  ];
  c1.ev(11, "run_created", RS, {
    campaign: "benchmark-noise",
    version: 1,
    mode: "research",
    seed: { repo: "research-notes", commit: "" },
  });
  c1.ev(11, "run_status", RS, { status: "running", reason: null });
  const hypothesis = (
    at: number,
    id: string,
    text: string,
    o: { lane?: string; question?: number; supporting?: number } = {},
  ) =>
    c1.ev(at, "hypothesis_added", RS, {
      hypothesis: id,
      lane: o.lane ?? null,
      text,
      supporting: Array.from({ length: o.supporting ?? 0 }, (_, i) => `c-${id.slice(2)}${i}`),
      ...(o.lane ? {} : { from: "brief" }),
      question: o.question ?? null,
      status: o.lane ? "pool" : "author",
    });
  hypothesis(11, "h-a1", "Interleaving the arms (ABAB) removes most slow drift between runs.");
  hypothesis(11, "h-a2", "Clock and thermal state explain most run-to-run variance on GPUs.");
  hypothesis(9.2, "h-p1", "Power capping reduces variance more than it reduces throughput.", {
    lane: "lane-1",
    question: 2,
    supporting: 3,
  });
  hypothesis(
    8.6,
    "h-p2",
    "Bootstrap intervals over blocks hold up better than t-tests on skewed timings.",
    { lane: "lane-2", question: 1, supporting: 5 },
  );
  hypothesis(
    7.9,
    "h-p3",
    "Ten repetitions are enough when the coefficient of variation is under 1%.",
    { lane: "lane-1", question: 3, supporting: 2 },
  );
  hypothesis(7.1, "h-p4", "Background daemons cause the rare slow outliers.", {
    lane: "lane-2",
    question: 2,
    supporting: 1,
  });
  hypothesis(6.4, "h-p5", "A block bootstrap beats a t-test for skewed timings.", {
    lane: "lane-1",
    question: 1,
    supporting: 2,
  });
  hypothesis(5.8, "h-p6", "Warm-up runs remove the first-run outlier on every GPU tested.", {
    lane: "lane-2",
    question: 0,
    supporting: 4,
  });
  c1.ev(6.3, "hypothesis_merged", RS, {
    hypothesis: "h-p5",
    into: "h-p2",
    lane: "lane-1",
    text: "Block bootstrap intervals hold up better than t-tests on skewed timings.",
    question: 1,
    supporting: ["c-p50", "c-p51"],
  });
  c1.ev(
    5.1,
    "hypothesis_status",
    RS,
    {
      hypothesis: "h-p2",
      status: "promoted",
      by: "control:owner:ui",
      reason: "Question 2 turns on it: the review panel should give it a verdict.",
    },
    "control:owner:ui",
  );
  c1.ev(
    3.4,
    "hypothesis_status",
    RS,
    {
      hypothesis: "h-p4",
      status: "retired",
      by: "control:owner:ui",
      reason: "Out of scope: the rigs run no background daemons.",
    },
    "control:owner:ui",
  );
  // Research tasks: each names one question; a finished one keeps its yield.
  const TASKS: [number, string, string, number, number][] = [
    [0, "explore", "survey benchmark methodology guides", 9, 4],
    [1, "primary", "find the primary sources for block bootstrap intervals", 7, 3],
    [2, "explore", "map the sources of GPU clock and thermal noise", 6, 3],
    [3, "explore", "find guidance on repetition counts", 4, 2],
    [0, "contradict", "look for sources that disagree on interleaving", 3, 1],
    [1, "explore", "compare significance tests used in benchmark suites", 5, 2],
    [2, "primary", "find vendor documents on boost clocks", 2, 1],
    [2, "contradict", "look for sources that disagree on thermal effects", 1, 0],
    [3, "primary", "find primary sources on stopping rules", 2, 1],
    [2, "explore", "look for studies of power capping and variance", 0, 0],
    [1, "consolidate", "consolidate the claims on significance tests", 3, 0],
    [2, "explore", "search for measurements of driver-induced jitter", 0, 0],
  ];
  TASKS.forEach(([q, family, title, verified, fresh], n) => {
    const id = `x-${String(n + 1).padStart(3, "0")}`;
    const at = 10.5 - n * 0.8;
    const full = `Question ${q + 1} (index ${q}): ${title}`;
    c1.ev(at, "experiment_added", RS, {
      id,
      title: full,
      family,
      why: "the research plan: the question's open gaps",
      question: q,
      by: "planner",
      state: "queued",
    });
    c1.ev(at - 0.02, "experiment_assigned", RS, {
      id,
      lane: `lane-${(n % 2) + 1}`,
      trial: `t-r${n + 1}`,
    });
    c1.ev(at - 0.7, "experiment_finished", RS, {
      id,
      lane: `lane-${(n % 2) + 1}`,
      trial: `t-r${n + 1}`,
      result: "finished",
      yield: {
        verified_claims: verified,
        by_question: verified
          ? [{ question: q, verified_claims: verified, new_domain_claims: fresh }]
          : [],
        no_question: 0,
        new_domains: fresh,
        domains: [],
        findings: n % 4 === 0 ? 1 : 0,
        card_changes: verified ? 1 : 0,
      },
    });
    c1.ev(at - 0.7, "trial_finished", RS, { tokens_in: 18000, tokens_out: 3500, stopped: "done" });
  });
  for (const [n, q, title] of [
    [13, 1, "look for sources that disagree on bootstrap intervals"],
    [14, 0, "find primary sources on warm-up runs"],
  ] as const)
    c1.ev(0.3, "experiment_added", RS, {
      id: `x-${String(n).padStart(3, "0")}`,
      title: `Question ${q + 1} (index ${q}): ${title}`,
      family: n === 13 ? "contradict" : "primary",
      why: "the research plan: the question's open gaps",
      question: q,
      by: "planner",
      state: "queued",
    });
  // Each question's answer card, as the synthesizer wrote it and the harness kept it.
  const answerCard = (
    at: number,
    question: number,
    version: number,
    certainty: string,
    answer: string,
    gaps: { kind: string; text: string }[],
    claims: number,
  ) =>
    c1.ev(at, "card_written", RS, {
      question,
      version,
      certainty,
      claims,
      gaps: gaps.length,
      by: "teacher-1",
      through: `c-q${question}v${version}`,
      answer,
      cited: Array.from({ length: claims }, (_, i) => `c-q${question}${i}`),
      gap_list: gaps,
    });
  answerCard(
    5.2,
    0,
    1,
    "moderate",
    "A benchmark is representative when its inputs and sizes match the workload it stands for, and repeatable when the same build, inputs and machine state give the same result within its noise.",
    [{ kind: "evidence", text: "A second site that names the machine state to record." }],
    6,
  );
  answerCard(
    2.6,
    0,
    2,
    "high",
    "A benchmark is representative when its inputs, sizes and access patterns match the workload it stands for, and repeatable when the same build, inputs and recorded machine state (clocks, temperature, driver) give the same result within its measured noise. Three independent guides agree on recording the machine state with each result, and on warm-up runs before measuring.",
    [],
    9,
  );
  answerCard(
    2.4,
    1,
    3,
    "moderate",
    "Differences are tested on blocks of interleaved runs. Bootstrap intervals over blocks are robust to the skewed timings that benchmarks produce; a t-test on single runs is not. Two sites agree; a third uses the Mann-Whitney test.",
    [
      {
        kind: "evidence",
        text: "A primary source that compares block bootstrap with Mann-Whitney on timings.",
      },
    ],
    7,
  );
  answerCard(
    1.2,
    2,
    3,
    "low",
    "Clock boost and thermal throttling are the noise sources most sources name on GPUs; driver jitter and background work are named less often, and the sources disagree on their size.",
    [
      { kind: "evidence", text: "A vendor document on how boost clocks vary between runs." },
      { kind: "evidence", text: "A study that measures driver-induced jitter apart from clocks." },
      {
        kind: "measurement",
        text: "Measure the variance with clocks locked against boost on the rig's GPU: a hill-climb run's A/A check.",
      },
    ],
    5,
  );
  answerCard(
    4.6,
    3,
    1,
    "insufficient",
    "Sources give stopping rules (repeat until the interval is narrower than the effect sought) rather than one number. How many repetitions a given rig needs depends on its own noise, which only a measurement shows.",
    [
      {
        kind: "measurement",
        text: "Measure the rig's noise (an A/A run) and derive the repetitions from it.",
      },
    ],
    4,
  );
  c1.ev(1.0, "card_refused", RS, {
    question: 1,
    by: "teacher-1",
    count: 1,
    problems: ["the number 30 is not in the claims it cites"],
  });
  researchReviews(c1, RS);
  c1.ev(0.4, "research_progress", RS, {
    open: [2],
    saturated: [2],
    last_improvement: iso(1.9),
    since_ms: 1.9 * 3_600_000,
    needed_ms: 2.75 * 3_600_000,
  });
  c1.ev(0.4, "research_digest", RS, {
    elapsed_ms: 11 * 3_600_000,
    min_ms: 6 * 3_600_000,
    sources: 38,
    domains: 14,
    verified: 112,
    drafts: 9,
    hypotheses: 6,
    unsupported_numbers: 2,
    questions: QUESTIONS.map((question, i) => ({ question, verified: [41, 37, 22, 12][i] })),
    report:
      "# Benchmark noise: digest 9\n\nFindings (verified, two or more independent domains):\n- Interleaving arms (ABAB) removes most slow drift between runs.\n- Clock and thermal state must be recorded with each result.\n- Bootstrap intervals over blocks are robust to outliers.\n",
  });
  // The rig reports its events in the order they happened.
  c1.events.sort((a, b) => a.at.localeCompare(b.at));
  c1.events.forEach((e, i) => {
    e.id = i + 1;
  });
  return c1;
}

/** The research campaign's earlier run, noise-pilot, on gpu-4. */
export function pilotRig(): Rig {
  const g4 = new Rig("gpu-4");
  // An earlier run of the research campaign, closed by its owner, whose one review came from a
  // harness before item reviews (goal 112): each question's count of reviewers, and the gaps.
  g4.ev(40, "run_created", "noise-pilot", {
    campaign: "benchmark-noise",
    version: 1,
    mode: "research",
    seed: { repo: "research-notes", commit: "" },
  });
  g4.ev(40, "run_status", "noise-pilot", { status: "running", reason: null });
  g4.ev(31, "review_requested", "noise-pilot", {
    review: 1,
    goal: "research",
    commit: "corpus:31:0:c-1",
    questions: 4,
    hypotheses: 2,
    verified_claims: 31,
  });
  g4.ev(30.6, "review_panel", "noise-pilot", {
    review: 1,
    goal: "research",
    result: "review_failed",
    reviewers: 3,
    questions: [
      { question: 0, answered_by: 2, answer: "Record the machine state with each result." },
      { question: 1, answered_by: 0 },
      { question: 2, answered_by: 1, answer: "Boost clocks and temperature." },
      { question: 3, answered_by: 0 },
    ],
    gaps: [
      "Question 2: missing: a primary source on significance tests for timings",
      "Question 4: missing: any source on repetition counts",
    ],
  });
  g4.ev(30, "run_status", "noise-pilot", {
    status: "closed",
    reason: "closed by the owner: the brief changed",
  });
  return g4;
}
