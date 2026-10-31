import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { seedDemo } from "../../helpers/control-demo.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { applied, controlStore, ingestReport } from "../../helpers/control-store.ts";

/**
 * The dashboard for an operator, over the demo seed: each decision and what it decides, the
 * overview in words, an attempt's page, a campaign's views, and agent-written text escaped.
 */

/** Control over the demo seed (no harness): three rigs with decisions waiting and runs at work. */
async function demo() {
  const store = controlStore();
  await seedDemo(store);
  // The knowledge base's folders and the model usage, as control applies them from the bus.
  await applied(store);
  const { control } = controlOnly({
    store,
    tokens: { rigs: { "rig-a": "t-a-abcdef", "rig-b": "t-b-abcdef", "rig-c": "t-c-abcdef" } },
  });
  const { page: get, post } = await signIn(control);
  return { store, get, post };
}

describe("control dashboard for an operator", () => {
  test("a waiting promotion and a held audit can each be declined from their card", async () => {
    const { store, get, post } = await demo();
    const home = await get("/ui");
    const forms = [
      ...home.matchAll(
        /<form[^>]*action="\/ui\/commands">(?:(?!<\/form>).)*name="kind" value="decline_promotion"(?:(?!<\/form>).)*<\/form>/gs,
      ),
    ].map((m) => m[0]);
    assert.ok(forms.length >= 2, `decline forms: ${forms.length}`);
    assert.match(
      home,
      /The change does not become the champion\. The record shows that you rejected it\./,
    );
    const field = (form: string, name: string) =>
      new RegExp(`name="${name}" value="([^"]*)"`).exec(form)?.[1] ?? "";
    const form = forms[0] as string;
    const r = await post("/ui/commands", {
      csrf: field(form, "csrf"),
      rig: field(form, "rig"),
      kind: "decline_promotion",
      run: field(form, "run"),
      attempt: field(form, "attempt"),
    });
    assert.equal(r.status, 303);
    const cmd = store.commands
      .pending(field(form, "rig"))
      .find((c) => c.envelope.kind === "decline_promotion");
    assert.equal(cmd?.envelope.issued_by, "owner:ui");
    assert.deepEqual(cmd?.envelope.payload, {
      run: field(form, "run"),
      attempt: field(form, "attempt"),
    });
  });

  test("every decision shows what it is about, the evidence, why it waits and what each choice does", async () => {
    const { get } = await demo();
    const home = await get("/ui");
    // A goal-campaign attempt held for an audit, on a rig with no auditor.
    assert.match(home, /Make this change the new champion\?/);
    assert.match(home, /Add a dispatch table that picks SIMD routines/);
    assert.match(home, /The filter bank still runs the scalar code\./);
    assert.match(
      home,
      /With this change, the project gets these goals that the champion does not get: vectors, recordings and simd\. It keeps all the goals that the champion gets\./,
    );
    // What changed and why the judge decided, from the record.
    assert.match(
      home,
      /3 files: <code>src\/dispatch\.c<\/code> <span class="muted">\+120 −4<\/span>/,
    );
    assert.match(home, /<code>tests\/vectors\.bin<\/code> <span class="muted">binary<\/span>/);
    assert.match(home, /The judge: newly meets vectors, recordings and simd; loses none/);
    // A confirmed win's interval; a lane at work, with its focus, from trial_started.
    assert.match(
      home,
      /The judge measured the change again on new runs: \+14\.2% compared with the champion\. The correct value is between \+9\.1% and \+19\.6%\./,
    );
    assert.match(home, /vectorize the filter bank so a frame fits its time budget/);
    // Each decision's row leads with what the change does in plain words, then why it waits,
    // then the facts as chips.
    assert.match(
      home,
      /<span class="dq-head">lane-1 changed 3 files\. With this change, the project gets 3 more goals: vectors, recordings and simd\./,
    );
    assert.match(
      home,
      /<span class="dq-why">The agent that made the change wrote 2 problems with it\. This rig has no auditor, thus you must make the decision\.<\/span>/,
    );
    assert.match(home, /<b>\+3 goals<\/b>.*2 problems from the agent.*3 files/s);
    assert.match(home, /<b>\+14\.2%<\/b><\/span><span class="chip">\+9\.1% to \+19\.6%<\/span>/);
    assert.match(
      home,
      /The auditor stopped this change\. Its cause: The change caches the result between calls/,
    );
    assert.match(home, /Problems that the agent wrote/);
    assert.match(
      home,
      /This rig has no auditor\.<\/b> Thus, no one other than you will make the decision\./,
    );
    assert.match(home, /Make it the champion/);
    assert.match(
      home,
      /You make the decision, not an auditor\. The record shows your name\. The change becomes <b>champion #2<\/b>/,
    );
    // Its run was moved to another rig: a promotion there changes only that run.
    assert.match(
      home,
      /This run is <b>paused: moved to rig-b as dec-2<\/b>\. A new champion changes this run only\./,
    );
    // A held audit can be declined; leaving it held is said plainly too.
    assert.match(
      home,
      /The change stays in this list\. No auditor will make the decision for you\./,
    );
    assert.doesNotMatch(home, />Reject</);
    // The auditor's block shows the auditor's reasons, not just the trigger.
    assert.match(home, /Overrule the auditor and make this change the champion\?/);
    assert.match(home, /the benchmark measures a cache hit/);
    assert.match(home, /The audit started because Gain 240\.0% above 100%\./);
    // A confirmed win on a rig that asks for approval.
    assert.match(
      home,
      /\+14\.2% compared with the champion\. The correct value is between \+9\.1% and \+19\.6%\. The first test measured \+15\.2%\./,
    );
    assert.match(home, /The change becomes <b>champion #5<\/b>/);
    // Every decision button is a signed-command form with the session's token: approve (or
    // overrule) and decline, for each of the three decisions.
    const forms = home.match(/<form class="inline" method="post" action="\/ui\/commands">/g) ?? [];
    assert.equal(forms.length, 6);
  });

  test("the overview says what each run is doing now, and what happened, in words", async () => {
    const { get } = await demo();
    const home = await get("/ui");
    // The few numbers first, then one line per lane and for the judge, with how long.
    assert.match(home, /<b>3<\/b><span>need you<\/span>/);
    assert.match(home, /<h2>At work<\/h2>/);
    assert.match(
      home,
      /measuring the rig's own noise \(the champion against itself\)<\/span><span class="br-when">8 min</,
    );
    assert.match(
      home,
      /vectorize the filter bank so a frame fits its time budget <a class="small" href="\/ui\/campaigns\/opus-simd\/runs\/dec-2\/live\?w=lane-1">watch<\/a><\/span><span class="br-when">1 h 3 min</,
    );
    assert.match(home, /4\/8 goals/);
    // Campaigns: what is at work now first, then what waits, then one row per campaign.
    const campaigns = await get("/ui/campaigns");
    assert.match(campaigns, /<h2>At work now<\/h2><span class="n">2<\/span>/);
    assert.match(campaigns, /opus-simd › dec-2/);
    assert.match(campaigns, /<h2>Waiting for you<\/h2>/);
    assert.match(
      campaigns,
      /<b>opus-simd<\/b>[\s\S]*?<span class="kdot run">1 at work<\/span><span class="kdot pause">1 paused<\/span>/,
    );
    assert.match(campaigns, /href="\/ui\/campaigns\/opus-simd\/runs\/dec-2\/live\?compose=1"/);
    // Filters and search are links and a plain form: they work without the script.
    const paused = await get("/ui/campaigns?f=paused");
    assert.doesNotMatch(paused, /<b>sum-speed<\/b>/);
    const found = await get("/ui/campaigns?q=sum");
    assert.match(found, /<b>sum-speed<\/b>/);
    assert.doesNotMatch(found, /<b>opus-simd<\/b>/);
    // The Rigs list: a row for each rig, with its run at work. What its judge does and its
    // checks are on the rig's page.
    const rigsList = await get("/ui/rigs");
    assert.match(rigsList, /<span class="summary">3 rigs · /);
    assert.match(
      rigsList,
      /<a class="nowrap" href="\/ui\/campaigns\/opus-simd\/runs\/dec-2">dec-2<\/a><span class="rsub">opus-simd · /,
    );
    assert.doesNotMatch(rigsList, /The judge is|model route/);
    const rigPages = (
      await Promise.all(["rig-a", "rig-b", "rig-c"].map((r) => get(`/ui/rigs/${r}`)))
    ).join("");
    assert.match(
      rigPages,
      /The judge is measuring the rig's own noise \(the champion against itself\)\./,
    );
    // The run's page adds each lane's last step.
    const run = await get("/ui/campaigns/opus-simd/runs/dec-2");
    assert.match(run, /last: <code>run timeout 270 make -C build bench-decode/);
    // What happened is sentences, not event kinds and IDs.
    assert.match(home, /Run dec-1 paused: moved to rig-b as dec-2\./);
    assert.match(home, /The judge checked champion #1: 4 of 8 goals met\./);
    for (const raw of ["job leased", "attempt lifecycle", "job queued", "promotion blocked"])
      assert.doesNotMatch(home, new RegExp(raw));
  });

  test("an attempt has a page with the change, the judge's findings and its history", async () => {
    const { get } = await demo();
    const page = await get("/ui/campaigns/opus-simd/runs/dec-1/attempts/a-7e1a0001");
    assert.match(page, /3c0ffee100112233445566778899aabbccddeeff/);
    assert.match(page, /Only x86 SIMD is covered/);
    assert.match(page, /looked like goal progress; being confirmed on fresh runs/);
    assert.match(page, /confirmed: it meets more goals and loses none/);
    // The history names the change by what it does, linked; its id is the link's title.
    assert.match(
      page,
      /The judge started screening <a href="[^"]+" title="a-7e1a0001">“Add a dispatch table/,
    );
    assert.match(
      page,
      /lane-1 submitted <a href="\/ui\/campaigns\/opus-simd\/runs\/dec-1\/attempts\/a-7e1a0001" title="a-7e1a0001">“Add a dispatch/,
    );
    // It opens with what it does and where it stands, in a sentence.
    assert.match(page, /<h1 class="att-title">Add a dispatch table that picks SIMD routines/);
    assert.match(
      page,
      /lane-1 submitted it [^<]* ago, on champion #1\. The judge did the goal checks again on new runs\. With this change, the project gets these goals that the champion does not get: vectors, recordings and simd/,
    );
    assert.match(page, /It waits for your decision\./);
    // What happened to it, step by step; the goals it moves; its files as bars.
    assert.match(
      page,
      /<span class="st">Held for an audit: the agent that made the change wrote problems with it<\/span>/,
    );
    assert.match(page, /<b>vectors<\/b> <span class="chip ok">newly met<\/span>/);
    assert.match(page, /<code>src\/dispatch\.c<\/code><span class="fl-bar">/);
    // Its decision is on its page too, as a box, without a link back to itself.
    assert.match(page, /<div class="decide decide-warn">/);
    assert.match(page, /Make it the champion/);
    assert.doesNotMatch(page, /Everything about this change/);
    assert.match(
      await get("/ui/campaigns/opus-simd/runs/dec-1/attempts/a-nope"),
      /No such attempt in this run/,
    );
  });

  test("a campaign and its run's views: at work, earlier runs, overview, history, planner", async () => {
    const { get } = await demo();
    // The campaign: the run at work first, then the earlier runs in one table.
    const camp = await get("/ui/campaigns/opus-simd");
    assert.match(camp, /<h2>At work now<\/h2><span class="n">1<\/span>/);
    assert.match(camp, /<h2>Earlier runs<\/h2><span class="n">1<\/span>/);
    assert.match(camp, /<b>dec-1<\/b>/);
    assert.match(camp, /moved to rig-b as dec-2/);
    assert.doesNotMatch(camp, /<nav class="tabs"><a class="on"/);
    // A run's own page: its tabs, and Restart the lanes under its menu.
    const run = await get("/ui/campaigns/opus-simd/runs/dec-2");
    assert.match(run, /id="run-dec-2"/);
    assert.match(run, /the judge's check of champion #1/);
    assert.match(run, /waiting on another goal/);
    assert.match(run, /Restart the lanes/);
    assert.match(run, /every lane starts again from the champion/);
    const history = await get("/ui/campaigns/opus-simd/runs/dec-2/history");
    assert.match(
      history,
      /The planner planned round 1: lane-1 on filter-bank; lane-2 on range-decoder\./,
    );
    const experiments = await get("/ui/campaigns/sum-speed/runs/sum-1/experiments");
    assert.match(experiments, /<h2>Up next<\/h2>/);
    assert.match(experiments, /Add an experiment/);
    const planner = await get("/ui/campaigns/sum-speed/runs/sum-1/planner");
    assert.match(planner, /<h2>Rules<\/h2>/);
    assert.match(planner, /Agent figures/);
    const attempts = await get("/ui/campaigns/sum-speed/runs/sum-1/attempts");
    assert.match(attempts, /blocked by the auditor/);
    assert.match(attempts, /waiting for your approval/);
    assert.match(attempts, /href="\/ui\/campaigns\/sum-speed\/runs\/sum-1\/attempts\/a-5b5b0001"/);
    // The Journal: the agents' field notes, newest first; the research note beside them.
    const journal = await get("/ui/campaigns/sum-speed/runs/sum-1/journal");
    assert.match(journal, /Journal <span class="muted">4 notes<\/span>/);
    assert.ok(journal.indexOf("A gain far above") < journal.indexOf("Unrolling past 8"));
    assert.match(journal, /href="\/ui\/campaigns\/sum-speed\/runs\/sum-1\/attempts\/a-9c9c0001"/);
    assert.match(journal, /The benchmark reads 64 MB per call/);
    // History tells what happened; the notes are not in it.
    assert.doesNotMatch(
      await get("/ui/campaigns/sum-speed/runs/sum-1/history"),
      /Unrolling past 8/,
    );
    // The campaign's collection on the Knowledge page.
    assert.match(
      await get("/ui/knowledge"),
      /<a class="kx-node" href="\/ui\/knowledge\/sum-speed"><svg[^>]*>[\s\S]*?<\/svg><span class="nm">sum-speed<\/span>/,
    );
  });

  test("agent-written text in decisions, timelines and attempt pages is escaped", async () => {
    const { store, get } = await demo();
    const at = new Date().toISOString();
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "ledger-rig-a",
      cursor: 0,
      next: 1000,
      events: [
        {
          id: 900,
          at,
          actor: "harness",
          kind: "attempt_recorded",
          subject: "a-evil0001",
          body: {
            run: "dec-1",
            lane: "lane-1",
            lifecycle: "queued",
            commit: "e".repeat(40),
            parent: "f".repeat(40),
            hypothesis: "<img src=x onerror=alert(1)> faster",
            known_flaws: ["<script>alert(2)</script>"],
          },
        },
        {
          id: 901,
          at,
          actor: "harness",
          kind: "audit_requested",
          subject: "a-evil0001",
          body: { audit: 9, run: "dec-1", reason: "declared flaws", expected_seq: 1 },
        },
      ],
      summary: {},
    });
    for (const path of [
      "/ui",
      "/ui/campaigns/opus-simd/runs/dec-1/attempts/a-evil0001",
      "/ui/rigs/rig-a",
    ]) {
      const html = await get(path);
      assert.ok(!html.includes("<img src=x"), path);
      assert.ok(!html.includes("<script>alert(2)"), path);
      assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; faster/, path);
    }
  });
});
