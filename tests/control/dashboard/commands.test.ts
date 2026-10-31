import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FAST_KERNEL } from "../../helpers/judge-env.ts";
import { stack } from "./stack.ts";

/**
 * Commands from the dashboard: a confirmed win approved from its card and a run paused, each
 * signed and carried to the harness.
 */

describe("control dashboard", () => {
  test("a confirmed win waits for approval, shows on the dashboard and is promoted from it", async () => {
    const s = await stack("owner_approval");
    await s.env.service.applyCommand(s.env.assign);
    const id = (
      await s.env.service.submitAttempt(
        {
          run: "js-1",
          patch_base64: s.env.patch(FAST_KERNEL),
          hypothesis: "drop the waste",
          known_flaws: [],
        },
        "proposer",
      )
    ).attempt;
    await s.env.drain();
    await s.relay();
    const home = await (await s.get("/ui")).text();
    const judged = s.env.explain(id);
    assert.ok(home.includes("Make this change the new champion?"), judged);
    assert.ok(home.includes(id), judged);
    // The decision says, in plain words, what it is about, what the judge found, why it waits and
    // what each choice does.
    assert.match(home, /drop the waste/);
    assert.match(
      home,
      /The judge measured the change again on new runs: \+\d+\.\d% compared with the champion\./,
    );
    assert.match(home, /It waits for you because you asked to decide every change/);
    assert.match(home, /The change becomes <b>champion #2<\/b>/);
    assert.match(home, /The champion is the version of the project that the agents start from/);
    // A form without the session's token is refused.
    const forged = await s.post("/ui/commands", {
      rig: "rig-a",
      kind: "approve_promotion",
      run: "js-1",
      attempt: id,
      csrf: "0".repeat(64),
    });
    assert.equal(forged.status, 403);
    const ok = await s.post("/ui/commands", {
      rig: "rig-a",
      kind: "approve_promotion",
      run: "js-1",
      attempt: id,
      csrf: s.csrfFrom(home),
    });
    assert.equal(ok.status, 303);
    // The page says the command went, and the decision shows as sent, without its buttons.
    const back = String(ok.headers.get("location"));
    assert.match(back, /sent=Sent%20to%20rig-a%20at%20\d\d%3A\d\d%20UTC\./);
    const sent = await (await s.get(back)).text();
    assert.match(sent, /<b class="ok">Sent to rig-a at \d\d:\d\d UTC\.<\/b>/);
    // The decision leaves Needs you at once, before the rig has done it; the change's own page
    // still says what was chosen.
    const home2 = await (await s.get("/ui")).text();
    assert.doesNotMatch(home2, /Make this change the new champion\?/);
    assert.doesNotMatch(home2, /name="kind" value="approve_promotion"/);
    assert.doesNotMatch(home2, /class="item warn" href="\/ui">[^<]*<\/svg>Needs you/);
    const own = await (
      await s.get(`/ui/campaigns/js-sum/runs/js-1/attempts/${encodeURIComponent(id)}`)
    ).text();
    assert.match(
      own,
      /You selected <b>Make it the champion<\/b> [^<]* ago\. Control sent it to the rig\./,
    );
    await s.relay(); // delivers the signed command to the harness
    assert.equal(s.env.ledger.champions.current("js-1").seq, 2);
    await s.relay(); // reports the promotion back
    // Campaigns first: the run's chart and attempts are on its campaign's page, linked from the rig.
    const rig = await (await s.get("/ui/rigs/rig-a")).text();
    assert.match(rig, /href="\/ui\/campaigns\/js-sum\/runs\/js-1"/);
    const campaign = await (await s.get("/ui/campaigns/js-sum/runs/js-1")).text();
    assert.match(campaign, /<svg class="chart"/);
    assert.match(campaign, /drop the waste/);
    assert.match(campaign, /id="run-js-1"/);
    // One run's views: its attempts, and its steering.
    const all = await (await s.get("/ui/campaigns/js-sum/runs/js-1/attempts")).text();
    assert.match(all, /drop the waste/);
    assert.doesNotMatch(all, /<svg class="chart"/);
    // The rules for the plan are on the run's Planner tab; a tab by an old name is no address.
    assert.match(
      await (await s.get("/ui/campaigns/js-sum/runs/js-1/planner")).text(),
      /<h2>Rules<\/h2>/,
    );
    assert.equal((await s.get("/ui/campaigns/js-sum/runs/js-1/steering")).status, 404);
    assert.match(await (await s.get("/ui/campaigns")).text(), /js-sum/);
    const after = await (await s.get("/ui")).text();
    assert.doesNotMatch(after, /Make this change the new champion\?/);
    assert.match(after, /became champion #2/);
    const audit = await (await s.get("/ui/audit")).text();
    assert.match(audit, /command_issued/);
  });

  test("pause from the dashboard reaches the harness", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    await s.relay();
    const page = await (await s.get("/ui/rigs/rig-a")).text();
    const r = await s.post("/ui/commands", {
      rig: "rig-a",
      kind: "pause_run",
      run: "js-1",
      reason: "owner looked",
      csrf: s.csrfFrom(page),
    });
    assert.equal(r.status, 303);
    await s.relay();
    assert.equal(s.env.ledger.runs.get("js-1")?.status, "paused");
  });
});
