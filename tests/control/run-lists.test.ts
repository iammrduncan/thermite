import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DETAIL_CHARS,
  REPORT_CHARS,
  RUN_LIST_LIMIT,
  runDetail,
  runQueue,
} from "../../src/control/run-lists.ts";
import type { RunView } from "../../src/control/views/index.ts";

/** A run's view the size of a research run that worked for a day and a half. */
function longRun() {
  const note = (i: number) => ({
    id: i,
    by: "lane-1",
    text: `${"An observation of the run. ".repeat(12)}${i}`,
  });
  return {
    id: "r-1",
    status: "running",
    attempts: Array.from({ length: 80 }, (_, i) => ({ id: `a-${i}` })),
    journal: Array.from({ length: 4549 }, (_, i) => note(i)),
    timeline: Array.from({ length: 400 }, (_, i) => ({
      id: i,
      kind: "trial_started",
      body: note(i),
    })),
    queue: Array.from({ length: 182 }, (_, i) => ({
      id: `x-${i}`,
      details: "Read the source. ".repeat(60),
    })),
    hypotheses: Array.from({ length: 218 }, (_, i) => ({
      id: `h-${i}`,
      text: "A hypothesis. ".repeat(40),
    })),
    champion: [{ seq: 1 }],
    research: { questions: [{ question: "Q?", verified: 3 }], report: "R".repeat(60_000) },
  };
}
const opts = { attempts: 50, limit: RUN_LIST_LIMIT, offset: 0, full_report: false };

test("a long run's detail stays a size an agent can read, and says what it left out", () => {
  const run = longRun();
  assert.ok(JSON.stringify(run).length > 1_500_000, "the run itself is large");
  const d = runDetail(run, opts) as Record<string, unknown> & { cut: string[] };
  assert.ok(JSON.stringify(d).length < 100_000, `${JSON.stringify(d).length} characters`);
  // The newest entries of each list, oldest first as the views keep them.
  assert.deepEqual(
    (d.journal as { id: number }[]).map((n) => n.id),
    Array.from({ length: 10 }, (_, i) => 4539 + i),
  );
  // Attempts, the newest first, by their own limit.
  assert.equal((d.attempts as { id: string }[])[0]?.id, "a-79");
  assert.equal((d.attempts as unknown[]).length, 50);
  // A short list stays whole and is not named.
  assert.deepEqual(d.champion, [{ seq: 1 }]);
  assert.equal((d.research as { report: string }).report.length, REPORT_CHARS + 1);
  assert.deepEqual(d.cut, [
    "attempts: the newest 50 of 80 (attempts gives more)",
    'journal: the newest 10 of 4,549 entries (list "journal" with offset reads older ones)',
    'timeline: the newest 10 of 400 entries (list "timeline" with offset reads older ones)',
    'queue: the newest 10 of 182 entries (list "queue" with offset reads older ones)',
    'hypotheses: the newest 10 of 218 entries (list "hypotheses" with offset reads older ones)',
    "research.report: its first 4,000 of 60,000 characters (full_report: true gives it whole)",
  ]);
});

test("one list, paged back from its newest entries; a list the run has not is refused in words", () => {
  const run = longRun();
  const page = runDetail(run, { ...opts, list: "hypotheses", limit: 5, offset: 5 });
  assert.deepEqual(
    { ...page, entries: (page.entries as { id: string }[]).map((h) => h.id) },
    {
      id: "r-1",
      list: "hypotheses",
      total: 218,
      from: 208,
      to: 213,
      entries: ["h-208", "h-209", "h-210", "h-211", "h-212"],
    },
  );
  // Past the oldest: an empty page.
  assert.deepEqual(runDetail(run, { ...opts, list: "champion", offset: 5 }).entries, []);
  assert.throws(
    () => runDetail(run, { ...opts, list: "nope" }),
    /^Error: the run has no list nope: its lists are attempts, journal, timeline, queue, hypotheses, champion$/,
  );
});

