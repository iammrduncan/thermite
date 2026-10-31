import type { ControlStore } from "../../../src/control/store/index.ts";
import { iso, now } from "./shared.ts";

// Live sessions: the planner, the judge, two workers and the supervisor on gpu-1.
type Line = {
  source: string;
  kind: "text" | "thinking" | "tool" | "result" | "message" | "status" | "log";
  text: string;
  lane?: string;
  run?: string;
};

/** The live sessions' lines, on gpu-1 and on cpu-1. */
export function liveSessions(store: ControlStore): void {
  const lines = (rig: string, items: Line[], minutesAgo: number) => {
    let seq = 0;
    store.liveLines.add(
      rig,
      "demo-log",
      items.map((l, n) => ({
        seq: ++seq,
        at: new Date(now - (minutesAgo - n * 0.4) * 60_000).toISOString(),
        ...l,
      })),
      true,
    );
  };
  const T1 = "trial:t-4f1c9a2e7b3d5c01";
  const T2 = "trial:t-9b2e6d4a1c8f3e77";
  lines(
    "gpu-1",
    [
      {
        source: "planner",
        kind: "status",
        text: "planning epoch 17 (2 lanes)",
        run: "decode-a",
      },
      {
        source: "planner",
        kind: "text",
        text: "epoch 17: planned by the model\nlane-1: smem-activations, keep the activation vector in shared memory\nlane-2: split-k, split K across two warps to hide load latency",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "status",
        text: "trial on lane-1: smem-activations, keep the activation vector in shared memory (from the champion, seq 6)",
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "thinking",
        text: "The GEMV reads the activation vector once per row tile. Staging it in shared memory should cut global loads; I need to check the tile size against the 48 KB static limit first.",
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "text",
        text: "I'll read the decode GEMV kernel first, then stage the activation vector in shared memory for each row tile.",
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "tool",
        text: 'read_file {"path":"src/kernels/gemv.cu"}',
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "result",
        text: "read_file (4 ms): __global__ void gemv_rows(const block_q4 * w, const float * x, float * y, int k) {\n  const int row = blockIdx.x * ROWS + threadIdx.y;\n  ...",
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "tool",
        text: 'write_file {"path":"src/kernels/gemv.cu","content":"…"}',
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "result",
        text: "write_file (2 ms): ok, 214 lines",
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "tool",
        text: 'run {"command":"cmake --build build -j4 --target bench && ./build/bench --check"}',
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "result",
        text: "run (48210 ms): exit 0\n[100%] Built target bench\ncheck: 4096 rows, max abs error 0.0000, ok",
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "message",
        text: "Owner: Keep the tile at 128 rows; 256 spilled registers last time.",
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "text",
        text: "Understood: keeping the tile at 128 rows. I'll time it on the device before submitting.",
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "tool",
        text: 'dev_run {"command":"./build/bench --cells small,large"}',
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T1,
        kind: "result",
        text: "dev_run (9120 ms): small 1.21 ms, large 3.87 ms (diagnostic only)",
        lane: "lane-1",
        run: "decode-a",
      },
      {
        source: T2,
        kind: "status",
        text: "trial on lane-2: split-k, split K across two warps to hide load latency (from the champion, seq 6)",
        lane: "lane-2",
        run: "decode-a",
      },
      {
        source: T2,
        kind: "text",
        text: "Splitting K across two warps per row; the partial sums reduce through shuffles.",
        lane: "lane-2",
        run: "decode-a",
      },
      {
        source: T2,
        kind: "tool",
        text: 'search {"pattern":"__shfl_down_sync"}',
        lane: "lane-2",
        run: "decode-a",
      },
      {
        source: T2,
        kind: "result",
        text: "search (11 ms): src/kernels/reduce.cuh:14",
        lane: "lane-2",
        run: "decode-a",
      },
      {
        source: "judge",
        kind: "log",
        text: "evaluate a-decode-a-live1: started",
        run: "decode-a",
      },
      { source: "judge", kind: "log", text: "build c6000000000: ok in 41 s", run: "decode-a" },
      { source: "judge", kind: "log", text: "candidate · small: ok", run: "decode-a" },
      { source: "judge", kind: "log", text: "champion · small: ok", run: "decode-a" },
      { source: "judge", kind: "log", text: "candidate · large: ok", run: "decode-a" },
      {
        source: "supervisor",
        kind: "status",
        text: "advisor round done: 2 teacher runs, 1 directive sets, 0 audits, 0 reviews, 0 errors",
      },
    ],
    9,
  );
  // The supervisor's lines for the research run's reviews (goal 116): each reviewer's answer, and a
  // third review whose tries failed on the provider, which the Reviews tab shows from Live.
  store.liveLines.add(
    "cpu-1",
    "demo-supervisor",
    [
      [
        1.92,
        "text",
        "review 2 of the research questions, reviewer-1: fail. 2 of the questions answered. Question 3 still has open gaps.",
      ],
      [
        1.91,
        "text",
        "review 2 of the research questions, reviewer-2: fail. 2 of the questions answered. Question 3 still has open gaps.",
      ],
      [1.9, "status", "review 2: the review panel did not pass it"],
      [
        0.55,
        "text",
        "review 3 of the research questions, reviewer-1: fail. 3 of the questions answered. Question 3's new card needs a second site.",
      ],
      [
        0.54,
        "status",
        "review 3: 2 of 3 reviewers of the review panel answered (reviewer-2: the provider refused: 429 too many requests)",
      ],
      [
        0.05,
        "status",
        "review 3: 1 of 3 reviewers of the review panel answered (reviewer-2: the provider refused: 429 too many requests; reviewer-3: no answer in 15 min)",
      ],
    ].map(([h, kind, text], n) => ({
      seq: n + 1,
      at: iso(Number(h)),
      source: "supervisor",
      kind: kind as "text" | "status",
      text: String(text),
      run: "noise-survey",
    })),
    false,
  );
}
