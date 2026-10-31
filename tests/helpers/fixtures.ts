/** Example contracts for tests. Generic names only: this repository is public. */

export const hillClimbFixture = {
  schema_version: 1,
  campaign: "smoke-matmul",
  version: 1,
  title: "Smoke: speed up a small CPU kernel",
  mode: "hill_climb",
  project: { repo: "smoke-kernels", commit: "0000000000000000000000000000000000000001" },
  target: { type: "cpu", class: "generic-x86" },
  objective: { primary: { metric: "gflops", direction: "max", min_effect: 0.01 } },
  guards: [
    { metric: "max_abs_error", direction: "min", max_step_regression: 0, max_total_regression: 0 },
  ],
  cells: ["n256", "n512"],
  editable_paths: ["src/kernel/**"],
  forbidden_patterns: ["clock_gettime", "gettimeofday"],
} as const;

export const goalFixture = {
  schema_version: 1,
  campaign: "quant-validation",
  version: 1,
  title: "Validate a quantized model against its goals",
  mode: "goal",
  project: { repo: "engine", commit: "0000000000000000000000000000000000000002" },
  target: { type: "cuda-gpu", class: "sm89-24g" },
  models: [
    { name: "candidate.gguf", sha256: "a".repeat(64) },
    { name: "reference.gguf", sha256: "b".repeat(64) },
  ],
  goals: [
    {
      id: "resident",
      description: "Model fully resident on one device with headroom",
      verify: { type: "metric_threshold", metric: "free_mib", op: ">=", value: 2048 },
    },
    {
      id: "decode-speed",
      description: "Plain decode speed target",
      verify: { type: "metric_threshold", metric: "decode_tps_geomean", op: ">=", value: 55 },
    },
    {
      id: "correctness",
      description: "Correctness gates pass",
      verify: { type: "code", verifier: "correctness-gates" },
    },
  ],
  deliverable: "per-goal verdicts with receipts",
  insufficient: ["short-context numbers only", "results without correctness gates"],
  adversarial_checklist: ["changed kernel actually dispatched", "no CPU fallback"],
  editable_paths: ["src/**"],
} as const;

export const researchFixture = {
  schema_version: 1,
  campaign: "topic-survey",
  version: 1,
  title: "Survey a research topic",
  mode: "research",
  project: { repo: "research-notes" },
  topic: "Stateless agents for long-horizon research",
  questions: ["What harness designs keep agents productive for days?"],
  min_duration: "2h",
  max_duration: "4h",
} as const;
