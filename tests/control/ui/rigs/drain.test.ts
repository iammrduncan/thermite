import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { drainBanner, drainOf, drainSaid } from "../../../../src/control/ui/rigs/drain.ts";
import { answerCommand, ingestReport } from "../../../helpers/control-store.ts";
import { ev, part, researchControl, researchRunEvents } from "../../../helpers/research-reviews.ts";

/**
 * A rig's drain on its page (goal 136, item 3): the card at the top, and each trial it waits for
 * beside its lane under At work, with what it last did, a refused request it repeats, its work so
 * far and Stop this trial….
 */

const min = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** Two trials of the research run at work, and a report that says the rig drains. */
async function draining(work?: Record<string, unknown>) {
  const c = await researchControl();
  const events = [
    ...researchRunEvents(),
    ev("trial_started", {
      trial: "t-1",
      lane: "lane-1",
      family: "survey",
      focus: "Trace the vendor's benchmark guide to its source",
    }),
    ev("trial_started", {
      trial: "t-2",
      lane: "lane-2",
      family: "survey",
      focus: "Find published repetition counts",
    }),
  ];
  await c.ingest(events);
  const open = (trial: string, lane: string, started: number, more: Record<string, unknown>) => ({
    trial,
    run: "s-1",
    lane,
    started_at: min(started),
    task: null,
    question: null,
    turns: 18,
    tool_calls: 15,
    tokens_in: 240_000,
    claims: 3,
    refused_again: null,
    ...more,
  });
  await ingestReport(c.store, {
    rig: "rig-a",
    ledger_id: "ledger-a",
    cursor: events.length,
    next: events.length,
    events: [],
    summary: {
      work: work ?? {
        trials: 2,
        judge_jobs: 0,
        draining: {
          since: min(324),
          reason: "its images are about to change",
          by: "control:owner:api",
        },
        open: [
          open("t-1", "lane-1", 453, {
            task: "Trace the vendor's benchmark guide to its source",
            question: 0,
            turns: 214,
            tool_calls: 196,
            tokens_in: 3_100_000,
            claims: 4,
            refused_again: {
              url: "https://vendor.example.org/guide/benchmarks.pdf",
              reason: "larger than 5000000 bytes",
              asked: 212,
              at: min(1),
              times: 2,
            },
          }),
          open("t-2", "lane-2", 12, {}),
        ],
      },
    },
  });
  // lane-1's newest lines in Live: a fetch, and the harness's answer.
  c.store.liveLines.add(
    "rig-a",
    "log-1",
    [
      {
        kind: "tool" as const,
        text: "fetch https://vendor.example.org/guide/benchmarks.pdf",
        at: min(1.2),
      },
      {
        kind: "result" as const,
        text: "refused: larger than 5000000 bytes. Refused before.",
        at: min(1),
      },
    ].map((e, i) => ({ seq: i + 1, source: "trial:t-1", lane: "lane-1", run: "s-1", ...e })),
    true,
  );
  return c;
}

