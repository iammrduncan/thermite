import assert from "node:assert/strict";
import { test } from "node:test";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 228: an attempt's page says how long each of its stages took, from the rig's events: its
 * lane's work, its wait for the judge, each judge's job with its runner, the wait for its
 * confirmation, its audit and the time from its submission to the champion.
 */

const T = Date.parse("2026-11-07T00:00:00Z");
const at = (min: number) => new Date(T + min * 60_000).toISOString();
const ATTEMPT = "a-0000000000000001";
const OTHER = "a-0000000000000002";

async function control() {
  const { store, control: api } = await controlOnly({
    tokens: { rigs: { "rig-a": "t-a-abcdef" } },
  });
  const { page } = await signIn(api);
  let id = 0;
  const ingest = async (
    events: {
      kind: string;
      subject: string;
      body: Record<string, unknown>;
      at: string;
      actor?: string;
    }[],
  ) =>
    ingestReport(store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: id,
      next: id + events.length,
      events: events.map((e) => ({ id: ++id, actor: "harness", ...e })),
      summary: {},
    });
  return { page, ingest };
}

const recorded = (attempt: string, lane: string, min: number) => ({
  kind: "attempt_recorded",
  subject: attempt,
  at: at(min),
  body: {
    run: "sum-1",
    lane,
    lifecycle: "queued",
    commit: "b".repeat(40),
    parent: "a".repeat(40),
    hypothesis: `change ${attempt}`,
    known_flaws: [],
  },
});

test("an attempt's page says how long its lane, the judge, its audit and its promotion took (goal 228)", async () => {
  const c = await control();
  const judge = "executor-box-2-0";
  await c.ingest([
    {
      kind: "run_created",
      subject: "sum-1",
      at: at(-60),
      body: {
        campaign: "sum-speed",
        version: 1,
        mode: "hill_climb",
        seed: { repo: "proj", commit: "a".repeat(40) },
      },
    },
    {
      kind: "trial_started",
      subject: "sum-1",
      at: at(0),
      body: { lane: "lane-1", trial: "t-1", direction: "tiling", focus: "tile it", epoch: 1 },
    },
    recorded(ATTEMPT, "lane-1", 40),
    {
      kind: "trial_finished",
      subject: "sum-1",
      at: at(40.1),
      body: { trial: "t-1", lane: "lane-1", attempt: ATTEMPT, stopped: "submitted" },
    },
    {
      kind: "job_queued",
      subject: "7",
      at: at(40.1),
      body: { attempt: ATTEMPT, kind: "evaluate", run: "sum-1" },
    },
    { kind: "job_leased", subject: "7", at: at(70), actor: judge, body: {} },
    {
      kind: "job_finished",
      subject: "7",
      at: at(130),
      actor: judge,
      body: { state: "done", result: {} },
    },
    {
      kind: "job_queued",
      subject: "8",
      at: at(130),
      body: { attempt: ATTEMPT, kind: "confirm", run: "sum-1" },
    },
    { kind: "job_leased", subject: "8", at: at(150), actor: judge, body: {} },
    {
      kind: "job_finished",
      subject: "8",
      at: at(200),
      actor: judge,
      body: { state: "done", result: {} },
    },
    {
      kind: "audit_requested",
      subject: ATTEMPT,
      at: at(200),
      body: { run: "sum-1", reason: "known_flaws" },
    },
    { kind: "audit_decided", subject: ATTEMPT, at: at(210), body: { decision: "clear" } },
    {
      kind: "champion_promoted",
      subject: "sum-1",
      at: at(211),
      body: { seq: 2, attempt: ATTEMPT, commit: "b".repeat(40) },
    },
    // Another, still waiting for the judge, with no trial's start control saw.
    recorded(OTHER, "lane-2", 220),
    {
      kind: "job_queued",
      subject: "9",
      at: at(220),
      body: { attempt: OTHER, kind: "evaluate", run: "sum-1" },
    },
  ]);
  const page = await c.page(`/ui/campaigns/sum-speed/runs/sum-1/attempts/${ATTEMPT}`);
  const row = (label: string, value: string) =>
    assert.ok(page.includes(`<dt>${label}</dt><dd>${value}`), `${label}: ${value}`);
  assert.match(page, /<h2>How long it took<\/h2>/);
  row(
    "Its lane's work",
    `40 min <span class="muted small">(lane-1, from its trial's start to the submission)</span>`,
  );
  row("Waited for the judge", "30 min");
  row("The judge screened it", '1 h 0 min <span class="muted small">(job 7 on box-2-0)</span>');
  row("Waited for its confirmation", "20 min");
  row("The judge confirmed it", '50 min <span class="muted small">(job 8 on box-2-0)</span>');
  row("Its audit", "10 min");
  row("From submission to champion", '2 h 51 min <span class="muted small">(champion #2)</span>');
  row("The judge's time in all", '1 h 50 min <span class="muted small">(2 jobs)</span>');
  const waiting = await c.page(`/ui/campaigns/sum-speed/runs/sum-1/attempts/${OTHER}`);
  assert.match(waiting, /<dt>Waits for the judge<\/dt><dd>[^<]+ so far<\/dd>/);
  assert.doesNotMatch(waiting, /Its lane's work/);
});
