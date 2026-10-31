import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import { runMessages } from "../../../../src/control/views/index.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import type { TrialResult, TrialSpec } from "../../../../src/harness/agents/worker/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";
import { form, unesc, yours } from "./page.ts";
import { stack } from "./stack.ts";

/**
 * The run page's Experiments and Planner tabs, driven as a browser drives them: the queue and
 * the lanes' ideas, the rules, Tell the planner, and a new run from the untried experiments.
 */

describe("the run page's Experiments and Planner tabs", () => {
  test("add, drag, edit and drop experiments; queue or drop a lane's idea; rules added and removed; Tell the planner, and what the planner did; a new run starts from the untried ones", async (t: TestContext) => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    const s = await stack(env);
    // Assigned over the owner's REST API: not made on the New campaign page.
    const payload = (env.assign as { envelope: { payload: Record<string, unknown> } }).envelope
      .payload;
    const assigned = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "assign_campaign",
      payload,
    });
    assert.equal(assigned.status, 201, await assigned.clone().text());
    await s.sync();
    const EXP = "/ui/campaigns/js-sum/runs/js-1/experiments";
    const PLAN = "/ui/campaigns/js-sum/runs/js-1/planner";
    const HISTORY = "/ui/campaigns/js-sum/runs/js-1/history";
    const q = '(?:"|&quot;)';
    let exp = await s.get(EXP);
    let plan = await s.get(PLAN);
    assert.match(
      exp,
      /Nothing queued\. The planner adds experiments as it plans; you can add one above\./,
    );
    // Rules come from Tell the planner (goal 066): the tab has no Add a rule form.
    assert.match(
      plan,
      /No rules\. The planner follows the queue and its own judgment\. To make one, tell the planner below\./,
    );
    assert.doesNotMatch(plan, /Add a rule|Add the rule/);
    assert.match(plan, /No hand-out yet\./);
    assert.match(
      plan,
      /<h3>The run's directions <span class="muted small">0<\/span><\/h3>[\s\S]*?None yet\. Each experiment adds its own\./,
    );
    // The box takes the picker of the run's directions, and the page loads its script.
    assert.match(
      plan,
      /<textarea name="text" rows="3" required data-words data-dpick data-dirs="\[\]"/,
    );
    assert.match(plan, /<script src="\/ui\/assets\/planner\.js" defer><\/script>/);
    // Every field of the forms has its description.
    for (const label of ["Add an experiment", "Direction", "Where", "Why", "Details"])
      assert.match(
        exp,
        new RegExp(`<span class="lb">${label}<i class="ii" tabindex="0" data-tip="[^"]+">i</i>`),
      );
    assert.match(
      plan,
      /<span class="lb">Your message<i class="ii" tabindex="0" data-tip="[^"]+">i<\/i>/,
    );

    /** Up next, in order: each experiment's id and title, as the page lists them. */
    const upNext = (html: string) =>
      [
        ...html.matchAll(
          /<div class="qi" draggable="true" data-id="([^"]+)"[\s\S]*?<div class="qt">([^<]*)</g,
        ),
      ].map((m) => ({ id: m[1] ?? "", title: unesc(m[2] ?? "") }));
    const idOf = (html: string, title: string) =>
      upNext(html).find((x) => x.title === title)?.id ?? "";

    // Add three, as the form is filled in: at the top (the default) or at the end.
    await s.submit(form(exp, "Add"), {
      title: "unroll the loop by 4",
      family: "loop-unrolling",
      why: "fewer branches",
    });
    await s.sync();
    await s.submit(form(exp, "Add"), {
      title: "vector loads",
      family: "memory-layout",
      position: "end",
    });
    await s.sync();
    await s.submit(form(exp, "Add"), {
      title: "prefetch the next block",
      details: "two blocks ahead",
      position: "end",
    });
    await s.sync();
    exp = await s.get(EXP);
    assert.deepEqual(
      upNext(exp).map((x) => x.title),
      ["unroll the loop by 4", "vector loads", "prefetch the next block"],
    );
    assert.match(
      exp,
      /<div class="qt">unroll the loop by 4<\/div><div class="qwhy">fewer branches<\/div><div class="qmeta"><span class="qsrc you">you<\/span><span class="qdir">loop-unrolling<\/span>/,
    );

    // Drag "prefetch" onto the upper half of "vector loads": the script sends its new place.
    const prefetch = idOf(exp, "prefetch the next block");
    const moved = await s.post("/ui/commands", {
      csrf: form(exp, "Add").fields.csrf ?? "",
      rig: "rig-a",
      run: "js-1",
      kind: "queue_move",
      id: prefetch,
      position: "1",
      back: EXP,
    });
    assert.equal(moved.status, 303);
    await s.sync();
    exp = await s.get(EXP);
    assert.deepEqual(
      upNext(exp).map((x) => x.title),
      ["unroll the loop by 4", "prefetch the next block", "vector loads"],
    );

    // Edit "vector loads": its form holds its words; change the title and say why.
    const vector = idOf(exp, "vector loads");
    const edit = form(exp, "Save", `data-id="${vector}"`);
    assert.deepEqual(
      [edit.fields.kind, edit.fields.id, edit.fields.title, edit.fields.family, edit.fields.why],
      ["queue_edit", vector, "vector loads", "memory-layout", ""],
    );
    await s.submit(edit, { title: "vector loads (half2)", why: "twice the bandwidth" });
    await s.sync();
    exp = await s.get(EXP);
    assert.match(
      exp,
      /<div class="qt">vector loads \(half2\)<\/div><div class="qwhy">twice the bandwidth<\/div>/,
    );
    // The same edit over the owner's REST API: an edit that changes nothing is refused at once.
    const empty = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "queue_edit",
      payload: { run: "js-1", id: vector },
    });
    assert.equal(empty.status, 400);
    assert.match(
      String(((await empty.json()) as { error: string }).error),
      /^bad queue_edit payload: payload: change at least one of title, details, family and why/,
    );
    const viaApi = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "queue_edit",
      payload: { run: "js-1", id: vector, details: "load two values at once" },
    });
    assert.equal(viaApi.status, 201, await viaApi.clone().text());
    await s.sync();
    exp = await s.get(EXP);
    assert.equal(
      form(exp, "Save", `data-id="${vector}"`).fields.details,
      "load two values at once",
    );

    // Drop "unroll", with why: it leaves Up next and shows in Tried.
    const unroll = idOf(exp, "unroll the loop by 4");
    await s.submit(form(exp, "Drop it", `data-id="${unroll}"`), {
      why: "measured slower last run",
    });
    await s.sync();
    exp = await s.get(EXP);
    assert.deepEqual(
      upNext(exp).map((x) => x.title),
      ["prefetch the next block", "vector loads (half2)"],
    );
    assert.match(
      exp,
      /<tr data-r="none"[^>]*><td><b>unroll the loop by 4<\/b>[\s\S]*?dropped by you: measured slower last run/,
    );

    // Rules set elsewhere show here too (goal 066): the owner's over the REST API, a direction
    // as :name: or in plain words with spaces. A direction the run doesn't have yet is new: the
    // planner designs it. An old rule in words, as an older harness wrote it, stays in force
    // until the planner's next round converts it.
    const redirect = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "redirect",
      payload: {
        run: "js-1",
        directives: [
          { kind: "avoid", family: ":loop tiling:", rationale: "three trials regressed" },
          { kind: "try", family: "Vector loads", rationale: "the guide says twice the bandwidth" },
        ],
        replace: false,
      },
    });
    assert.equal(redirect.status, 201, await redirect.clone().text());
    const [legacy] = env.service.ledger.directives.addSet(
      "js-1",
      "control:owner:ui",
      [
        {
          kind: "avoid",
          match: "anything that uses shared memory",
          rationale: "slow on this GPU",
          citations: [],
        },
      ],
      false,
    );
    await s.sync();
    plan = await s.get(PLAN);
    /** The page's words, without markup. */
    const words = (html: string) => unesc(html.replace(/<[^>]+>/g, ""));
    const tok = (name: string, fresh = false) =>
      `<span class="dtok${fresh ? " new" : ""}"><i>:</i>${name}<i>:</i></span>`;
    assert.ok(
      plan.includes(
        `<b>Avoid ${tok("loop-tiling", true)}</b> <span class="muted small">· set by</span> <span class="qsrc you">you</span>`,
      ),
    );
    assert.match(
      plan,
      /three trials regressed<\/div><div class="xs" style="margin-top:3px">A new direction\. The planner designs it at its next round, then adds it to the run's directions\.<\/div>/,
    );
    assert.ok(plan.includes(`<b>Try ${tok("vector-loads", true)}</b>`));
    assert.match(
      plan,
      /<div class="qrule legacy"><span class="qkind words">words<\/span><div><b>Avoid “anything that uses shared memory”<\/b>/,
    );
    // It converts on its own: no button to name a direction for it, only Remove.
    assert.match(
      words(plan),
      /An old rule in words, from before rules named directions\. It converts at the planner's next round: round 1\. The planner names its direction, and code keeps the new rule\. Until then, only the planner's model reads it\.Remove/,
    );
    assert.doesNotMatch(plan, /Name a direction|data-fill/);
    // The run's directions: its experiments', then those its rules name, which wait for the planner.
    const dirRows = (html: string) =>
      [...html.matchAll(/<div class="dlrow[^"]*"[^>]*>([\s\S]*?)<\/span><\/div>/g)].map((m) =>
        words(m[1] ?? ""),
      );
    assert.deepEqual(dirRows(plan), [
      ":memory-layout:not tried yet · 1 up next",
      ":loop-unrolling:not tried yet",
      ":loop-tiling:new: the planner designs it at its next round · avoid",
      ":vector-loads:new: the planner designs it at its next round · try",
    ]);
    const picked = JSON.parse(unesc(/data-dirs="([^"]*)"/.exec(plan)?.[1] ?? "")) as {
      name: string;
      new: boolean;
    }[];
    assert.deepEqual(
      picked.map((d) => [d.name, d.new]),
      [
        ["memory-layout", false],
        ["loop-unrolling", false],
        ["loop-tiling", true],
        ["vector-loads", true],
      ],
    );

    // Tell the planner refuses a message of only spaces, on the tab.
    const blank = await s.submit(form(plan, "Send to the planner"), { text: "  \n " });
    assert.ok(blank.endsWith("/planner?msgerror=Write a message first."), blank);
    assert.match(
      await s.get(`${PLAN}?msgerror=${encodeURIComponent("Write a message first.")}`),
      /<h3>Tell the planner<\/h3><div class="lnotice">[\s\S]*?<b>Not sent\.<\/b> Write a message first\./,
    );
    // Plain words: back on the tab, which says the message went.
    const told = await s.submit(form(plan, "Send to the planner"), {
      text: "Never touch the timer code.",
    });
    assert.ok(told.startsWith(`${decodeURIComponent(PLAN)}?sent=`), told);
    const back = await s.get(`${PLAN}?sent=${encodeURIComponent(told.split("?sent=")[1] ?? "")}`);
    assert.match(
      back,
      /Sent to the rig\. The planner reads it when it next gives out work; Commands shows whether the rig took it\./,
    );
    await s.sync();
    const sent = [...runMessages(s.store, "rig-a", "js-1")].filter(([, m]) => m.to === "planner");
    const message = sent.find(([, m]) => m.text === "Never touch the timer code.")?.[0];
    assert.ok(message);
    // It waits on the tab until the planner's next round reads it.
    plan = await s.get(PLAN);
    assert.deepEqual(
      [...plan.matchAll(/<div class="qturn" data-msg="(\d+)">/g)].map((m) => Number(m[1])),
      [message],
    );
    assert.equal(
      plan.match(
        /Sent\. The planner reads it when it next gives out work: round 1\. Its answer shows here\./g,
      )?.length,
      1,
    );

    // A round: the planner's model gives out the queue's top two, sets the rule the owner's
    // message asked for and converts the old rule in words; lane-1's worker proposes two ideas
    // as it works.
    const fake = await startFakeModel(({ tools }) =>
      tools.some((x) => x.function.name === "submit_plan")
        ? {
            toolCalls: [
              {
                name: "submit_plan",
                args: {
                  assignments: [
                    { lane: "lane-1", experiment: prefetch, why: "the top of the queue" },
                    { lane: "lane-2", experiment: vector, why: "the rule: vector loads first" },
                  ],
                  // It designs the new directions the owner's rules name, one for the rule the
                  // owner's plain words ask for, and one the old rule in words converts to.
                  new_families: [
                    { id: "loop-tiling", description: "tile the loops for the cache" },
                    { id: "vector loads", description: "wider loads, such as half2" },
                    { id: ":timer code:", description: "any change to the timing code" },
                    {
                      id: "shared memory",
                      description: "kernels that stage data in shared memory",
                    },
                  ],
                  rules: [
                    {
                      kind: "avoid",
                      family: "timer code",
                      rationale: "the owner asked for it",
                      from_message: message,
                    },
                  ],
                  convert: [{ rule: legacy, family: ":shared memory:" }],
                  notes: "loads first",
                },
              },
            ],
          }
        : { text: "done" },
    );
    t.after(() => fake.close());
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
      owner: "steering-ui-test",
      plannerOn: () => true,
      maxConcurrent: 2,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      runTrial: async (spec: TrialSpec): Promise<TrialResult> => {
        if (spec.lane === "lane-1" && spec.token) {
          env.service.proposeIdea(spec.token, {
            title: "fuse the two loops",
            why: "one pass over memory",
          });
          env.service.proposeIdea(spec.token, { title: "use a lookup table" });
        }
        return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    await env.drain(); // the judge's baseline of the starting point: the rounds wait for it
    assert.ok(await scheduler.tick(), "trials started");
    await scheduler.idle();
    await scheduler.tick();
    await s.sync();

    // What the planner did, its rule with the message it came from, and the message read.
    plan = await s.get(PLAN);
    assert.match(
      plan,
      /<b>Round 1<\/b>: <ul><li><b>lane-1<\/b>: prefetch the next block <span class="muted">· the top of the queue<\/span><\/li><li><b>lane-2<\/b>: vector loads \(half2\) <span class="muted">· the rule: vector loads first<\/span><\/li><\/ul><div class="muted small">loads first<\/div>/,
    );
    assert.match(
      words(plan),
      /Avoid :timer-code: · set by planner \d+[smh] ago\s*the owner asked for it \(from your message: “Never touch the timer code\.”\)\s*Code keeps it at every hand-out\. No lane gets it\./,
    );
    // The directions it designed for your rules, in its words; they are the run's now.
    const tiling = (await s.run("js-1")).rules.find((x) => x.body.family === "loop-tiling")?.id;
    assert.ok(tiling);
    assert.ok(
      plan.includes(
        `<div>Designed the direction ${tok("loop-tiling")} for rule ${tiling} <span class="muted">· tile the loops for the cache</span></div>`,
      ),
    );
    assert.doesNotMatch(plan, /A new direction\. The planner designs it/);
    // (general: the direction of the trial that took the experiment with none.)
    assert.deepEqual(dirRows(plan), [
      ":memory-layout:1 tried",
      ":general:not tried yet",
      ":loop-tiling:not tried yet · avoid",
      ":loop-unrolling:not tried yet",
      ":shared-memory:not tried yet · avoid",
      ":timer-code:not tried yet · avoid",
      ":vector-loads:not tried yet · try",
    ]);
    assert.match(
      plan,
      /1 round so far: 1 planned by the model, 0 in queue order by the fixed rules/,
    );
    // Its log has the rule it set too, with why and the message it came from, and the read.
    assert.ok(
      plan.includes(
        `<div>Set the rule avoid ${tok("timer-code")} <span class="muted">· the owner asked for it</span> <span class="muted">(from your message: “Never touch the timer code.”)</span></div>`,
      ),
    );
    assert.match(
      words(plan),
      /Read your message “Never touch the timer code\.” in round 1: made 1 rule from it/,
    );
    // Tell the planner shows its answer to each message: the rule it made, the direction it
    // designed for it, and what the rule does now.
    const answers = Object.fromEntries(
      [
        ...plan.matchAll(
          /<div class="qturn" data-msg="(\d+)">([\s\S]*?)<\/div><\/div>(?=<div class="qturn"|<\/div>)/g,
        ),
      ].map((m) => [Number(m[1]), words(m[2] ?? "").replace(/\s+/g, " ")]),
    ) as Record<number, string>;
    assert.match(
      answers[message] ?? "",
      /^you \d\d:\d\dNever touch the timer code\.planner round 1 · \d\d:\d\dRead your message\. Made 1 rule:Avoid :timer-code: new direction · the owner asked for itThe run had none for it, so the planner designed it: any change to the timing code\. No lane gets it\.Its notes for the round: loads first$/,
    );
    assert.doesNotMatch(plan, /Sent\. The planner reads it when it next gives out work/);
    // The old rule in words, converted at the round: a normal rule on the direction the planner
    // designed for it, still yours, with the words it replaced; its log says so.
    assert.doesNotMatch(plan, /class="qrule legacy"/);
    const shared = (await s.run("js-1")).rules.find((x) => x.body.family === "shared-memory");
    assert.ok(shared);
    assert.match(
      words(plan),
      /Avoid :shared-memory: · set by you \d+[smh] ago\s*slow on this GPU\s*converted from: “anything that uses shared memory”\s*Code keeps it at every hand-out\. No lane gets it\./,
    );
    assert.ok(
      plan.includes(
        `<div>Converted the old rule in words “anything that uses shared memory” (rule ${legacy}) to Avoid ${tok("shared-memory")} (rule ${shared.id})</div>`,
      ),
    );
    assert.ok(
      plan.includes(
        `<div>Designed the direction ${tok("shared-memory")} for rule ${legacy} <span class="muted">· kernels that stage data in shared memory</span></div>`,
      ),
    );
    assert.ok(
      yours(await s.get("/ui/campaigns/js-sum/runs/js-1/live")).includes(
        "✓ planner read your message: “Never touch the timer code.”",
      ),
    );

    // The lanes' ideas wait for the planner or you: queue one, drop the other.
    exp = await s.get(EXP);
    assert.match(
      exp,
      /<div class="qidea"><div>fuse the two loops<\/div><div class="muted xs">one pass over memory<\/div><div class="muted xs"><span class="qsrc lane">lane-1's idea<\/span>/,
    );
    await s.submit(form(exp, "Queue it", "fuse the two loops"));
    await s.sync();
    await s.submit(form(exp, "Drop", "use a lookup table"));
    await s.sync();
    exp = await s.get(EXP);
    assert.deepEqual(
      upNext(exp).map((x) => x.title),
      ["fuse the two loops"],
    );
    assert.match(exp, /None waiting\. Lanes propose ideas while they work\./);
    assert.match(
      exp,
      /<b>use a lookup table<\/b>[\s\S]*?dropped by you: the owner dropped this idea/,
    );
    // The two given out are in Tried, with the lane and trial that took them.
    for (const [title, lane] of [
      ["prefetch the next block", "lane-1"],
      ["vector loads \\(half2\\)", "lane-2"],
    ])
      assert.match(
        exp,
        new RegExp(
          `<tr data-r="none"[^>]*><td><b>${title}</b>[\\s\\S]*?<td class="muted small">${lane} · trial t-`,
        ),
      );
    // Tried's filters: the result (chips), and lists of the directions and authors it holds.
    const list = (attr: string) =>
      [
        ...(
          new RegExp(`<select class="qsel" ${attr}[^>]*>([\\s\\S]*?)</select>`).exec(exp)?.[1] ?? ""
        ).matchAll(/<option value="([^"]*)">([^<]*)</g),
      ].map((m) => [m[1], unesc(m[2] ?? "")]);
    assert.deepEqual(list("data-qd"), [
      ["", "Every direction"],
      ["loop-unrolling", "loop-unrolling"],
      ["memory-layout", "memory-layout"],
    ]);
    assert.deepEqual(list("data-qb"), [
      ["", "Anyone added it"],
      ["lane-1's idea", "lane-1's idea"],
      ["you", "you"],
    ]);
    // Each row carries its result, direction and author, which the filters match.
    assert.deepEqual(
      [...exp.matchAll(/<tr data-r="([^"]*)" data-d="([^"]*)" data-b="([^"]*)"><td><b>([^<]*)</g)]
        .map((m) => [unesc(m[4] ?? ""), m[1], m[2], unesc(m[3] ?? "")])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ["prefetch the next block", "none", "", "you"],
        ["unroll the loop by 4", "none", "loop-unrolling", "you"],
        ["use a lookup table", "none", "", "lane-1's idea"],
        ["vector loads (half2)", "none", "memory-layout", "you"],
      ],
    );

    // Remove one of your rules; the planner's stays.
    await s.submit(form(plan, "Remove", `<b>Try ${tok("vector-loads")}</b>`));
    await s.sync();
    plan = await s.get(PLAN);
    assert.doesNotMatch(words(plan), /Try :vector-loads:/);
    assert.ok(plan.includes(`<b>Avoid ${tok("loop-tiling")}</b>`));
    assert.ok(plan.includes(`<b>Avoid ${tok("timer-code")}</b>`));

    // History tells each change, who made it and why.
    const history = await s.get(HISTORY);
    for (const line of [
      `You added ${q}unroll the loop by 4${q} to the queue\\.`,
      `You moved ${q}prefetch the next block${q} to place 2\\.`,
      `You edited ${q}vector loads \\(half2\\)${q}\\.`,
      `You dropped ${q}unroll the loop by 4${q}: measured slower last run\\.`,
      "You set a rule for the plan: avoid :loop-tiling:\\.",
      "The planner designed the new direction :loop-tiling: for rule \\d+: tile the loops for the cache\\.",
      "The planner set a rule for the plan: avoid :timer-code:\\.",
      "The planner converted rule \\d+, an old rule in words \\(“anything that uses shared memory”\\), to rule \\d+: avoid :shared-memory:\\.",
      `The planner gave out round 1: lane-1 on ${q}prefetch the next block${q}; lane-2 on ${q}vector loads \\(half2\\)${q}\\.`,
      `lane-1 proposed ${q}fuse the two loops${q} as an idea for the queue\\.`,
      `You queued the idea ${q}fuse the two loops${q}\\.`,
      `You dropped ${q}use a lookup table${q}: the owner dropped this idea\\.`,
      "You removed rule \\d+\\.",
    ])
      assert.match(history, new RegExp(line));

    // Live is for watching and writing: no queue and no rules there.
    const live = await s.get("/ui/campaigns/js-sum/runs/js-1/live");
    assert.doesNotMatch(live, /id="qlist"|class="qrule"|Add a rule|Up next/);

    // Start a run from the campaign's page: the rig is busy with js-1, and the new run starts
    // from js-1's untried experiments (copied by default, with agents on).
    const start = await s.get("/ui/campaigns/js-sum?start=1");
    assert.match(
      start,
      /<b>rig-a<\/b>[\s\S]*?Busy: js-1 is at work there, and pauses when this run starts \(a rig runs one run at a time\)\.[\s\S]*?<span class="warn">busy<\/span>/,
    );
    const go = form(start, "Start the run");
    assert.deepEqual(
      [go.fields.rig, go.fields.agents, go.fields.copy_queue, go.fields.copy_from],
      ["rig-a", "on", "1", "js-1"],
    );
    assert.match(start, /<option value="js-1">js-1 \(1 up next\)<\/option>/);
    const started = await s.submit(go);
    const next = /\/runs\/([^/?&]+)/.exec(started)?.[1] ?? "";
    assert.ok(next && next !== "js-1", started);
    const copied = s.signed("assign_campaign").at(-1);
    assert.equal(copied?.run, next);
    assert.deepEqual(copied?.queue, [
      {
        title: "fuse the two loops",
        why: "one pass over memory",
        by: "lane-1",
        state: "queued",
        from: { run: "js-1", id: idOf(exp, "fuse the two loops") },
      },
    ]);
    await s.sync();
    const fresh = await s.get(`/ui/campaigns/js-sum/runs/${next}/experiments`);
    assert.deepEqual(
      upNext(fresh).map((x) => x.title),
      ["fuse the two loops"],
    );
    assert.match(
      fresh,
      /<div class="qt">fuse the two loops<\/div><div class="qwhy">one pass over memory<\/div><div class="qmeta"><span class="qsrc lane">lane-1's idea<\/span><span class="muted xs">from js-1<\/span>/,
    );
    assert.match(
      await s.get(`/ui/campaigns/js-sum/runs/${next}/history`),
      new RegExp(`${q}fuse the two loops${q} was copied into the queue from run js-1\\.`),
    );
  });
});
