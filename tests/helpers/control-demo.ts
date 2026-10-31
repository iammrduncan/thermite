import type { ControlStore } from "../../src/control/store/index.ts";
import type { LiveEntry } from "../../src/core/live.ts";
import { ingestReport } from "./control-store.ts";

/**
 * A realistic control store for dashboard tests and demos: three rigs, a goal campaign with two
 * runs (one with an attempt held for an audit and another that did not hold on fresh runs, one
 * with lanes at work and the judge validating), and
 * a hill climb whose rig waits for the owner's approval of a confirmed win, with an earlier one the
 * auditor blocked. Every event has the shape the harness writes; names are generic.
 */
export async function seedDemo(store: ControlStore, now = Date.now()): Promise<void> {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const rig = async (
    id: string,
    events: [number, string, string | null, Record<string, unknown>][],
    summary: Record<string, unknown>,
  ) => {
    await ingestReport(store, {
      rig: id,
      ledger_id: `ledger-${id}`,
      cursor: 0,
      next: events.length,
      generated_at: at(0),
      // In time order, as the ledger writes them (the sort is stable for events at one time).
      events: [...events]
        .sort((x, y) => y[0] - x[0])
        .map(([ago, kind, subject, body], i) => ({
          id: i + 1,
          at: at(ago),
          actor: "harness",
          kind,
          subject,
          body,
        })),
      summary,
    });
  };
  const live = (id: string, lines: [number, Omit<LiveEntry, "seq" | "at">][]) =>
    store.liveLines.add(
      id,
      `log-${id}`,
      lines.map(([ago, e], i) => ({ seq: i + 1, at: at(ago), ...e })),
      true,
    );

  const goals = (realtime: string) => [
    {
      goal: "builds",
      description: "the decoder builds with the SIMD backend",
      status: "met",
      reasons: "the decoder builds with the SIMD backend",
    },
    { goal: "vectors", status: "met", reasons: "every conformance vector decodes bit-exact" },
    { goal: "recordings", status: "met", reasons: "the sample recordings decode without errors" },
    { goal: "simd", status: "met", reasons: "the SIMD routines match the scalar reference" },
    { goal: "realtime", status: "unmet", reasons: realtime },
    {
      goal: "latency",
      status: "unmet",
      reasons: "not run: it requires realtime, which did not pass",
    },
    {
      goal: "quality",
      status: "unmet",
      reasons: "not run: it requires latency, which did not pass",
    },
    {
      goal: "power",
      status: "unmet",
      reasons: "not run: it requires realtime, which did not pass",
    },
  ];
  const seedGoals = goals("a frame takes 31 ms against a 20 ms budget").map((g) =>
    ["vectors", "recordings", "simd"].includes(g.goal)
      ? { ...g, status: "unmet", reasons: "the decoder has no SIMD backend yet" }
      : g,
  );

  // ---------------------------------------------------------------- rig-a: dec-1, an attempt held for an audit
  await rig(
    "rig-a",
    [
      [
        600,
        "run_created",
        "dec-1",
        {
          campaign: "opus-simd",
          mode: "goal",
          seed: { repo: "decoder", commit: "4be1c0ffee00112233445566778899aabbccddee" },
        },
      ],
      [598, "job_queued", "1", { attempt: null, kind: "validate" }],
      [598, "job_leased", "1", { fence: 1, until: at(560) }],
      [
        574,
        "goal_report",
        "dec-1",
        { run: "dec-1", champion_seq: 1, goals: seedGoals, complete: false },
      ],
      [574, "job_finished", "1", { state: "done", result: { champion_seq: 1 } }],
      [
        573,
        "epoch_started",
        "dec-1",
        {
          n: 1,
          source: "planner",
          planner_tries: 1,
          planner_valid: true,
          raw_violations: 0,
          directives: [],
          assignments: [
            { lane: "lane-1", family: "simd-dispatch", parent: "champion" },
            { lane: "lane-2", family: "bit-reader", parent: "champion" },
          ],
        },
      ],
      [
        470,
        "attempt_recorded",
        "a-7e1a0001",
        {
          run: "dec-1",
          lane: "lane-1",
          lifecycle: "queued",
          commit: "3c0ffee100112233445566778899aabbccddeeff",
          parent: "4be1c0ffee00112233445566778899aabbccddee",
          hypothesis:
            "Add a dispatch table that picks SIMD routines at start-up from the CPU's features, and route the inverse transform through it, with the scalar code as the fallback.",
          known_flaws: [
            "The filter bank still runs the scalar code.",
            "Only x86 SIMD is covered; ARM builds use the scalar fallback.",
          ],
          files: [
            { path: "src/dispatch.c", added: 120, removed: 4 },
            { path: "src/simd/imdct_avx2.c", added: 80, removed: 0 },
            { path: "tests/vectors.bin", added: null, removed: null },
          ],
          files_total: 3,
        },
      ],
      [
        470,
        "trial_finished",
        "dec-1",
        {
          trial: "t-1111",
          lane: "lane-1",
          epoch: 1,
          family: "simd-dispatch",
          attempt: "a-7e1a0001",
          stopped: "submitted",
          turns: 212,
          tokens_in: 4_100_000,
          tokens_out: 160_000,
          error: null,
        },
      ],
      [469, "job_queued", "2", { attempt: "a-7e1a0001", kind: "evaluate" }],
      [469, "job_leased", "2", { fence: 1, until: at(400) }],
      [
        330,
        "verdict",
        "a-7e1a0001",
        { id: 1, verdict: "goal_screened", delta: null, supersedes: null },
      ],
      [
        330,
        "job_finished",
        "2",
        {
          state: "done",
          result: {
            verdict: "goal_screened",
            gained: ["vectors", "recordings", "simd"],
            lost: [],
            unsure: [],
          },
        },
      ],
      [330, "job_queued", "3", { attempt: "a-7e1a0001", kind: "confirm" }],
      [329, "job_leased", "3", { fence: 1, until: at(250) }],
      [
        174,
        "verdict",
        "a-7e1a0001",
        {
          id: 2,
          verdict: "goal_progress",
          delta: null,
          reasons: "newly meets vectors, recordings and simd; loses none; realtime still unmet",
          supersedes: null,
        },
      ],
      [174, "promotion_blocked", "a-7e1a0001", { reason: "audit required: declared flaws" }],
      [
        174,
        "audit_requested",
        "a-7e1a0001",
        { audit: 1, run: "dec-1", reason: "declared flaws", expected_seq: 1 },
      ],
      [174, "attempt_lifecycle", "a-7e1a0001", { lifecycle: "awaiting_audit" }],
      [
        174,
        "job_finished",
        "3",
        {
          state: "done",
          result: {
            verdict: "goal_progress",
            gained: ["vectors", "recordings", "simd"],
            promoted: false,
            waiting: "audit",
          },
        },
      ],
      [
        460,
        "attempt_recorded",
        "a-7e1a0002",
        {
          run: "dec-1",
          lane: "lane-2",
          lifecycle: "queued",
          commit: "7e1a000255aa66bb77cc88dd99ee00ff11223344",
          parent: "4be1c0ffee00112233445566778899aabbccddee",
          hypothesis: "Read the bitstream 64 bits at a time instead of byte by byte.",
          known_flaws: [],
        },
      ],
      [170, "job_queued", "4", { attempt: "a-7e1a0002", kind: "evaluate" }],
      [170, "job_leased", "4", { fence: 1, until: at(100) }],
      [
        95,
        "verdict",
        "a-7e1a0002",
        { id: 3, verdict: "goal_screened", delta: null, supersedes: null },
      ],
      [
        95,
        "job_finished",
        "4",
        {
          state: "done",
          result: {
            verdict: "goal_screened",
            gained: ["vectors"],
            lost: [],
            unsure: [],
          },
        },
      ],
      [95, "job_queued", "5", { attempt: "a-7e1a0002", kind: "confirm" }],
      [94, "job_leased", "5", { fence: 1, until: at(20) }],
      [
        20,
        "verdict",
        "a-7e1a0002",
        {
          id: 4,
          verdict: "not_confirmed",
          delta: null,
          reasons: "confirmation failed: no longer met: vectors; vs champion seq 1",
          supersedes: null,
        },
      ],
      [20, "attempt_lifecycle", "a-7e1a0002", { lifecycle: "judged" }],
      [
        20,
        "job_finished",
        "5",
        { state: "done", result: { verdict: "not_confirmed", gained: [] } },
      ],
      [18, "run_status", "dec-1", { status: "paused", reason: "moved to rig-b as dec-2" }],
    ],
    { jobs: { done: 5 } },
  );

  // ---------------------------------------------------------------- rig-b: dec-2, at work
  await rig(
    "rig-b",
    [
      [
        70,
        "run_created",
        "dec-2",
        {
          campaign: "opus-simd",
          mode: "goal",
          seed: { repo: "decoder", commit: "3c0ffee100112233445566778899aabbccddeeff" },
        },
      ],
      // How each goal is checked, as the rig's kit runs it (goal 082).
      [
        70,
        "goal_checks",
        "dec-2",
        {
          kit: {
            name: "opus-kit",
            repo: "opus-kit",
            commit: "0ddba11c0ffee00112233445566778899aabbcc",
          },
          run_command: ["{kit:run/decode.sh}", "{build:out/decoder}", "{params}", "{out}"],
          timeout_s: 120,
          goals: [
            {
              goal: "builds",
              description: "the decoder builds with the SIMD backend",
              required: true,
              how: "verifier",
              verifier: "builds",
              requires: [],
              priority: 1,
              cells: [
                {
                  name: "smoke",
                  held_out: false,
                  params: { backend: "simd", frames: 10 },
                  args: "backend=simd\nframes=10",
                  timeout_s: 120,
                },
              ],
              problems: [],
            },
            {
              goal: "vectors",
              description: "every conformance vector decodes bit-exact",
              required: true,
              how: "verifier",
              verifier: "vectors",
              requires: ["builds"],
              priority: 10,
              cells: [
                {
                  name: "conformance",
                  held_out: false,
                  params: { set: "rfc8251", mode: "bit-exact" },
                  args: "set=rfc8251\nmode=bit-exact",
                  timeout_s: 900,
                },
                { name: "conformance-held", held_out: true, timeout_s: 900 },
              ],
              problems: [],
            },
            {
              goal: "realtime",
              description: "a 20 ms frame decodes in under 20 ms",
              required: true,
              how: "threshold",
              metric: "frame_ms",
              op: "<",
              value: 20,
              unit: "ms",
              reps: 5,
              cells: [
                {
                  name: "speech-48k",
                  held_out: false,
                  params: { input: "speech-48k.opus", frames: 5000 },
                  args: "input=speech-48k.opus\nframes=5000",
                  timeout_s: 120,
                },
              ],
              problems: [],
            },
          ],
        },
      ],
      [70, "job_queued", "1", { attempt: null, kind: "validate" }],
      [69, "job_leased", "1", { fence: 1, until: at(40) }],
      [
        46,
        "goal_report",
        "dec-2",
        {
          run: "dec-2",
          champion_seq: 1,
          goals: goals(
            "the profile shows the scalar filter bank on the hot path; a frame takes 26 ms against a 20 ms budget",
          ),
          complete: false,
        },
      ],
      [46, "job_finished", "1", { state: "done", result: { champion_seq: 1 } }],
      [
        64,
        "epoch_started",
        "dec-2",
        {
          n: 1,
          source: "planner",
          planner_tries: 1,
          planner_valid: true,
          raw_violations: 0,
          directives: [],
          assignments: [
            { lane: "lane-1", family: "filter-bank", parent: "champion" },
            { lane: "lane-2", family: "range-decoder", parent: "champion" },
          ],
        },
      ],
      [
        63,
        "trial_started",
        "dec-2",
        {
          trial: "t-3331",
          lane: "lane-1",
          epoch: 1,
          family: "filter-bank",
          focus: "vectorize the filter bank so a frame fits its time budget",
        },
      ],
      [
        12,
        "command",
        "c0ffee00-0000-4000-8000-000000000001",
        { kind: "message_agent", accepted: true },
      ],
      [9, "job_queued", "2", { attempt: null, kind: "calibrate" }],
      [8, "job_leased", "2", { fence: 1, until: at(-20) }],
    ],
    { jobs: { leased: 1, queued: 0, done: 1 } },
  );
  live("rig-b", [
    [65, { source: "planner", kind: "status", text: "planning round 1 (2 lanes)", run: "dec-2" }],
    [
      64,
      {
        source: "planner",
        kind: "text",
        text: "epoch 1: planned by the model\nlane-1: filter-bank, vectorize the filter bank so a frame fits its time budget\nlane-2: range-decoder, a branch-free range decoder",
        run: "dec-2",
      },
    ],
    [
      63,
      {
        source: "trial:t-0a1b2c3d4e5f6071",
        kind: "status",
        text: "trial on lane-1: filter-bank, vectorize the filter bank so a frame fits its time budget (from the champion, seq 1)",
        lane: "lane-1",
        run: "dec-2",
      },
    ],
    [
      63,
      {
        source: "trial:t-1b2c3d4e5f607182",
        kind: "status",
        text: "trial on lane-2: range-decoder, a branch-free range decoder (from the champion, seq 1)",
        lane: "lane-2",
        run: "dec-2",
      },
    ],
    [60, { source: "judge", kind: "log", text: "validate dec-2: started", run: "dec-2" }],
    [
      46,
      {
        source: "judge",
        kind: "log",
        text: "validate dec-2: done",
        run: "dec-2",
      },
    ],
    [
      6,
      {
        source: "trial:t-0a1b2c3d4e5f6071",
        kind: "tool",
        text: "run timeout 270 make -C build bench-decode 2>&1 | tail -3",
        lane: "lane-1",
        run: "dec-2",
      },
    ],
    [
      2,
      {
        source: "trial:t-0a1b2c3d4e5f6071",
        kind: "result",
        text: "run (41207 ms): exit 0\ndecode: 1000 frames, 23.8 ms per frame",
        lane: "lane-1",
        run: "dec-2",
      },
    ],
    [
      1,
      {
        source: "trial:t-1b2c3d4e5f607182",
        kind: "tool",
        text: "read src/range_dec.c",
        lane: "lane-2",
        run: "dec-2",
      },
    ],
    [8, { source: "judge", kind: "log", text: "calibrate dec-2: started", run: "dec-2" }],
  ]);

  // ---------------------------------------------------------------- rig-c: a hill climb, approvals
  const champ = (seq: number, ago: number, attempt: string, delta: number) =>
    [
      [
        ago + 30,
        "attempt_recorded",
        attempt,
        {
          run: "sum-1",
          lane: seq % 2 ? "lane-1" : "lane-2",
          lifecycle: "queued",
          commit: `${attempt.slice(2)}00000000000000000000000000000000`.slice(0, 40),
          parent: "0".repeat(40),
          hypothesis: `step ${seq}: unroll the inner loop further`,
          known_flaws: [],
        },
      ],
      [ago + 1, "verdict", attempt, { id: seq, verdict: "win_confirmed", delta, supersedes: null }],
      [
        ago,
        "champion_promoted",
        "sum-1",
        { seq, attempt, commit: `${attempt.slice(2)}`.padEnd(40, "0") },
      ],
    ] as [number, string, string | null, Record<string, unknown>][];
  await rig(
    "rig-c",
    [
      [
        3000,
        "run_created",
        "sum-1",
        {
          campaign: "sum-speed",
          mode: "hill_climb",
          seed: { repo: "sum", commit: "0".repeat(40) },
        },
      ],
      [2990, "calibration", "sum-1", { sigma: 0.012, summary: "6 A/A blocks" }],
      // The agents' field notes and a research note (goal 065).
      [
        690,
        "journal_note",
        "sum-1",
        {
          id: 1,
          by: "lane-1",
          kind: "observation",
          text: "Unrolling past 8 stops paying here: the loop waits on memory reads, not on instructions.",
          about: { type: "attempt", id: "a-11110003" },
          lane: "lane-1",
        },
      ],
      [
        650,
        "journal_note",
        "sum-1",
        {
          id: 2,
          by: "planner",
          kind: "decision",
          text: "Kept lane-2 on the reduction order: it has that code in its context from its last trial.",
          about: { type: "round", id: "12" },
        },
      ],
      [
        320,
        "journal_note",
        "sum-1",
        {
          id: 3,
          by: "lane-2",
          kind: "surprise",
          text: "A 240% gain from one change is far above anything before it. The result may be cached between calls.",
          about: { type: "attempt", id: "a-9c9c0001" },
          lane: "lane-2",
        },
      ],
      [
        230,
        "journal_note",
        "sum-1",
        {
          id: 4,
          by: "auditor:auditor-a",
          kind: "lesson",
          text: "A gain far above the rig's noise needs a fresh input on every call before it can count.",
        },
      ],
      [
        210,
        "research_note",
        "sum-1",
        {
          note: 1,
          by: "lane-1",
          text: "The benchmark reads 64 MB per call; at 20 GB/s that alone takes 3.2 ms.",
          sources: [],
        },
      ],
      ...champ(2, 2400, "a-11110001", 0.061),
      ...champ(3, 1500, "a-11110002", 0.044),
      ...champ(4, 700, "a-11110003", 0.032),
      [
        200,
        "attempt_recorded",
        "a-5b5b0001",
        {
          run: "sum-1",
          lane: "lane-2",
          lifecycle: "queued",
          commit: "5b5b000100000000000000000000000000000000",
          parent: "1111000300000000000000000000000000000000",
          hypothesis: "Replace the scalar loop with a vectorized reduction over 8 lanes.",
          known_flaws: [],
        },
      ],
      [190, "job_queued", "11", { attempt: "a-5b5b0001", kind: "evaluate" }],
      [
        150,
        "job_finished",
        "11",
        { state: "done", result: { verdict: "win_screened", delta: 0.152, baseline_seq: 4 } },
      ],
      [
        150,
        "verdict",
        "a-5b5b0001",
        { id: 11, verdict: "win_screened", delta: 0.152, supersedes: null },
      ],
      [
        90,
        "verdict",
        "a-5b5b0001",
        {
          id: 12,
          verdict: "win_confirmed",
          delta: 0.142,
          ci_low: 0.091,
          ci_high: 0.196,
          reasons: "better beyond min_effect on fresh data",
          supersedes: null,
        },
      ],
      [
        90,
        "job_finished",
        "12",
        {
          state: "done",
          result: { verdict: "win_confirmed", promoted: false, waiting: "owner_approval" },
        },
      ],
      [
        90,
        "promotion_pending",
        "a-5b5b0001",
        { run: "sum-1", expected_seq: 4, commit: "5b5b000100000000000000000000000000000000" },
      ],
      [90, "attempt_lifecycle", "a-5b5b0001", { lifecycle: "awaiting_approval" }],
      [
        400,
        "attempt_recorded",
        "a-9c9c0001",
        {
          run: "sum-1",
          lane: "lane-1",
          lifecycle: "queued",
          commit: "9c9c000100000000000000000000000000000000",
          parent: "1111000300000000000000000000000000000000",
          hypothesis: "Cache the sum between calls.",
          known_flaws: [],
        },
      ],
      [
        300,
        "verdict",
        "a-9c9c0001",
        { id: 13, verdict: "win_confirmed", delta: 2.4, supersedes: null },
      ],
      [
        300,
        "audit_requested",
        "a-9c9c0001",
        { audit: 3, run: "sum-1", reason: "gain 240.0% above 100%", expected_seq: 4 },
      ],
      [
        240,
        "audit_decided",
        "a-9c9c0001",
        {
          audit: 3,
          decision: "block",
          reasons:
            "The change caches the result between calls, so the benchmark measures a cache hit, not the sum.",
        },
      ],
    ],
    { jobs: { queued: 0, leased: 0, done: 12 } },
  );
  store.reportedRigs.setSupervisor("rig-c", {
    at: at(1),
    advisors: {
      teacher_runs: 4,
      directive_sets: 3,
      directives: 7,
      audits: 1,
      reviews: 0,
      errors: 0,
      tokens_in: 1,
      tokens_out: 1,
      usd: 2.4,
    },
  });
  store.reportedRigs.setSupervisor("rig-a", { at: at(1), advisors: null });
}
