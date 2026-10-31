import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stuckTrials } from "../../../src/control/ui/stuck.ts";
import { ingestReport } from "../../helpers/control-store.ts";
import { ev, RUN, researchControl, researchRunEvents } from "../../helpers/research-reviews.ts";

/**
 * Goal 143, item 1, as the owner approved it: a stuck trial is a card under Needs you, with its
 * details behind it and Stop this trial… and Leave it running; its lane's row gets only a chip.
 * A trial is quiet after the rig's quiet setting (none by default); one that repeats the same
 * calls is stuck at once.
 */

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const open = (trial: string, lane: string, more: Record<string, unknown>) => ({
  trial,
  run: "s-1",
  lane,
  started_at: ago(264),
  task: null,
  question: null,
  turns: 3,
  tool_calls: 5,
  tokens_in: 41_000,
  claims: 0,
  refused_again: null,
  last_line_at: ago(1),
  reply: null,
  repeating: null,
  ...more,
});

const QUIET = {
  last_line_at: ago(264),
  reply: {
    since: ago(263),
    text: 0,
    thinking: 1840,
    tool_args: 1_200_000,
    reported_at: ago(0.5),
  },
};
const LOOP = {
  repeating: {
    count: 812,
    since: ago(22),
    different: 11,
    calls: [{ call: 'search_files {"path":"sources/s-461c.txt","text":"blockage"}', times: 148 }],
  },
};

/** The research run with three lanes at work: lane-1 repeats, lane-2 is quiet, lane-3 works. */
async function stuckRun(settings: Record<string, unknown> = { quiet_minutes: 30 }) {
  const c = await researchControl();
  const events = [
    ...researchRunEvents(),
    ev("trial_started", { trial: "t-1", lane: "lane-1", family: "contradict", focus: "f1" }),
    ev("trial_started", { trial: "t-2", lane: "lane-2", family: "contradict", focus: "f2" }),
    ev("trial_started", { trial: "t-3", lane: "lane-3", family: "primary", focus: "f3" }),
  ];
  await c.ingest(events);
  const report = async (lane2: Record<string, unknown>) =>
    await ingestReport(c.store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: events.length,
      next: events.length,
      events: [],
      summary: {
        settings,
        work: {
          trials: 3,
          judge_jobs: 0,
          draining: null,
          open: [
            open("t-1", "lane-1", LOOP),
            open("t-2", "lane-2", lane2),
            open("t-3", "lane-3", {}),
          ],
        },
      },
    });
  await report(QUIET);
  return { ...c, report };
}

/** The run page's Needs you block: from its start to the run's columns after it. */
const needsOf = (page: string) => {
  const from = page.indexOf('id="needs"');
  return from < 0 ? "" : page.slice(from, page.indexOf('class="cols run-cols"', from));
};

