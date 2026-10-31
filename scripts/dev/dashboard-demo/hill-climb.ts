import { callUsage } from "../../../src/core/usage.ts";
import { iso, pick, Rig, rnd, urnd } from "./shared.ts";

const HYPOTHESES = [
  "fuse the dequantize into the GEMV inner loop",
  "split K across two warps to hide load latency",
  "keep the activation vector in shared memory",
  "unroll the 4-row tile by 2",
  "vectorize the scale loads (half2)",
  "prefetch the next block while reducing",
  "drop the redundant bounds check in the hot loop",
  "use a wider memory transaction for the codes",
  "reorder the reduction to avoid bank conflicts",
  "precompute the per-group zero point",
];
const VERDICTS = [
  "neutral",
  "neutral",
  "neutral",
  "regress",
  "invalid",
  "rejected_v0",
  "inconclusive",
  "crash_candidate",
];

/** One made-up model usage record: its calls, tokens, cached share (null: not reported) and times. */
function modelCall(
  u: Rig,
  hoursAgo: number,
  run: string,
  agent: string,
  harness: string,
  provider: string,
  model: string,
  calls: number,
  cached: number | null,
  trial: string | null,
) {
  const tokensIn = calls * (14_000 + Math.floor(urnd() * 16_000));
  const tokensOut = calls * (300 + Math.floor(urnd() * 900));
  u.ev(hoursAgo, "model_call", run, {
    trial,
    round: null,
    agent,
    harness,
    provider,
    model,
    ...callUsage({
      at: iso(hoursAgo),
      calls,
      tokensIn,
      cachedIn: cached === null ? null : Math.floor(tokensIn * cached),
      tokensOut,
      firstTokenMs: 900 + Math.floor(urnd() * 1500),
      callMs: Math.floor((tokensOut / (30 + urnd() * 40)) * 1000) + calls * 1200,
    }),
  });
}