describe("a drain on the rig's page (goal 136)", () => {
  test("the card says since when, who asked and why, and what it waits for, with End the drain", async () => {
    const c = await draining();
    const html = await c.page("/ui/rigs/rig-a");
    assert.match(html, /rig-a drains: it starts nothing new, and waits for 2 trials to end\./);
    const card = part(html, 'id="drain"', 'data-part="at-work"');
    assert.match(card, /Draining for 5 h 24 min, since \d\d:\d\d UTC\./);
    assert.match(
      card,
      /The owner asked for it over REST: <i>its images are about to change<\/i>\./,
    );
    assert.match(card, /It waits for 2 trials\./);
    assert.match(card, /Each trial it waits for is under <b>At work<\/b>, with a way to stop it\./);
    assert.match(card, /name="kind" value="drain_rig"[\s\S]*End the drain/);
    // End the drain sends drain_rig with drain false.
    const r = await c.send({ rig: "rig-a", kind: "drain_rig" });
    assert.equal(r.status, 200, JSON.stringify(r.answer));
    const sent = c.store.commands.latest("rig-a", "drain_rig", 1)[0];
    assert.deepEqual(sent?.payload, { drain: false, reason: "the owner ended the drain" });
    assert.equal(sent?.issued_by, "owner:ui");
  });

  test("each trial it waits for is beside its lane: what it last did, a request it repeats, its work, and Stop this trial…", async () => {
    const c = await draining();
    const html = await c.page("/ui/rigs/rig-a");
    const work = part(html, 'data-part="at-work"', 'data-part="checks"');
    const lane1 = part(
      work,
      '<span class="br-who">lane-1</span>',
      '<span class="br-who">lane-2</span>',
    );
    assert.match(lane1, /<span class="chip warn"[^>]*>repeats a refused request<\/span>/);
    assert.match(
      lane1,
      /<details data-k="drain-t-1" open><summary class="small">The drain waits for it · last did something 1m ago/,
    );
    assert.match(lane1, /7 h 33 min, since \d\d:\d\d UTC/);
    assert.match(
      lane1,
      /1m ago: <code>fetch https:\/\/vendor\.example\.org\/guide\/benchmarks\.pdf<\/code>, answered: refused: larger than 5000000 bytes/,
    );
    assert.match(
      lane1,
      /This trial asked 2 times for a page the run refused before: <code>https:\/\/vendor\.example\.org\/guide\/benchmarks\.pdf<\/code>, larger than 5000000 bytes\. The run has asked for it 212 times/,
    );
    assert.match(lane1, /214 turns · 196 tool calls · 3\.1M tokens in · 4 verified claims/);
    assert.match(
      lane1,
      /Stop lane-1's trial now\?<\/b> It ends as interrupted\. Its sources, claims and counters stay\. Its task goes back to the top of the run's queue[^<]*The drain then waits only for 1 trial\./,
    );
    assert.match(
      lane1,
      /name="kind" value="stop_trial"><input type="hidden" name="run" value="s-1"><input type="hidden" name="trial" value="t-1">/,
    );
    // lane-2's trial repeats nothing: closed, with no mark, and nothing in Live yet.
    const lane2 = part(
      work,
      '<span class="br-who">lane-2</span>',
      '<span class="br-who">judge</span>',
    );
    assert.doesNotMatch(lane2, /repeats a refused request/);
    assert.match(
      lane2,
      /<details data-k="drain-t-2"><summary class="small">The drain waits for it · nothing in Live from it yet/,
    );

    // Stop the trial sends stop_trial; the row then says how the stop stands, without the button.
    const r = await c.send({ rig: "rig-a", kind: "stop_trial", run: "s-1", trial: "t-1" });
    assert.equal(r.status, 200, JSON.stringify(r.answer));
    const sent = c.store.commands.latest("rig-a", "stop_trial", 1)[0];
    assert.deepEqual(sent?.payload, { run: "s-1", trial: "t-1" });
    const after = part(
      await c.page("/ui/rigs/rig-a"),
      '<span class="br-who">lane-1</span>',
      '<span class="br-who">lane-2</span>',
    );
    assert.match(after, /Stop sent at \d\d:\d\d UTC\. Sent to rig-a/);
    assert.doesNotMatch(after, /Stop this trial…/);
    answerCommand(c.store, "rig-a", sent?.id ?? "", "delivered", {
      source: "harness",
      status: "applied",
      accepted: true,
      result: { run: "s-1", trial: "t-1", lane: "lane-1", stopping: true },
    });
    assert.match(
      await c.page("/ui/rigs/rig-a"),
      /rig-a took your stop at \d\d:\d\d UTC: the trial ends as interrupted within seconds\./,
    );
  });

  test("a trial stopped during the drain, once it ended; a harness too old to list its trials; no drain", async () => {
    const c = await draining();
    await c.send({ rig: "rig-a", kind: "stop_trial", run: "s-1", trial: "t-1" });
    const sent = c.store.commands.latest("rig-a", "stop_trial", 1)[0];
    answerCommand(c.store, "rig-a", sent?.id ?? "", "delivered", {
      source: "harness",
      status: "applied",
      accepted: true,
      result: { run: "s-1", trial: "t-1", lane: "lane-1", stopping: true },
    });
    const d = drainOf(c.store.reportedRigs.list()[0] ?? { summary: {} });
    assert.ok(d);
    const card = drainBanner({
      rig: "rig-a",
      drain: { ...d, trials: 1, open: (d.open ?? []).filter((t) => t.trial !== "t-1") },
      cluster: true,
      form: () => "",
      csrf: "x",
      store: c.store,
      now: Date.now(),
    });
    assert.match(
      card,
      /<span class="pill">stopped<\/span> lane-1's trial, stopped at \d\d:\d\d UTC: it ended as interrupted, with its counters, and its task went back to the top of the run's queue\./,
    );
    // A rig control set up on a cluster: End the drain calls its update off.
    assert.match(card, /action="\/ui\/rigs\/rig-a\/cluster\/drain-cancel"/);
    assert.match(card, /Control restarts its pods once nothing runs\./);

    const old = await draining({
      trials: 2,
      judge_jobs: 1,
      draining: { since: min(30), reason: "its images are about to change" },
    });
    const oldCard = part(await old.page("/ui/rigs/rig-a"), 'id="drain"', 'data-part="at-work"');
    assert.match(oldCard, /It was asked for: <i>its images are about to change<\/i>\./);
    assert.match(
      oldCard,
      /It waits for 2 trials and the judge's job\. Its harness is too old to say which trials, or to stop one: update it\./,
    );
    assert.doesNotMatch(oldCard, /under <b>At work<\/b>/);
    // The judge builds several changes at once: the sentence gives how many of its jobs run.
    const two = drainOf(old.store.reportedRigs.list()[0] ?? { summary: {} });
    assert.ok(two);
    assert.match(
      drainSaid("rig-a", { ...two, judgeJobs: 2 }),
      /waits for 2 trials and the judge's 2 jobs to end\./,
    );

    const none = await draining({ trials: 2, judge_jobs: 0, draining: null });
    const page = await none.page("/ui/rigs/rig-a");
    assert.doesNotMatch(page, /id="drain"|drains: it starts nothing new|The drain waits for it/);
  });
});
