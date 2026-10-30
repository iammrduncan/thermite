import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stack } from "./stack.ts";

/**
 * A run's page: its Experiments and Planner tabs, the planner's script, its agents and their wait
 * for the provider, or a run without any.
 */

describe("control dashboard", () => {
  test("the Experiments and Planner tabs change the run's queue and rules on the rig", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    await s.relay();
    const tab = "/ui/campaigns/js-sum/runs/js-1/experiments";
    const plan = "/ui/campaigns/js-sum/runs/js-1/planner";
    const send = async (form: Record<string, string>) => {
      const r = await s.post("/ui/commands", {
        rig: "rig-a",
        run: "js-1",
        csrf: s.csrfFrom(await (await s.get(tab)).text()),
        back: tab,
        ...form,
      });
      assert.equal(r.status, 303);
      await s.relay(); // the signed command to the harness
      await s.relay(); // its events back to control
      const [cmd] = s.store.commands.list(1);
      assert.equal(cmd?.kind, form.kind);
      assert.notEqual(cmd?.status, "failed", JSON.stringify(cmd?.outcome));
    };
    await send({ kind: "queue_add", title: "unroll the loop by 4", why: "fewer branches" });
    await send({
      kind: "queue_add",
      title: "vector loads",
      family: "memory-layout",
      position: "top",
    });
    let html = await (await s.get(tab)).text();
    assert.match(html, /<span class="qn">1<\/span><div class="qmain"><div class="qt">vector loads/);
    assert.match(
      html,
      /<span class="qn">2<\/span><div class="qmain"><div class="qt">unroll the loop by 4<\/div><div class="qwhy">fewer branches/,
    );
    const idOf = (title: string) =>
      new RegExp(
        `data-id="(x-[0-9a-f]{12})"(?:(?!data-id=)[\\s\\S])*?<div class="qt">${title}<`,
      ).exec(html)?.[1] ?? "";
    const unroll = idOf("unroll the loop by 4");
    const vector = idOf("vector loads");
    assert.ok(unroll && vector);
    // Move one to the top, drop the other: the drop and its reason are in Tried.
    await send({ kind: "queue_move", id: unroll, position: "top" });
    await send({ kind: "queue_drop", id: vector, why: "measured slower last run" });
    html = await (await s.get(tab)).text();
    assert.match(
      html,
      /<span class="qn">1<\/span><div class="qmain"><div class="qt">unroll the loop by 4/,
    );
    assert.doesNotMatch(html, /<div class="qt">vector loads/);
    assert.match(html, /dropped by you: measured slower last run/);
    // Rules come from Tell the planner (goal 066): the dashboard sends no redirect of its own.
    const direct = await s.post("/ui/commands", {
      rig: "rig-a",
      run: "js-1",
      csrf: s.csrfFrom(await (await s.get(plan)).text()),
      back: plan,
      kind: "redirect",
      directive: "try",
      direction: "vector loads",
    });
    assert.equal(direct.status, 400);
    assert.equal(await direct.text(), "this command is not available from the dashboard");
    // A rule from elsewhere (the owner's REST API), naming a direction in plain words, shows on
    // the tab with its Remove, which takes it out of force.
    const viaApi = await s.control.request("/v1/commands", {
      method: "POST",
      headers: { authorization: "Bearer admin-token-abcdef", "content-type": "application/json" },
      body: JSON.stringify({
        rig: "rig-a",
        kind: "redirect",
        payload: {
          run: "js-1",
          directives: [
            {
              kind: "try",
              family: "vector loads",
              rationale: "the guide says twice the bandwidth",
            },
          ],
          replace: false,
        },
      }),
    });
    assert.equal(viaApi.status, 201, await viaApi.clone().text());
    await s.relay();
    await s.relay();
    let planner = await (await s.get(plan)).text();
    assert.match(
      planner,
      /<b>Try <span class="dtok new"><i>:<\/i>vector-loads<i>:<\/i><\/span><\/b>/,
    );
    const rule = /name="kind" value="drop_directive"[\s\S]*?name="id" value="(\d+)"/.exec(
      planner,
    )?.[1];
    assert.ok(rule, "the rule has a Remove button");
    await send({ kind: "drop_directive", id: rule });
    planner = await (await s.get(plan)).text();
    assert.doesNotMatch(planner, /<b>Try /);
    assert.match(planner, /No rules\. The planner follows the queue and its own judgment\./);
  });

  test("the Planner tab's script is served from control, and parses", async () => {
    const s = await stack();
    const r = await s.get("/ui/assets/planner.js");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /^text\/javascript/);
    const js = await r.text();
    assert.match(js, /textarea\[data-dpick\]/);
    assert.doesNotThrow(() => new Function(js));
  });

  test("a run's page: its agents before the first round; a new run of the campaign waits as Starting", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    await s.relay();
    const page = await (await s.get("/ui/campaigns/js-sum/runs/js-1")).text();
    assert.match(page, /<dt>Agents<\/dt><dd>On: they start work at the first round<\/dd>/);
    assert.match(page, /\/live\?compose=1">Message<\/a>/);
    assert.match(page, /Restart the lanes/);
    // Restart the lanes, and a change on Edit rig, each leave a line in the run's History.
    const csrf = s.csrfFrom(page);
    await s.post("/ui/commands", { csrf, rig: "rig-a", kind: "reset_workers", run: "js-1" });
    const edit = await (await s.get("/ui/rigs/rig-a/edit")).text();
    const form: Record<string, string> = { csrf: s.csrfFrom(edit), choice: "", harness: "pi" };
    for (const k of ["judge", "workers", "auditor", "teachers", "review", "exports"]) form[k] = "1";
    Object.assign(form, { lanes: "2", trial_minutes: "20", max_turns: "", promotion: "auto" });
    await s.post("/ui/rigs/rig-a/edit", form);
    await s.relay();
    await s.relay();
    const history = await (await s.get("/ui/campaigns/js-sum/runs/js-1/history")).text();
    assert.match(history, /You restarted the lanes: their trials ended/);
    assert.match(history, /You changed the rig's settings: [^<]*the planner off/);
    // Another run assigned through control: its own page (goal 170) says it is starting until
    // the rig reports it; a link to a run control never assigned finds no run.
    const payload = (s.env.assign as { envelope: { payload: Record<string, unknown> } }).envelope
      .payload;
    const r = await s.control.request("/v1/commands", {
      method: "POST",
      headers: { authorization: "Bearer admin-token-abcdef", "content-type": "application/json" },
      body: JSON.stringify({
        rig: "rig-a",
        kind: "assign_campaign",
        payload: { ...payload, run: "js-2" },
      }),
    });
    assert.equal(r.status, 201, await r.clone().text());
    const starting = await (await s.get("/ui/campaigns/js-sum/runs/js-2")).text();
    assert.match(starting, /<b>Starting js-2 on rig-a\.<\/b>/);
    assert.match(await (await s.get("/ui/campaigns/js-sum")).text(), /<h2>At work now<\/h2>/);
    const stale = await s.get("/ui/campaigns/js-sum/runs/js-9");
    assert.equal(stale.status, 404);
    assert.doesNotMatch(await stale.text(), /Starting/);
  });

  test("while a run's agents wait for the provider's limit, its page says until when, and Resume now ends the wait", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    s.env.service.ledger.appendEvent("scheduler", "agents_wait_for_limit", "js-1", {
      until,
      trial: "t-1",
      reason: "429 the usage window is full",
    });
    await s.relay();
    const href = "/ui/campaigns/js-sum/runs/js-1";
    const page = await (await s.get(href)).text();
    const end = `${until.replace("T", " ").slice(0, 16)} UTC`;
    assert.ok(
      page.includes(
        `Its agents wait for the provider's limit until ${end}: no new trial or plan starts before then. Resume now ends the wait.`,
      ),
    );
    assert.match(page, /<summary class="btn">Resume now<\/summary>/);
    assert.match(
      page,
      /name="kind" value="end_wait"><input type="hidden" name="run" value="js-1">/,
    );
    assert.ok(page.includes(`until ${end} (429 the usage window is full)`));
    const r = await s.post("/ui/commands", {
      csrf: s.csrfFrom(page),
      rig: "rig-a",
      kind: "end_wait",
      run: "js-1",
      back: href,
    });
    assert.equal(r.status, 303);
    await s.relay(); // the signed command to the harness
    await s.relay(); // its events back to control
    const [cmd] = s.store.commands.list(1);
    assert.equal(cmd?.kind, "end_wait");
    assert.notEqual(cmd?.status, "failed", JSON.stringify(cmd?.outcome));
    const after = await (await s.get(href)).text();
    assert.doesNotMatch(after, /Resume now/);
    const history = await (await s.get(`${href}/history`)).text();
    assert.ok(
      history.includes(
        `You ended the agents' wait for the provider's limit, which was to last until ${end}: new trials and plans start again.`,
      ),
    );
  });

  test("a run without agents: no Message and no Restart the lanes on its page", async () => {
    const s = await stack("owner_approval", { agents: false });
    await s.env.service.applyCommand(s.env.assign);
    await s.relay();
    const page = await (await s.get("/ui/campaigns/js-sum/runs/js-1")).text();
    assert.match(
      page,
      /<dt>Agents<\/dt><dd>None: judge only\. No workers run; changes come from people<\/dd>/,
    );
    // It says plainly that it is judge only (goal 099).
    assert.match(page, /<b>Judge only:<\/b> No workers run\./);
    assert.match(page, / · judge only · /);
    assert.match(page, /<a class="btn" href="\/ui\/campaigns\/js-sum\/runs\/js-1\/live">/);
    assert.doesNotMatch(page, />Message<\/a>/);
    assert.doesNotMatch(page, /Restart the lanes/);
    // An experiment in its queue waits for a run with workers; the queue says how to carry it.
    const tab = "/ui/campaigns/js-sum/runs/js-1/experiments";
    assert.doesNotMatch(await (await s.get(tab)).text(), /no worker takes these experiments/);
    const added = await s.post("/ui/commands", {
      rig: "rig-a",
      run: "js-1",
      csrf: s.csrfFrom(await (await s.get(tab)).text()),
      back: tab,
      kind: "queue_add",
      title: "unroll the loop by 4",
    });
    assert.equal(added.status, 303);
    await s.relay();
    await s.relay();
    assert.match(
      await (await s.get(tab)).text(),
      /<b>Judge only:<\/b> no worker takes these experiments, so they wait for a run with workers\. To carry them over, <a href="\/ui\/campaigns\/js-sum\?start=1&amp;copy=js-1">Start a run<\/a>/,
    );
    // Its Live: everyone working and the lanes are greyed out, and the box starts elsewhere.
    const live = await (await s.get("/ui/campaigns/js-sum/runs/js-1/live")).text();
    assert.match(
      live,
      /<option value="all" data-hint="[^"]*" disabled title="This run has no agents[^"]*">To everyone working<\/option>/,
    );
    assert.doesNotMatch(live, /<option value="all"[^>]* selected/);
  });
});
