import { pick, Rig } from "./shared.ts";

/** The goal campaign regex-dfa, part way, on gpu-3. */
export function goalRig(): Rig {
  const g3 = new Rig("gpu-3");
  g3.ev(20, "run_created", "regex-dfa-1", {
    campaign: "regex-dfa",
    version: 1,
    mode: "goal",
    seed: { repo: "text-search", commit: "0a1b2c3d4e5f" },
  });
  for (let i = 0; i < 22; i++) {
    const t = 19 - i * 0.8;
    const id = `a-rx-${(i + 1).toString().padStart(3, "0")}`;
    g3.ev(
      t,
      "attempt_recorded",
      id,
      {
        run: "regex-dfa-1",
        lane: `lane-${(i % 2) + 1}`,
        lifecycle: "queued",
        hypothesis: pick([
          "a lazy DFA that caches up to 4096 states",
          "a SIMD prefilter for literal prefixes",
          "Unicode classes compiled to byte ranges",
          "a one-pass NFA for anchored patterns",
          "bounded backtracking for short inputs",
          "a memchr fast path for single-byte literals",
        ]),
      },
      "agent",
    );
    g3.ev(t - 0.4, "verdict", id, {
      verdict: pick(["goal_progress", "goal_screened", "invalid", "neutral", "invalid"]),
      delta: null,
    });
    g3.ev(t - 0.41, "attempt_lifecycle", id, { lifecycle: "judged" });
    g3.ev(t - 0.05, "trial_finished", "regex-dfa-1", {
      attempt: id,
      tokens_in: 30000,
      tokens_out: 9000,
      stopped: "submitted",
    });
    if (i % 2 === 0)
      g3.ev(t + 0.1, "epoch_started", "regex-dfa-1", { planner_valid: true, source: "planner" });
  }
  g3.ev(1.2, "goal_report", "regex-dfa-1", {
    goals: [
      { goal: "builds", status: "met", reasons: "verifier builds passed on info" },
      { goal: "conformance", status: "met", reasons: "verifier conformance passed on suite-a" },
      { goal: "unicode", status: "met", reasons: "verifier unicode passed on ucd-cases" },
      {
        goal: "same-matches",
        status: "unmet",
        reasons:
          "corpus-a: invalid: 3 of 1200 patterns match differently from the backtracking engine",
      },
      {
        goal: "memory",
        status: "unmet",
        reasons: "memory: invalid: the DFA for pattern set B needs 412 MiB, above 256 MiB",
      },
      { goal: "streaming", status: "not_runnable", reasons: "the streaming API is not built yet" },
      {
        goal: "throughput",
        status: "unmet",
        reasons: "corpus-b: invalid: 1.8 GB/s is below 2.5 GB/s",
      },
      {
        goal: "latency",
        status: "unmet",
        reasons: "latency: invalid: p99 match latency 3.1 ms is above 1.0 ms",
      },
      {
        goal: "api-unchanged",
        status: "met",
        reasons: "verifier api-unchanged passed on public-headers",
      },
    ],
  });
  return g3;
}
