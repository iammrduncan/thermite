import assert from "node:assert/strict";
import { test } from "node:test";
import { DETAIL_CHARS } from "../../src/control/run-lists.ts";
import { ControlStore, OPEN_TRIAL_LINES } from "../../src/control/store/index.ts";
import { SESSION_LINES, trialSession } from "../../src/control/trial-session.ts";
import type { LiveEntry } from "../../src/core/live.ts";
import { controlStore, ingestReport } from "../helpers/control-store.ts";

const at = (i: number) => new Date(Date.UTC(2026, 9, 25, 8, 0, i)).toISOString();

/** The runs rig-a created, as its reports put them in control's run registry. */
function runsOn(store: ControlStore, ...runs: string[]): void {
  for (const run of runs)
    store.runRegistry.registerRunCreated("rig-a", "l-1", {
      kind: "run_created",
      subject: run,
      body: { campaign: "c" },
      at: at(0),
    });
}

/** Two trials on lane-1 and lane-2 of r-1, one on r-2, and the judge's lines between them. */
function rigWithTrials(): ControlStore {
  const store = new ControlStore(":memory:");
  const lines: LiveEntry[] = [];
  const add = (
    source: string,
    kind: LiveEntry["kind"],
    text: string,
    lane?: string,
    run?: string,
  ) =>
    lines.push({
      seq: lines.length + 1,
      at: at(lines.length),
      source,
      kind,
      text,
      ...(lane ? { lane } : {}),
      ...(run ? { run } : {}),
    });
  add(
    "trial:t-a",
    "status",
    "trial on lane-1: shared staging, stage the activations",
    "lane-1",
    "r-1",
  );
  add("trial:t-b", "status", "trial on lane-2: loop order, interleave the rows", "lane-2", "r-1");
  for (let i = 0; i < 450; i++) {
    add("trial:t-b", "tool", `bash: python3 devbench.py cand ${i}`, "lane-2", "r-1");
    add("trial:t-b", "result", `cand ${i}: 13.${i % 10} tok/s`, "lane-2", "r-1");
    if (i % 100 === 0) add("judge", "log", `job ${i} building`);
  }
  add("trial:t-a", "tool", "submit_attempt", "lane-1", "r-1");
  add("trial:t-a", "status", "trial ended: submitted a-1", "lane-1", "r-1");
  add("trial:t-c", "status", "trial on lane-1: other run", "lane-1", "r-2");
  store.liveLines.add("rig-a", "log-1", lines, true);
  runsOn(store, "r-1", "r-2");
  return store;
}
const base = { run: "r-1", after: 0, limit: SESSION_LINES };

test("trial_session lists one run's trials' sessions newest first, by the run alone (goals 139 and 170)", () => {
  const store = rigWithTrials();
  const all = trialSession(store, base) as {
    run: string;
    rig: string;
    total: number;
    sessions: Record<string, unknown>[];
  };
  assert.equal(all.rig, "rig-a", "the rig the run ran on, which control knows");
  assert.deepEqual(
    all.sessions.map((s) => s.trial),
    ["t-a", "t-b"],
  );
  assert.deepEqual(all.sessions[0], {
    trial: "t-a",
    lane: "lane-1",
    started_at: at(0),
    last_at: at(908),
    asked: "trial on lane-1: shared staging, stage the activations",
    last_tool: "submit_attempt",
    last_tool_at: at(907),
    ended: "trial ended: submitted a-1",
    lines: 3,
  });
  // A session still at work, or cut off, has not ended.
  assert.equal(all.sessions[1]?.ended, null);
  assert.equal(all.sessions[1]?.lines, 901);
  const one = trialSession(store, { ...base, run: "r-2" }) as { sessions: { trial: string }[] };
  assert.deepEqual(
    one.sessions.map((s) => s.trial),
    ["t-c"],
  );
  assert.throws(() => trialSession(store, { ...base, run: "r-9" }), /^Error: no run r-9$/);
});

