import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ADMIN,
  ev,
  part,
  RIG_TOKEN,
  RUN,
  researchControl,
  researchRunEvents,
  reviewLiveLines,
} from "../../helpers/research-reviews.ts";

/**
 * Goals 116 and 117 on the dashboard, from a rig's events: a research run's Overview shows each
 * question with its answer card, the review panel's decision that stands, its gaps, its share of
 * the recent tasks, its yield and whether it is saturated, and the progress rule; its Reviews tab
 * (and its campaign's) shows every review with each reviewer's answers and the decision on each
 * item; its Hypotheses tab lists them by status with the owner's Promote, Return to pool and
 * Retire, which send signed hypothesis_status commands; its Experiments tab shows each task's
 * question and yield.
 */

describe("a research run's page (goals 116 and 117)", () => {
  test("the Overview: each question's card, decision, gaps, share and yield, saturation and the progress rule", async () => {
    const c = await researchControl();
    await c.ingest(researchRunEvents());
    const html = await c.page(RUN);
    const block = part(html, 'data-part="research"', 'data-part="attempts"');
    assert.match(
      block,
      /<b>Questions:<\/b> 0 answered · 1 at the best available · 2 open \(1 saturated\)\./,
    );
    // The answer check keeps its line.
    assert.match(
      block,
      /<div class="small rcheck"><b>Answer check:<\/b> The review panel checks whether every question is answered \(review 3\)\.<\/div>/,
    );
    // The progress rule: a meter, its info icon, and what it waits for.
    assert.match(
      block,
      /<span class="k">Without an improvement<\/span><span><\/span><span class="v">1 h of 2 h<\/span>/,
    );
    assert.match(
      block,
      /<span class="lb">Progress rule<i class="ii" tabindex="0" data-tip="When every open question is saturated/,
    );
    assert.match(
      block,
      /It does not apply yet: Question 1 is not saturated, so the plan still gives it tasks\./,
    );
    assert.match(block, /<b>Hypotheses:<\/b> 3 need a verdict, 2 decided · 1 in the pool\./);
    assert.match(
      block,
      /href="\/ui\/campaigns\/survey\/runs\/s-1\/hypotheses"|href="\/ui\/campaigns\/survey\/runs\/s-1\/hypotheses"/,
    );

    const q1 = part(block, 'data-q="0"', 'data-q="1"');
    assert.match(q1, /<b>Question 1<\/b> What makes a benchmark repeatable\?/);
    // Its decision was on card version 1; the card is at version 2 now.
    assert.match(
      q1,
      /<span class="chip" title="Review 2 decided it answered, certainty high on answer card version 1\. The card has a newer version \(2\), so the review panel decides it again at its next review\.">to review again<\/span>/,
    );
    assert.match(q1, /card version 2 · certainty high · 2 claims cited · by teacher-1/);
    // A long answer is cut, with "more" to read it whole.
    assert.match(q1, /<details class="more"><summary><span class="more-part">Four guides agree/);
    assert.match(
      q1,
      /8 verified claims · 1 of the last 3 tasks · 1 task done added 3 verified claims, 2 from sites new to it · not saturated/,
    );

    const q2 = part(block, 'data-q="1"', 'data-q="2"');
    assert.match(q2, /<span class="gl-mark warn">≈<\/span>/);
    assert.match(q2, />best available, insufficient<\/span>/);
    assert.match(
      q2,
      /<b>Open gaps in the evidence<\/b>[\s\S]*<li>A second site on boost clocks\.<\/li>/,
    );
    assert.match(
      q2,
      /<b>Next experiments<\/b>[\s\S]*<li>Measure the variance with clocks locked\.<\/li>/,
    );
    assert.match(
      q2,
      /The synthesizer's newest card was refused [^:]+: the number 30 is not in the claims it cites\. The card above stands\./,
    );
    assert.match(
      q2,
      /2 of the last 3 tasks · 1 task done added 0 verified claims, 0 from sites new to it/,
    );
    // An ended question is neither saturated nor not.
    assert.doesNotMatch(q2, /saturated/);

    const q3 = part(block, 'data-q="2"', 'class="rq-sum muted xs"');
    assert.match(
      q3,
      />no decision yet<\/span> <span class="chip warn" title="Its last 4 tasks added no verified claim from a new site and did not change its answer card: the plan gives it no more tasks\.">saturated<\/span>/,
    );
    assert.match(
      q3,
      /No answer card yet\. The synthesizer writes one once the question has a verified claim\./,
    );
    assert.match(
      q3,
      /<div class="gl-why">0 verified claims · 0 of the last 3 tasks · saturated<\/div>/,
    );

    // The tabs: Reviews and Hypotheses, with their counts.
    assert.match(html, />Reviews <span class="muted">3<\/span><\/a>/);
    assert.match(html, />Hypotheses <span class="muted">6<\/span><\/a>/);
  });

  test("the Reviews tab: newest first; asked and posted, tries, outcome, cost, decisions with dissent and what came before, each reviewer, messages, Live lines; nothing secret", async () => {
    const c = await researchControl();
    await c.ingest(researchRunEvents());
    reviewLiveLines(c.store);
    const html = await c.page(`${RUN}/reviews`);
    // Newest first.
    const order = [3, 2, 1].map((n) => html.indexOf(`data-k="review-rig-a-s-1-${n}"`));
    assert.ok(order[0] !== undefined && order[0] > 0, String(order));
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );

    // Review 3 waits; its failed try is from Live, escaped.
    const r3 = part(html, 'data-k="review-rig-a-s-1-3"', 'data-k="review-rig-a-s-1-2"');
    assert.match(r3, /<span class="dq-kind"><svg[^>]*>[\s\S]*?<\/svg>Review 3<\/span>/);
    assert.match(r3, /Waiting for the review panel's answers/);
    assert.match(
      r3,
      /Asked [^ ]+ ago on 20 verified claims, 3 questions, 3 hypotheses; not posted yet\./,
    );
    assert.match(r3, />1 failed try<\/span>/);
    assert.match(r3, /1 failed so far, as far as the run's Live view shows/);
    assert.match(
      r3,
      /review 3: 2 of 3 reviewers of the review panel answered \(reviewer-2: the provider refused: 429\)/,
    );
    assert.match(r3, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);

    // Review 2 passed after three tries, and the owner accepted it with a note.
    const r2 = part(html, 'data-k="review-rig-a-s-1-2"', 'data-k="review-rig-a-s-1-1"');
    assert.match(r2, /<span class="label ok">Accepted<\/span>/);
    assert.match(r2, />3 tries<\/span>/);
    assert.match(
      r2,
      /<dt>Tries<\/dt><dd>3, as the rig reported it\. The tries that failed:<ul class="small"><li>Try 1, .+? UTC\)<\/span>: 2 of 3 reviewers of the review panel answered<\/li><li>Try 2, /,
    );
    assert.match(
      r2,
      /<dt>Outcome<\/dt><dd>Accepted by you: 3 items decided, 0 still open\. You accepted it [^ ]+ ago: “Good enough\.”\.<\/dd>/,
    );
    assert.match(r2, /<dt>Cost<\/dt><dd>2 calls · 40k tokens in · 1500 out · 2 min in calls<\/dd>/);
    assert.match(r2, />Question 2: best available, insufficient<\/span>/);
    // How each item changed since the review before.
    assert.match(
      r2,
      /<b class="nowrap" title="Which noise dominates\?">Question 2<\/b>[\s\S]*?<td class="small">open <span class="muted">\(review 1\)<\/span><\/td>/,
    );
    assert.match(
      r2,
      /<b class="nowrap" title="Warm-up runs remove outliers\.">hypothesis h-p2<\/b>[\s\S]*?first decision/,
    );
    // The owner's message to the review panel, given with this review, and the answer.
    assert.match(
      r2,
      /<b>Your messages to the review panel<\/b>[\s\S]*Judge question 2 by what sources can say\.[\s\S]*reviewer-1[\s\S]*Question 2 is the best available\./,
    );

    // Review 1: not passed; each reviewer's answers, and the problem code found.
    const r1 = part(html, 'data-k="review-rig-a-s-1-1"');
    assert.match(r1, /<span class="label warn">Not passed<\/span>/);
    assert.match(r1, /1 of 2 questions answered; 1 of 1 hypothesis given a verdict/);
    assert.match(r1, /<b>reviewer-3<\/b>: undecided <span class="muted">· One site only\.<\/span>/);
    assert.match(
      r1,
      /<b>reviewer-3<\/b> <span class="muted">· 2 of 2 questions answered · 0 of 1 hypothesis decided · [^<]+<\/span> <span class="chip bad">code found problems in 1 answer<\/span>/,
    );
    assert.match(
      r1,
      /<ul class="flaws bad"><li>the number 12 is not in the claims it cites<\/li><\/ul>/,
    );
    assert.match(r1, /<code>c-01<\/code> <code>c-02<\/code>/);
    assert.doesNotMatch(r1, /Your messages to the review panel/);
    // The reviewers' field notes that came with it, on the Journal; none came with review 2.
    assert.match(
      r1,
      /A field note of the reviewers came with it: on the run's <a href="\/ui\/campaigns\/survey\/runs\/s-1\/journal">Journal<\/a>, under <b>Review panel<\/b>\./,
    );
    assert.doesNotMatch(r2, /field notes? of the reviewers/);

    // Each item across reviews.
    assert.match(
      html,
      /<span>Question 2<\/span><span class="muted xs">open \(1\) → the best available, insufficient \(2\)<\/span>/,
    );
    assert.match(
      html,
      /<span>Question 1<\/span><span class="muted xs">answered, certainty moderate \(1\) → answered, certainty high \(2\) → to review again<\/span>/,
    );
    // Nothing secret: no token of control's or the rig's.
    assert.doesNotMatch(html, new RegExp(`${ADMIN}|${RIG_TOKEN}`));
  });

  test("the campaign's Reviews tab lists each run's reviews by run; a review from before item reviews shows its counts and gaps", async () => {
    const c = await researchControl();
    await c.ingest([
      ev(
        "run_created",
        { campaign: "survey", version: 1, mode: "research", seed: { repo: "research" } },
        0,
        "s-0",
      ),
      ev("review_requested", { review: 1, goal: "research", commit: "corpus:3" }, 0.5, "s-0"),
      ev(
        "review_panel",
        {
          review: 1,
          goal: "research",
          result: "review_failed",
          reviewers: 2,
          questions: [
            { question: 0, answered_by: 2, answer: "Record the clocks." },
            { question: 1, answered_by: 0 },
          ],
          gaps: ["Question 2: missing: a second site"],
        },
        0.6,
        "s-0",
      ),
      ev("run_status", { status: "closed", reason: "closed by the owner" }, 0.7, "s-0"),
      ...researchRunEvents(),
    ]);
    const html = await c.page("/ui/campaigns/survey?view=reviews");
    assert.match(
      html,
      /<nav class="tabs"><a class="" href="\/ui\/campaigns\/survey">Overview<\/a><a class="on" href="\/ui\/campaigns\/survey\?view=reviews">Reviews <span class="muted">4<\/span><\/a><\/nav>/,
    );
    const s1 = html.indexOf(">s-1</a></h2>");
    const s0 = html.indexOf(">s-0</a></h2>");
    assert.ok(s1 > 0 && s0 > s1, "the run at work first, then the earlier run");
    const old = part(html, 'data-k="review-rig-a-s-0-1"');
    assert.match(old, /1 of 2 questions found answered by every reviewer/);
    assert.match(
      old,
      /<li>Question 1: 2 of 2 <span class="muted">· Record the clocks\.<\/span><\/li><li>Question 2: 0 of 2<\/li>/,
    );
    assert.match(
      old,
      /<b>What the reviewers found missing<\/b>[\s\S]*<li>Question 2: missing: a second site<\/li>/,
    );
    // The campaign's Overview has the same tabs, Overview chosen; a hill climb's page has none.
    assert.match(
      await c.page("/ui/campaigns/survey"),
      /<a class="on" href="\/ui\/campaigns\/survey">Overview<\/a>/,
    );
    await c.ingest([
      ev(
        "run_created",
        { campaign: "speed", version: 1, mode: "hill_climb", seed: { repo: "p", commit: "a" } },
        9,
        "hc-1",
      ),
    ]);
    const hill = await c.page("/ui/campaigns/speed?view=reviews");
    assert.doesNotMatch(hill, /<nav class="tabs">|Reviews <span/);
    assert.doesNotMatch(
      await c.page("/ui/campaigns/speed/runs/hc-1"),
      /view=reviews|view=hypotheses/,
    );
  });

  test("the Hypotheses tab: by status with questions and verdicts; Promote, Return to pool and Retire send hypothesis_status with why", async () => {
    const c = await researchControl();
    await c.ingest(researchRunEvents());
    const html = await c.page(`${RUN}/hypotheses`);
    const need = part(html, "<h2>Need a verdict</h2>", "<h2>The pool</h2>");
    // The author's (one from before the pool), then the promoted one; no moves on the author's.
    assert.match(need, /data-h="h-a1"[\s\S]*data-h="h-a2"[\s\S]*data-h="h-p2"/);
    const a1 = part(need, 'data-h="h-a1"', 'data-h="h-a2"');
    assert.match(a1, /<span class="qkind author"[^>]*>author<\/span>/);
    assert.match(a1, /<span class="chip">the whole run<\/span>/);
    assert.match(a1, />supported<\/span> <span class="muted xs">review 1 · 1 dissent<\/span>/);
    assert.match(a1, /The author's: it changes only with the campaign's brief\./);
    assert.doesNotMatch(a1, /hypothesis_status/);
    assert.match(
      part(need, 'data-h="h-a2"', 'data-h="h-p2"'),
      /Heat &lt;b&gt;matters&lt;\/b&gt;\./,
    );
    assert.match(part(need, 'data-h="h-a2"', 'data-h="h-p2"'), />no verdict yet<\/span>/);
    const p2 = part(need, 'data-h="h-p2"');
    assert.match(p2, /<span class="chip">Question 1<\/span>/);
    assert.match(p2, /You set it to promoted [^ ]+ ago: “Question 1 turns on it\.”/);
    assert.match(
      p2,
      /<summary class="btn sm ghost">Return to pool<\/summary>[\s\S]*<summary class="btn sm ghost">Retire<\/summary>/,
    );
    assert.doesNotMatch(p2, />Promote</);
    // The pool: Promote and Retire, each with its info icon, why and what it does.
    const pool = part(html, "<h2>The pool</h2>", "Merged and retired");
    assert.match(pool, /data-h="h-p1"/);
    assert.match(
      pool,
      /<summary class="btn sm ghost">Promote<\/summary>[\s\S]*?<input type="hidden" name="kind" value="hypothesis_status"><input type="hidden" name="run" value="s-1"><input type="hidden" name="id" value="h-p1"><input type="hidden" name="status" value="promoted">/,
    );
    assert.match(
      pool,
      /<i class="ii" tabindex="0" data-tip="Promote: The review panel must give it a verdict/,
    );
    // Merged and retired, folded; the retired one may go back to the pool, the merged one not.
    const rest = part(html, "Merged and retired: 2");
    assert.match(rest, /data-h="h-p3"[\s\S]*merged into <code>h-p1<\/code>/);
    assert.match(
      part(rest, 'data-h="h-p4"'),
      /The planner set it to retired [^ ]+ ago: “Out of scope\.”/,
    );
    assert.match(
      part(rest, 'data-h="h-p4"'),
      /<summary class="btn sm ghost">Return to pool<\/summary>/,
    );
    assert.doesNotMatch(part(rest, 'data-h="h-p3"', 'data-h="h-p4"'), /<summary/);
    // Every form label has its info icon with a description.
    const labels = html.match(/class="lb"/g)?.length ?? 0;
    const tips =
      html.match(
        /<span class="lb">[^<]*<i class="ii" tabindex="0" data-tip="[^"]+">i<\/i><\/span>/g,
      )?.length ?? 0;
    assert.ok(labels > 0 && tips === labels, `${labels} labels, ${tips} with descriptions`);

    // The owner's move: a signed command, followed as any other (goal 080).
    const sent = await c.send({
      rig: "rig-a",
      kind: "hypothesis_status",
      run: "s-1",
      id: "h-p1",
      status: "promoted",
      reason: "The questions turn on it.",
      back: `${RUN}/hypotheses`,
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.answer));
    assert.match(String(sent.answer.follow), /^\/ui\/commands\//);
    const cmd = c.store.commands.latest("rig-a", "hypothesis_status")[0];
    assert.deepEqual(cmd?.payload, {
      run: "s-1",
      id: "h-p1",
      status: "promoted",
      reason: "The questions turn on it.",
    });
    // Without a reason, control refuses before it signs, in words.
    const refused = await c.send({
      rig: "rig-a",
      kind: "hypothesis_status",
      run: "s-1",
      id: "h-p1",
      status: "retired",
      reason: "  ",
    });
    assert.equal(refused.status, 400);
    assert.match(String(refused.answer.said), /write why you change the hypothesis first/i);
    // A closed run's hypotheses have no moves.
    await c.ingest([ev("run_status", { status: "closed", reason: "closed by the owner" })]);
    assert.doesNotMatch(await c.page(`${RUN}/hypotheses`), /name="kind" value="hypothesis_status"/);
  });

  test("the Tasks tab shows each research task's question and yield; a task that added nothing is not drawn as a gain", async () => {
    const c = await researchControl();
    await c.ingest(researchRunEvents());
    const html = await c.page(`${RUN}/experiments`);
    // A research run's queue is called Tasks, and its parts are named for tasks.
    assert.match(html, /\/experiments">Tasks <span class="muted">/);
    assert.doesNotMatch(html, />Experiments <span class="muted">|Add an experiment/);
    assert.match(html, /<span class="lb">Add a task<i class="ii"/);
    assert.match(html, /<thead><tr><th>Task<\/th><th>Kind of task<\/th><th>Added by<\/th>/);
    // Up next: a task whose title names no question gets its question as a chip.
    assert.match(
      html,
      /read the driver notes<\/div>[\s\S]*?<span class="chip" title="How many repetitions\?">Question 3<\/span>/,
    );
    const tried = part(html, 'id="qtried"');
    assert.match(
      tried,
      /<span class="qres done">finished: 3 verified claims, 2 from sites new to its question, 2 sites new to the run, 1 finding, 1 card change<\/span>/,
    );
    assert.match(tried, /<span class="qres done flat">finished: no verified claim<\/span>/);
    // Its title names its question already: no chip repeats it.
    assert.doesNotMatch(tried, /survey the guides<\/b> <span class="chip"/);
  });

  test("at the scale of a long run: 300 hypotheses in the pool and 20 more reviews of five reviewers draw, the pool cut in words", async () => {
    const c = await researchControl();
    const events = researchRunEvents();
    for (let i = 0; i < 300; i++)
      events.push(
        ev(
          "hypothesis_added",
          {
            hypothesis: `h-x${i}`,
            lane: `lane-${(i % 4) + 1}`,
            text: `Pool hypothesis ${i}.`,
            supporting: [],
            question: i % 3,
            status: "pool",
          },
          8.1,
        ),
      );
    for (let n = 4; n < 24; n++) {
      events.push(
        ev(
          "review_requested",
          { review: n, goal: "research", commit: `corpus:${n}`, questions: 3, hypotheses: 3 },
          8.2,
        ),
      );
      for (let r = 1; r <= 5; r++)
        events.push(
          ev(
            "review_items",
            {
              review: n,
              reviewer: `reviewer-${r}`,
              items: [0, 1, 2].map((q) => ({
                kind: "question",
                key: q,
                card_version: 2,
                verdict: "open",
                certainty: null,
                reasons: "Gaps remain.",
                claims: [],
                problems: [],
              })),
            },
            8.3,
          ),
        );
      for (const q of [0, 1, 2])
        events.push(
          ev(
            "item_decided",
            { review: n, kind: "question", key: q, card_version: 2, decision: "open", dissent: [] },
            8.35,
          ),
        );
      events.push(
        ev(
          "review_panel",
          {
            review: n,
            goal: "research",
            result: "review_failed",
            reviewers: 5,
            decided: 0,
            open: 3,
          },
          8.4,
        ),
      );
    }
    await c.ingest(events);
    const started = performance.now();
    const hypotheses = await c.page(`${RUN}/hypotheses`);
    const reviews = await c.page(`${RUN}/reviews`);
    const ms = performance.now() - started;
    assert.match(hypotheses, /The first 150 of 301\. MCP's get_run lists them all\./);
    assert.equal(hypotheses.match(/class="qrule hy"/g)?.length, 3 + 150 + 2);
    assert.equal(reviews.match(/<details class="dq /g)?.length, 23);
    assert.match(reviews, /<b>reviewer-5<\/b> <span class="muted">· 0 of 3 questions answered/);
    assert.ok(ms < 10_000, `${Math.round(ms)} ms`);
  });
});