function hillClimb(
  u: Rig,
  run: string,
  hours: number,
  wins: number[],
  opts: { pending?: boolean; held?: boolean } = {},
) {
  u.ev(hours, "run_created", run, {
    campaign: "decode-speed",
    version: 1,
    mode: "hill_climb",
    seed: { repo: "inference-engine", commit: "a1b2c3d4e5f6" },
  });
  // A hill climb's judge measures its starting point first (goal 115), then the rig's noise.
  const ppl = { median: 1, mad: 0.0001, n: 9 };
  u.ev(hours - 0.1, "baseline", run, {
    run,
    job: 1,
    champion_seq: 1,
    commit: "a1b2c3d4e5f6",
    attempt: null,
    blocks: 3,
    runs_per_cell: 3,
    primary: { metric: "tok_per_s", direction: "max" },
    guards: [{ metric: "ppl_ratio", direction: "min", max_total_regression: 0.01 }],
    units: { tok_per_s: "tok/s", ppl_ratio: "ratio" },
    cells: {
      small: { tok_per_s: { median: 182.4, mad: 0.6, n: 9 }, ppl_ratio: ppl },
      large: { tok_per_s: { median: 61.7, mad: 0.3, n: 9 }, ppl_ratio: ppl },
    },
    files: [],
    bytes: 0,
    summary: "tok_per_s small 182 ±0.33%, large 61.7 ±0.49% (median of 3 blocks)",
  });
  u.ev(hours - 0.2, "calibration", run, {
    sigma: 0.0042 + rnd() * 0.004,
    summary: "A/A over 6 blocks",
  });
  let seq = 1;
  let n = 0;
  const total = 48;
  for (let i = 0; i < total; i++) {
    const t = hours - 0.5 - (i * (hours - 1)) / total;
    const id = `a-${run}-${(i + 1).toString().padStart(3, "0")}`;
    const lane = `lane-${(i % 2) + 1}`;
    u.ev(
      t,
      "attempt_recorded",
      id,
      { run, lane, lifecycle: "queued", hypothesis: pick(HYPOTHESES) },
      "agent",
    );
    if (i % 3 === 0)
      u.ev(t + 0.05, "epoch_started", run, {
        planner_valid: rnd() > 0.1,
        source: rnd() > 0.92 ? "fallback" : "planner",
        raw_violations: rnd() > 0.85 ? 1 : 0,
        assignments: [
          { lane: "lane-1", family: "smem-activations", parent: "champion" },
          { lane: "lane-2", family: "split-k", parent: "champion" },
        ],
      });
    u.ev(t - 0.02, "trial_finished", run, {
      attempt: id,
      tokens_in: 9000 + Math.floor(rnd() * 20000),
      tokens_out: 2000 + Math.floor(rnd() * 6000),
      stopped: "submitted",
    });
    // Model use (goal 075): the trial's worker, a round's planner, now and then the teachers
    // (on a subscription, in Claude Code) and the auditor (OpenCode, which does not report the cache).
    modelCall(u, t - 0.03, run, "workers", "pi", "demo-models", "glm-5.1", 28, 0.75, `t-${id}`);
    if (i % 3 === 0)
      modelCall(u, t + 0.04, run, "planner", "pi", "demo-models", "kimi-k3", 1, 0.6, null);
    if (i % 8 === 4)
      modelCall(
        u,
        t - 0.1,
        run,
        "teachers",
        "claude-code",
        "claude-plan",
        "opus-5.5",
        1,
        0.9,
        null,
      );
    if (i === total - 6)
      modelCall(u, t - 0.2, run, "auditor", "opencode", "demo-models", "glm-5.1", 2, null, null);
    const win = wins[n];
    if (win !== undefined && i === Math.floor(((n + 1) * total) / (wins.length + 1))) {
      n++;
      u.ev(t - 0.3, "verdict", id, { verdict: "win_confirmed", delta: win });
      if (opts.held && n === wins.length) {
        u.ev(t - 0.31, "attempt_lifecycle", id, { lifecycle: "awaiting_audit" });
        u.ev(t - 0.31, "audit_requested", id, {
          run,
          reason: `gain ${(win * 100).toFixed(1)}% above the 15% trigger`,
        });
        continue;
      }
      if (opts.pending && n === wins.length) {
        u.ev(t - 0.31, "attempt_lifecycle", id, { lifecycle: "awaiting_approval" });
        u.ev(t - 0.31, "promotion_pending", id, { run });
        continue;
      }
      seq++;
      u.ev(t - 0.32, "attempt_lifecycle", id, { lifecycle: "promoted" });
      u.ev(t - 0.32, "champion_promoted", run, {
        seq,
        attempt: id,
        commit: `c${seq}${"0".repeat(10)}`,
      });
      u.ev(t - 0.33, "champion_published", run, {
        seq,
        repo: "inference-engine",
        base_commit: "a1b2c3d4e5f6",
        tree: `tree-${run}-${seq}`,
        sha256: "0".repeat(64),
        path: `champions/${run}/${seq}.patch`,
      });
      continue;
    }
    const v = pick(VERDICTS);
    u.ev(t - 0.25, "verdict", id, {
      verdict: v,
      delta: v === "neutral" ? (rnd() - 0.5) * 0.01 : v === "regress" ? -0.02 - rnd() * 0.05 : null,
    });
    u.ev(t - 0.26, "attempt_lifecycle", id, { lifecycle: "judged" });
  }
  // Two attempts still being judged.
  u.ev(
    0.3,
    "attempt_recorded",
    `a-${run}-live1`,
    { run, lane: "lane-1", lifecycle: "queued", hypothesis: "tile the scale reads per warp" },
    "agent",
  );
  u.ev(
    0.1,
    "attempt_recorded",
    `a-${run}-live2`,
    {
      run,
      lane: "lane-2",
      lifecycle: "queued",
      hypothesis: "use the read-only cache for the codes",
    },
    "agent",
  );
  u.ev(hours - 1, "directive", run, { kind: "try" }, "supervisor");
  u.ev(hours - 3, "directive", run, { kind: "avoid" }, "supervisor");
}

/**
 * The hill climb decode-speed: decode-a on gpu-1 (an audit hold, two trials at work, its queue
 * and its journal) and decode-b on gpu-2 (a pending approval, and decode-a's champion propagated).
 */
