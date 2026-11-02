import assert from "node:assert/strict";
import { test } from "node:test";
import { reportsBody, reportsQuery } from "../../../src/control/ui/reports.ts";
import type { RigView, RunView } from "../../../src/control/views/index.ts";

/** Reports (goal 181): what each finished run produced, newest first, by mode and campaign. */

const run = (o: Partial<RunView>): RunView =>
  ({
    id: "r",
    campaign: "c",
    mode: "hill_climb",
    status: "closed",
    status_at: "2026-11-01T00:00:00.000Z",
    paper: null,
    research: null,
    cards: [],
    champion: [],
    verdicts: {},
    attempts: [],
    published_patches: [],
    goals: [],
    goals_complete: false,
    conclusions: [],
    ...o,
  }) as unknown as RunView;

const views = (runs: RunView[]) => [{ id: "rig-a", runs } as unknown as RigView];
const none = reportsQuery(
  () => undefined,
  () => [],
);

test("each finished run's report, newest first: a research paper, a champion, a goal's outcome", () => {
  const html = reportsBody({
    views: views([
      run({
        id: "speed-1",
        campaign: "speed",
        status_at: "2026-11-01T10:00:00.000Z",
        champion: [
          { seq: 1, cumulative: 1 },
          { seq: 3, cumulative: 2.5 },
        ] as RunView["champion"],
        verdicts: { win_confirmed: 2, regress: 4 },
        attempts: new Array(7) as RunView["attempts"],
        published_patches: [{ seq: 3 }] as RunView["published_patches"],
      }),
      run({
        id: "paper-1",
        campaign: "papers",
        mode: "research",
        status_at: "2026-11-01T12:00:00.000Z",
        research: { kind: "final" },
        paper: { state: "in", text: "# What a reader must check\n\nBody." } as RunView["paper"],
        cards: [{}, {}] as RunView["cards"],
      }),
      run({
        id: "goal-1",
        campaign: "engine",
        mode: "goal",
        status_at: "2026-10-30T09:00:00.000Z",
        goals: [{ status: "met" }, { status: "not_met" }] as RunView["goals"],
        conclusions: [{ decision: "accepted" }] as RunView["conclusions"],
      }),
      run({ id: "still", status: "running", status_at: "2026-11-02T00:00:00.000Z" }),
      run({ id: "check-1", campaign: "rig-check-smoke-cpu-1" }),
    ]),
    query: none,
  });
  const order = [...html.matchAll(/data-run="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    order,
    ["paper-1", "speed-1", "goal-1"],
    "closed runs only, newest first, no rig check",
  );
  assert.match(html, /<h3 class="rp-head">What a reader must check<\/h3>/);
  assert.match(html, /final report · paper · 2 questions with an answer card/);
  assert.match(html, /href="\/ui\/campaigns\/papers\/runs\/paper-1\/paper\.md">paper\.md<\/a>/);
  assert.match(html, /Champion #3: 2\.50× its starting point/);
  assert.match(html, /7 attempts · 2 wins confirmed · 4 regressions/);
  assert.match(
    html,
    /href="\/ui\/campaigns\/speed\/runs\/speed-1\/champions\/3\.patch">Champion #3 as a patch<\/a>/,
  );
  assert.match(html, /Not possible: you accepted the run's conclusion/);
  assert.match(html, /1 of 2 goals met/);
});

test("the filters keep one mode or campaign; the rig checks' runs show only when asked", () => {
  const vs = views([
    run({ id: "a", campaign: "x", mode: "goal" }),
    run({ id: "b", campaign: "y", mode: "research" }),
    run({ id: "check-1", campaign: "rig-check-smoke-cpu-1" }),
  ]);
  const ids = (q: Parameters<typeof reportsQuery>) =>
    [...reportsBody({ views: vs, query: reportsQuery(...q) }).matchAll(/data-run="([^"]+)"/g)].map(
      (m) => m[1],
    );
  assert.deepEqual(ids([() => undefined, (k) => (k === "mode" ? ["goal"] : [])]), ["a"]);
  assert.deepEqual(ids([() => undefined, (k) => (k === "campaign" ? ["y"] : [])]), ["b"]);
  assert.deepEqual(ids([(k) => (k === "checks" ? "1" : undefined), () => []]).sort(), [
    "a",
    "b",
    "check-1",
  ]);
});