test("one session's lines, oldest first, paged forward to its newest; the judge's lines are not in it", () => {
  const store = rigWithTrials();
  type Page = { lines: { id: number; kind: string; text: string }[]; next_after: number | null };
  const first = trialSession(store, { ...base, trial: "t-b" }) as Page & Record<string, unknown>;
  assert.equal(first.lines_total, 901);
  assert.equal(first.lane, "lane-2");
  assert.equal(first.lines.length, SESSION_LINES);
  assert.equal(first.lines[0]?.text, "trial on lane-2: loop order, interleave the rows");
  const seen = [...first.lines];
  let next = first.next_after;
  while (next !== null) {
    const page = trialSession(store, { ...base, trial: "trial:t-b", after: next }) as Page;
    seen.push(...page.lines);
    next = page.next_after;
  }
  assert.equal(seen.length, 901);
  assert.ok(seen.every((l, i) => i === 0 || l.id > (seen[i - 1]?.id ?? 0)));
  assert.equal(seen.at(-1)?.text, "cand 449: 13.9 tok/s");
  assert.ok(!seen.some((l) => l.text.startsWith("job ")));
});

test("a long session's answer keeps to the budget and says how to read its lines whole; an unknown trial is refused in words", () => {
  const store = new ControlStore(":memory:");
  const big = "Reading the kernel's inner loop. ".repeat(200);
  store.liveLines.add(
    "rig-a",
    "log-1",
    Array.from({ length: 60 }, (_, i) => ({
      seq: i + 1,
      at: at(i),
      source: "trial:t-d",
      kind: "thinking" as const,
      text: big,
      lane: "lane-2",
      run: "r-1",
    })),
    true,
  );
  runsOn(store, "r-1");
  const page = trialSession(store, { ...base, trial: "t-d" }) as {
    lines: { text: string }[];
    cut: string[];
  };
  assert.ok(JSON.stringify(page, null, 2).length <= DETAIL_CHARS);
  assert.equal(page.lines.length, 60, "every line stays; only its text is shorter");
  assert.match(page.cut[0] ?? "", /\(a smaller limit gives each line whole\)$/);
  const whole = trialSession(store, { ...base, trial: "t-d", limit: 5 }) as {
    lines: { text: string }[];
    cut?: string[];
  };
  assert.equal(whole.lines[0]?.text, big);
  assert.equal(whole.cut, undefined);
  assert.throws(
    () => trialSession(store, { ...base, trial: "t-nope" }),
    /^Error: control has no lines of trial t-nope in run r-1: it keeps a rig's newest 20,000 lines, and trial_session with no trial lists the run's sessions it has$/,
  );
});

test("a trial that writes many lines leaves another open trial's newest lines in control (goal 143)", async () => {
  const store = controlStore();
  // The rig's report lists t-quiet as open: it wrote 3 lines, then nothing.
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "l-1",
    cursor: 0,
    next: 0,
    events: [],
    summary: {
      work: {
        trials: 2,
        judge_jobs: 0,
        draining: null,
        open: [{ trial: "t-quiet" }, { trial: "t-loop" }],
      },
    },
  });
  const line = (seq: number, source: string, text: string): LiveEntry => ({
    seq,
    at: at(seq % 3600),
    source,
    kind: "tool",
    text,
    lane: source === "trial:t-quiet" ? "lane-2" : "lane-1",
    run: "r-1",
  });
  const quiet = [1, 2, 3].map((i) => line(i, "trial:t-quiet", `read_source s-${i}`));
  store.liveLines.add("rig-a", "log-1", quiet, true, 100);
  // Then the other trial floods the window, past the lines an open trial keeps, in batches.
  for (let b = 0; b < 8; b++)
    store.liveLines.add(
      "rig-a",
      "log-1",
      Array.from({ length: 60 }, (_, i) =>
        line(10 + b * 60 + i, "trial:t-loop", "search_files {}"),
      ),
      true,
      100,
    );
  const kept = (source: string) => store.liveLines.tail("rig-a", 10_000, source).length;
  assert.equal(kept("trial:t-quiet"), 3, "the quiet trial's lines stay");
  assert.equal(kept("trial:t-loop"), OPEN_TRIAL_LINES, "an open trial keeps its newest lines");
  // A trial the report no longer lists is not kept past the window.
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "l-1",
    cursor: 0,
    next: 0,
    events: [],
    summary: { work: { trials: 1, judge_jobs: 0, draining: null, open: [{ trial: "t-loop" }] } },
  });
  store.liveLines.add("rig-a", "log-1", [line(900, "trial:t-loop", "search_files {}")], true, 100);
  assert.equal(kept("trial:t-quiet"), 0);
});