export function hillClimbRigs(): { g1: Rig; g2: Rig } {
  const g1 = new Rig("gpu-1");
  hillClimb(g1, "decode-a", 30, [0.061, 0.043, 0.038, 0.052, 0.024, 0.19], { held: true });
  // The two trials Live shows at work (T1 and T2 below): control counts lanes at work from these.
  g1.ev(9 / 60, "trial_started", "decode-a", {
    lane: "lane-1",
    trial: "t-4f1c9a2e7b3d5c01",
    family: "smem-activations",
    focus: "keep the activation vector in shared memory",
  });
  g1.ev(3 / 60, "trial_started", "decode-a", {
    lane: "lane-2",
    trial: "t-9b2e6d4a1c8f3e77",
    family: "split-k",
    focus: "split K across two warps to hide load latency",
  });
  // decode-a's experiment queue: tried, in progress, up next and a lane's idea.
  const experiment = (
    hoursAgo: number,
    id: string,
    by: string,
    family: string,
    title: string,
    why: string,
    state: "queued" | "proposed" = "queued",
  ) =>
    g1.ev(
      hoursAgo,
      "experiment_added",
      "decode-a",
      { id, by, family, title, why, state, position: "end" },
      by,
    );
  experiment(
    10,
    "x-01",
    "planner",
    "tiling",
    "unroll the 4-row tile by 2",
    "the 4-row tile left registers free",
  );
  g1.ev(9.6, "experiment_assigned", "decode-a", {
    id: "x-01",
    lane: "lane-1",
    trial: "t-1a2b3c4d",
  });
  g1.ev(9, "experiment_finished", "decode-a", {
    id: "x-01",
    lane: "lane-1",
    attempt: "a-decode-a-035",
  });
  experiment(
    8,
    "x-02",
    "owner",
    "zero-point",
    "precompute the per-group zero point",
    "it might save a subtract per element",
  );
  g1.ev(
    7.5,
    "experiment_dropped",
    "decode-a",
    { id: "x-02", by: "owner", why: "measured slower twice in earlier runs" },
    "owner",
  );
  experiment(
    3,
    "x-03",
    "teachers",
    "smem-activations",
    "keep the activation vector in shared memory",
    "every row tile reads the same vector from global memory",
  );
  experiment(
    2,
    "x-04",
    "planner",
    "split-k",
    "split K across two warps to hide load latency",
    "lane-2's last change showed the loads stall",
  );
  experiment(
    1.5,
    "x-05",
    "owner",
    "vector-loads",
    "vectorize the scale loads (half2)",
    "the profile shows scalar loads in the hot loop",
  );
  experiment(
    1.2,
    "x-06",
    "planner",
    "prefetch",
    "prefetch the next block while reducing",
    "the reduction leaves the memory unit idle",
  );
  experiment(
    0.8,
    "x-07",
    "auditor",
    "check",
    "re-measure the held change on the large cases",
    "its gain on large inputs is far above the other cases",
  );
  experiment(
    0.3,
    "x-08",
    "lane-2",
    "memory",
    "use a wider memory transaction for the codes",
    "the codes are read 4 bytes at a time",
    "proposed",
  );
  g1.ev(9 / 60, "experiment_assigned", "decode-a", {
    id: "x-03",
    lane: "lane-1",
    trial: "t-4f1c9a2e7b3d5c01",
  });
  g1.ev(3 / 60, "experiment_assigned", "decode-a", {
    id: "x-04",
    lane: "lane-2",
    trial: "t-9b2e6d4a1c8f3e77",
  });
  g1.ev(
    9 / 60,
    "planner_handout",
    "decode-a",
    {
      round: 17,
      assignments: [
        { lane: "lane-1", experiment: "x-03", why: "builds on lane-1's last direction" },
        { lane: "lane-2", experiment: "x-04", why: "next in the queue; no lane is on it" },
      ],
      notes: "",
    },
    "planner",
  );
  // decode-a's journal: the agents' field notes (goal 065).
  const note = (hoursAgo: number, id: number, by: string, body: Record<string, unknown>) =>
    g1.ev(hoursAgo, "journal_note", "decode-a", { id, by, ...body }, by);
  note(9.2, 1, "lane-1", {
    kind: "observation",
    text: "Unrolling past 2 stops paying here: the loop waits on memory reads, not on instructions.",
    about: { type: "attempt", id: "a-decode-a-035" },
    lane: "lane-1",
  });
  note(5, 2, "planner", {
    kind: "decision",
    text: "Kept lane-1 on shared memory: it has that kernel in its context from its last trial.",
    about: { type: "round", id: "15" },
  });
  note(4.4, 3, "lane-2", {
    kind: "surprise",
    text: "A 19% gain from one change is far above anything before it on the large cases.",
    about: { type: "attempt", id: "a-decode-a-042" },
    lane: "lane-2",
  });
  note(4.3, 4, "auditor:auditor-a", {
    kind: "question",
    text: "Does the large case reuse the same input on every call? If so, the gain may be the cache.",
  });
  note(1, 5, "teachers:teacher-a", {
    kind: "lesson",
    text: "A gain far above the rig's noise needs a fresh input on every call before it can count.",
  });
  const g2 = new Rig("gpu-2");
  hillClimb(g2, "decode-b", 26, [0.048, 0.031, 0.027, 0.036], { pending: true });
  g2.ev(5, "propagation_received", "decode-b", {
    attempt: "a-prop-1",
    source_rig: "gpu-1",
    source_run: "decode-a",
    source_seq: 5,
    tree: "tree-decode-a-5",
    result: "judging",
  });
  g2.ev(4.5, "propagation_accepted", "decode-b", { attempt: "a-prop-1", verdict: "win_confirmed" });
  return { g1, g2 };
}