test("full_report gives the report whole, and a limit gives more of each list", () => {
  const d = runDetail(longRun(), { ...opts, limit: 200, full_report: true }) as Record<
    string,
    unknown
  > & { cut: string[] };
  assert.equal((d.research as { report: string }).report.length, 60_000);
  assert.equal((d.queue as unknown[]).length, 182);
  assert.ok(!d.cut.some((c) => c.startsWith("queue") || c.startsWith("research.report")));
});

test("a run's default detail keeps to the budget an agent's tool takes: texts in its lists are cut, and list gives them whole (goal 138)", () => {
  // As on the lab: ten experiments up next, each with details of 4,000 characters, and attempts
  // with long hypotheses and declared flaws.
  const run = {
    id: "r-2",
    status: "running",
    attempts: Array.from({ length: 12 }, (_, i) => ({
      id: `a-${i}`,
      hypothesis: "Stage the activations once per CTA. ".repeat(110),
      known_flaws: Array.from({ length: 4 }, () => "Numerics were not checked. ".repeat(37)),
    })),
    queue: Array.from({ length: 10 }, (_, i) => ({ id: `x-${i}`, details: "M".repeat(4000) })),
    champion: [{ seq: 1, note: "short" }],
  };
  const d = runDetail(run, opts) as Record<string, unknown> & { cut: string[] };
  const sent = JSON.stringify(d, null, 2).length;
  assert.ok(sent <= DETAIL_CHARS, `${sent} characters`);
  assert.ok(JSON.stringify(run, null, 2).length > 2 * DETAIL_CHARS, "the run itself is above it");
  const said = d.cut.find((c) => c.startsWith("texts in lists:"));
  assert.match(
    said ?? "",
    /^texts in lists: \d+ cut to their first [\d,]+ characters, to keep the answer under 40,000 \(list with a list's name gives its entries whole\)$/,
  );
  const first = (d.queue as { details: string }[])[0]?.details ?? "";
  assert.ok(first.length < 4000 && first.endsWith("…"));
  // Whole in one list, and a short text is never cut.
  const page = runDetail(run, { ...opts, list: "queue" });
  assert.equal((page.entries as { details: string }[])[0]?.details.length, 4000);
  assert.deepEqual(d.champion, [{ seq: 1, note: "short" }]);
  // A run under the budget is not cut.
  const small = { id: "r-3", attempts: [], queue: [{ id: "x-1", details: "M".repeat(4000) }] };
  assert.equal(runDetail(small, opts).cut, undefined);
});

test("run_queue keeps to the same budget: a research run's thirty tasks up next, cut in words (goal 138)", () => {
  const task = (i: number) => ({
    id: `x-${i}`,
    title: `Task ${i}`,
    details: "Find the vendor's support matrix for this release and quote it. ".repeat(25),
    state: "queued",
    position: i,
    question: i % 6,
    updated_at: "2026-10-25T09:00:00Z",
  });
  const run = {
    id: "r-4",
    mode: "research",
    status: "running",
    queue: Array.from({ length: 30 }, (_, i) => task(i)),
    at_work: {},
    rules: [],
    directions: [],
    handouts: [],
    messages: [],
  } as unknown as RunView;
  const q = runQueue(run, 0) as { up_next: { id: string; details: string }[]; cut?: string[] };
  assert.ok(JSON.stringify(q, null, 2).length <= DETAIL_CHARS);
  // Every task stays, in order; only its texts are shorter.
  assert.deepEqual(
    q.up_next.map((t) => t.id),
    Array.from({ length: 30 }, (_, i) => `x-${i}`),
  );
  assert.ok(q.up_next[0]?.details.endsWith("…"));
  assert.match(
    q.cut?.[0] ?? "",
    /^texts in lists: \d+ cut to their first [\d,]+ characters, to keep the answer under 40,000 \(get_run with list "queue" gives the queue whole\)$/,
  );
  // A short queue is given whole, with no cut.
  const short = runQueue({ ...run, queue: [task(0)] } as RunView, 0) as { cut?: string[] };
  assert.equal(short.cut, undefined);
});