describe("a stuck trial asks under Needs you (goal 143)", () => {
  test("a card for each stuck trial, its details behind it, and a chip on its lane", async () => {
    const c = await stuckRun();
    const page = await c.page(RUN);
    const needs = needsOf(page);
    assert.match(needs, /lane-2(&#39;|')s trial has sent nothing for 4 h 24 min/);
    assert.match(
      needs,
      /lane-1(&#39;|')s trial repeats the same tool calls: 812 since \d\d:\d\d UTC/,
    );
    // Behind the card: its model call, the calls it repeats, its work so far, and what each does.
    assert.match(
      needs,
      /1\.2M characters of a tool call(&#39;|')s arguments, 1840 characters of thinking so far/,
    );
    assert.match(
      needs,
      /search_files \{&quot;path&quot;:&quot;sources\/s-461c\.txt&quot;,&quot;text&quot;:&quot;blockage&quot;\}<\/code> ×148/,
    );
    assert.match(needs, /3 turns · 5 tool calls · 41k tokens in · 0 verified claims/);
    assert.match(needs, /<span class="btn sm danger">Stop this trial…<\/span>/);
    assert.match(
      needs,
      /<div class="dq-foot"><div class="stuck-stop"><div class="small"><b>Stop lane-2(&#39;|')s trial now\?<\/b>/,
    );
    assert.match(
      needs,
      /name="kind" value="stop_trial"><input type="hidden" name="run" value="s-1"><input type="hidden" name="trial" value="t-2">/,
    );
    assert.match(
      needs,
      /action="\/ui\/campaigns\/survey\/runs\/s-1\/trials\/t-1\/leave">[\s\S]*?name="kind" value="repeating"/,
    );
    // A lane that works gets no card.
    assert.doesNotMatch(needs, /lane-3/);
    // The lanes under Now: a chip on each stuck lane, leading to its card.
    const now = /data-part="now">[\s\S]*?<\/section>/.exec(page)?.[0] ?? "";
    assert.match(
      now,
      /f2 <a class="chip warn" href="[^"]*#needs" title="Its card is under Needs you">quiet for 4/,
    );
    assert.match(
      now,
      /f1 <a class="chip warn" href="[^"]*#needs"[^>]*>repeats the same calls<\/a>/,
    );
    assert.doesNotMatch(now, /f3 <a class="chip/);
    // The home page's Needs you has them too.
    const home = await c.page("/ui");
    assert.match(home, /trial has sent nothing for/);
    assert.match(home, /trial repeats the same tool calls/);
  });

  test("no quiet setting: a quiet trial asks nothing; a repeating one still does", async () => {
    const c = await stuckRun({});
    const needs = needsOf(await c.page(RUN));
    assert.doesNotMatch(needs, /sent nothing/);
    assert.match(needs, /repeats the same tool calls/);
  });

  test("Leave it running: the card goes away until the trial is stuck again", async () => {
    const c = await stuckRun();
    // Addressed through its run (goal 170): its form names no rig.
    assert.match(
      needsOf(await c.page(RUN)),
      /action="\/ui\/campaigns\/survey\/runs\/s-1\/trials\/t-2\/leave"/,
    );
    const left = await c.post(`${RUN}/trials/t-2/leave`, {
      kind: "quiet",
      since: QUIET.last_line_at,
      back: RUN,
    });
    assert.equal(left.status, 303);
    assert.equal(left.headers.get("location"), RUN);
    assert.doesNotMatch(needsOf(await c.page(RUN)), /sent nothing/);
    const audit = c.store.auditLog.list(5).find((a) => a.action === "trial_left");
    assert.equal(audit?.actor, "owner:ui");
    // It sent a line, then went quiet again: the card is back.
    await c.report({ ...QUIET, last_line_at: ago(45) });
    assert.match(needsOf(await c.page(RUN)), /lane-2(&#39;|')s trial has sent nothing for 45 min/);
    // A form that is not a stuck trial's card is refused.
    const bad = await c.post(`${RUN}/trials/t-2/leave`, {
      kind: "bored",
      since: "x",
    });
    assert.equal(bad.status, 400);
  });

  test("Stop this trial: the card's form sends why, and once sent, the card leaves", async () => {
    const c = await stuckRun();
    // The card's own form, as the page has it.
    const form =
      /<form[^>]*action="\/ui\/commands">(?:(?!<\/form>)[\s\S])*?name="trial" value="t-1">(?:(?!<\/form>)[\s\S])*?<\/form>/.exec(
        needsOf(await c.page(RUN)),
      )?.[0] ?? "";
    const fields = Object.fromEntries(
      [...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
        m[1] as string,
        (m[2] as string).replaceAll("&#39;", "'"),
      ]),
    );
    assert.equal(fields.kind, "stop_trial");
    const r = await c.send(fields);
    assert.ok(r.status < 400, JSON.stringify(r.answer));
    assert.deepEqual(c.store.commands.latest("rig-a", "stop_trial", 1)[0]?.payload, {
      run: "s-1",
      trial: "t-1",
      reason: "stopped from Needs you: it repeated the same calls",
    });
    const needs = needsOf(await c.page(RUN));
    assert.doesNotMatch(needs, /repeats the same tool calls/);
    assert.match(needs, /sent nothing/, "the other card stays");
  });

  test("stuckTrials: an older harness says nothing; no line yet counts from the trial's start", () => {
    const started = ago(90);
    const run = (w: Record<string, unknown>, status = "running") =>
      ({
        status,
        at_work: { "lane-1": { trial: "t-1", family: null, focus: null, since: started, ...w } },
      }) as never;
    const q = { settings: { quiet_minutes: 30 } } as never;
    const now = Date.now();
    assert.deepEqual(stuckTrials(q, run({}), now), [], "an older harness reports no last line");
    const never = stuckTrials(q, run({ last_line_at: null }), now);
    assert.deepEqual(
      never.map((s) => [s.kind, s.since]),
      [["quiet", started]],
    );
    assert.deepEqual(stuckTrials(q, run({ last_line_at: ago(10) }), now), [], "10 min < 30");
    assert.deepEqual(stuckTrials(q, run({ last_line_at: ago(40) }, "paused"), now), []);
  });
});

test("a trial that asks again and again for a refused page is stuck too (goals 136 and 143)", async () => {
  const c = await stuckRun({});
  const refused = (times: number) => ({
    url: "https://vendor.example.org/guide/benchmarks.pdf",
    reason: "larger than 5000000 bytes",
    asked: 212,
    at: ago(1),
    times,
  });
  // Its answer counts the asks, so it is no streak of the same answer: goal 136's count says it.
  const report = async (times: number) =>
    await ingestReport(c.store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: 0,
      next: 0,
      events: [],
      summary: {
        settings: {},
        work: {
          trials: 1,
          judge_jobs: 0,
          draining: null,
          open: [open("t-3", "lane-3", { refused_again: refused(times) })],
        },
      },
    });
  await report(3);
  assert.doesNotMatch(needsOf(await c.page(RUN)), /refused/);
  await report(12);
  const page = await c.page(RUN);
  const needs = needsOf(page);
  assert.match(
    needs,
    /lane-3(&#39;|')s trial asks again and again for a page the run refused: 12 times/,
  );
  assert.match(
    needs,
    /This trial asked 12 times for a page the run refused before: <code>https:\/\/vendor\.example\.org\/guide\/benchmarks\.pdf<\/code>, larger than 5000000 bytes\. The run has asked for it 212 times/,
  );
  assert.match(
    page,
    /f3 <a class="chip warn" href="[^"]*#needs"[^>]*>repeats a refused request<\/a>/,
  );
  // Leave it running, for that page: the card stays away while it is the same page.
  const left = await c.post(`${RUN}/trials/t-3/leave`, {
    kind: "refused",
    since: refused(12).url,
    back: RUN,
  });
  assert.equal(left.status, 303);
  assert.doesNotMatch(needsOf(await c.page(RUN)), /refused/);
});

test("History says a streak of the same calls in words (goal 143)", async () => {
  const { sentence } = await import("../../../src/control/ui/words/index.ts");
  const said = sentence(
    { judge: { jobs: [] }, runs: [] } as never,
    {
      kind: "trial_repeating",
      subject: "s-1",
      actor: "harness",
      at: "2026-10-25T19:04:23Z",
      body: { trial: "t-1", lane: "lane-1", count: 10, different: 11, calls: [] },
    } as never,
  );
  assert.deepEqual(said, {
    text: "lane-1's trial repeats the same tool calls: 10 in a row, each with the same answer as before, 11 different. It goes on, and asks you under Needs you.",
    tone: "warn",
    run: "s-1",
  });
});
