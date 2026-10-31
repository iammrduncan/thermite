import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { elapsedWords, type Progress } from "../../../src/control/command-progress.ts";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { FOLLOW_CORE_JS, FOLLOW_JS } from "../../../src/control/ui/commands/client.ts";
import type { RigCheckReport } from "../../../src/harness/agents/model/check.ts";
import { ModelSource } from "../../../src/harness/agents/model/source.ts";
import { controlStack, signIn } from "../../helpers/control-stack.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * A click on a button that sends something to a rig says at once that it took, and the page
 * follows it to its outcome with no refresh (goal 080): Run it on a rig's checks, every signed
 * command's button, a message, Use on Providers and Start a run. Control here has one rig whose
 * harness is real; the supervisor's relay is called by hand, so each step can be looked at.
 */

type Answer = Progress & { follow?: string };

async function stack() {
  const { env, store, control, relay } = controlStack({
    env: makeJudgeEnv({ promotion: "owner_approval" }),
  });
  const session = await signIn(control);
  const { cookie, page } = session;
  await env.service.applyCommand(env.assign);
  await relay();
  const csrf = session.csrfOf(await page("/ui/rigs/rig-a"));
  /** A form as a browser posts it without the page's script: the answer is a page to load. */
  const post = (path: string, form: Record<string, string>) =>
    session.post(path, { csrf, ...form });
  /** A form as the page's script sends it: with fetch, asking for JSON. */
  const send = async (path: string, form: Record<string, string>) => {
    const r = await control.request(path, {
      method: "POST",
      body: new URLSearchParams({ csrf, ...form }),
      headers: {
        cookie,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    return { status: r.status, text: await r.text() };
  };
  /** What a follow route answers now. */
  const follow = async (url: string) => JSON.parse(await page(url)) as Answer;
  return { env, store, relay, page, post, send, follow, csrf };
}

/** The page script's parts that touch no page, exactly as the browser runs them. */
const core = new Function(
  `${FOLLOW_CORE_JS}; return { fwElapsed, fwStep, fwDelay, fwAnswer };`,
)() as {
  fwElapsed: (ms: number) => string;
  fwStep: (
    prev: Answer | null,
    a: Answer,
  ) => {
    redraw: boolean;
    stop: boolean;
    reload: boolean;
    say: string;
    tone: string;
    button: string;
  };
  fwDelay: (ms: number) => number;
  fwAnswer: (status: number, text: string, signedOut: boolean) => Answer;
};

/** A check that runs until the test ends it. */
function heldCheck() {
  let end: (r: RigCheckReport) => void = () => {};
  const check = {
    run: () =>
      new Promise<RigCheckReport>((r) => {
        end = r;
      }),
  };
  return { check, end: (r: RigCheckReport) => end(r) };
}

/** The row of one check on the rig's page. */
const rowOf = (html: string, check: string) =>
  new RegExp(`<div class="ck" data-check="${check}"[^>]*>[\\s\\S]*?</form></div>`).exec(
    html,
  )?.[0] ?? "";

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("Run it on a rig's checks (goal 080)", () => {
  test("sent, running with its time, then the result in place; each state as the page follows it", async () => {
    const s = await stack();
    const smoke = heldCheck();
    s.env.service.rigChecks.smoke = smoke.check;
    const url = "/ui/rigs/rig-a/checks/smoke.json";
    // Before: not run yet, and nothing to follow.
    let row = rowOf(await s.page("/ui/rigs/rig-a"), "smoke");
    assert.match(row, /<span class="chip">not run yet<\/span>/);
    assert.doesNotMatch(row, /data-follow/);
    assert.match(row, /<button class="">Run it<\/button>/);

    // The click: control queues the command and answers the script at once.
    const sent = await s.send("/ui/commands", { rig: "rig-a", kind: "rig_check", check: "smoke" });
    assert.equal(sent.status, 200);
    const a1 = JSON.parse(sent.text) as Answer;
    assert.deepEqual(a1, { state: "sent", final: false, said: "", tone: "", follow: url });
    row = rowOf(await s.page("/ui/rigs/rig-a"), "smoke");
    assert.match(
      row,
      new RegExp(`data-follow="${url.replace(/\./g, "\\.")}" data-follow-state="sent"`),
    );
    assert.match(row, /<span class="chip info">sent<\/span>/);
    assert.match(
      row,
      /<span class="ck-sum" data-state="sent">Sent to the rig at \d\d:\d\d UTC\. It starts when the rig takes it\.<\/span>/,
    );
    assert.match(row, /<button class="" disabled>Sent<\/button>/);
    assert.deepEqual(await s.follow(url), { state: "sent", final: false, said: "", tone: "" });

    // The rig takes it: its answer names the check it started. Running, with the time so far.
    await s.relay();
    const a2 = await s.follow(url);
    assert.deepEqual([a2.final, a2.said, a2.tone], [false, "", ""]);
    assert.match(a2.state, /^running:\d+$/);
    row = rowOf(await s.page("/ui/rigs/rig-a"), "smoke");
    assert.match(
      row,
      /<span class="chip info">running · <span data-since="[^"]+">\d+ s<\/span><\/span>/,
    );
    assert.match(row, /Its running runs are paused for it, and resumed after\./);
    assert.match(row, /<button class="" disabled>Running…<\/button>/);
    assert.match(row, /data-follow-state="running"/);
    // Its rig_check_started event came with the report that carried the command's outcome: the
    // next report changes nothing while the check runs.
    await s.relay();
    const a2b = await s.follow(url);
    assert.equal(a2b.state, a2.state);
    assert.equal(a2b.final, false);

    // The result reaches control: the row shows it in place, and the follow ends.
    smoke.end({
      ok: true,
      summary: "smoke on smoke-cpu: all 12 candidates were judged as expected",
    });
    await tick();
    await s.relay();
    const a3 = await s.follow(url);
    assert.deepEqual(a3, { state: "passed", final: true, said: "", tone: "" });
    row = rowOf(await s.page("/ui/rigs/rig-a"), "smoke");
    assert.match(
      row,
      /<span class="chip ok">passed<\/span><\/span><span class="ck-main"><span><b>Judge smoke<\/b> <span class="muted small">\d+s ago<\/span><\/span><span class="ck-sum ">smoke on smoke-cpu: all 12 candidates were judged as expected<\/span>/,
    );
    assert.match(row, /<button class="">Run it<\/button>/);
    assert.doesNotMatch(row, /data-follow/);

    // The page's script does with these answers what the row needs: draws it again on each new
    // state, waits on a repeat, and stops at the result, giving the button back.
    const steps = [a1, a1, a2, a2, a2b, a3].map((a, i, all) =>
      core.fwStep(i ? (all[i - 1] ?? null) : null, a),
    );
    assert.deepEqual(
      steps.map((x) => [x.redraw, x.stop, x.button]),
      [
        [true, false, "Sent"],
        [false, false, "Sent"],
        [true, false, "Sent"],
        [false, false, "Sent"],
        [false, false, "Sent"],
        [true, true, "back"],
      ],
    );
    assert.equal(core.fwAnswer(200, sent.text, false).follow, url);
  });

  test("a check the rig refuses says why, and its button comes back", async () => {
    const s = await stack();
    s.env.service.rigChecks.isolation = {
      notNow: () => "1 open trial(s): pause the rig's runs first",
      run: async () => ({ ok: true, summary: "unused" }),
    };
    // Without the page's script: the form posts, and the page it lands on says Sent.
    const r = await s.post("/ui/commands", {
      rig: "rig-a",
      kind: "rig_check",
      check: "isolation",
      back: "/ui/rigs/rig-a",
    });
    assert.equal(r.status, 303);
    const to = String(r.headers.get("location"));
    assert.match(
      decodeURIComponent(to),
      /^\/ui\/rigs\/rig-a\?sent=Sent to rig-a at \d\d:\d\d UTC\.$/,
    );
    const landed = await s.page(to);
    assert.match(landed, /<b class="ok">Sent to rig-a at \d\d:\d\d UTC\.<\/b>/);
    assert.match(rowOf(landed, "isolation"), /<span class="chip info">sent<\/span>/);
    await s.relay();
    const url = "/ui/rigs/rig-a/checks/isolation.json";
    assert.deepEqual(await s.follow(url), { state: "refused", final: true, said: "", tone: "" });
    const row = rowOf(await s.page("/ui/rigs/rig-a"), "isolation");
    assert.match(row, /<span class="chip">not run yet<\/span>/);
    assert.match(
      row,
      /<span class="ck-sum bad" data-state="refused">Not run: the rig refused it at \d\d:\d\d UTC\. Not now: 1 open trial\(s\): pause the rig's runs first\.<\/span>/,
    );
    assert.match(row, /<button class="">Run it<\/button>/);
  });

  test("a check the rig never takes expires, and says so", async () => {
    const s = await stack();
    issueCommand(s.store, s.env.keys.privateKeyPem, {
      rig: "rig-a",
      kind: "rig_check",
      payload: { check: "model" },
      ttlMinutes: -1,
      issuedBy: "owner:ui",
    });
    const url = "/ui/rigs/rig-a/checks/model.json";
    assert.deepEqual(await s.follow(url), { state: "expired", final: true, said: "", tone: "" });
    const row = rowOf(await s.page("/ui/rigs/rig-a"), "model");
    assert.match(
      row,
      /<span class="ck-sum bad" data-state="expired">Not run: the rig did not take it before \d\d:\d\d UTC\.<\/span>/,
    );
    assert.match(row, /<button class="">Run it<\/button>/);
    // The rig's next fetch marks it expired: still the same words.
    await s.relay();
    assert.equal((await s.follow(url)).state, "expired");
  });

  test("Check on Providers: sent, then running with its time, in the rig's row", async () => {
    const s = await stack();
    const model = heldCheck();
    s.env.service.rigChecks.model = model.check;
    const a = JSON.parse(
      (await s.send("/ui/commands", { rig: "rig-a", kind: "rig_check", check: "model" })).text,
    ) as Answer;
    assert.equal(a.follow, "/ui/rigs/rig-a/checks/model.json");
    let settings = await s.page("/ui/settings");
    assert.match(
      settings,
      /Its model check was sent to the rig at \d\d:\d\d UTC\. It starts when the rig takes it\./,
    );
    assert.match(
      settings,
      /data-follow="\/ui\/rigs\/rig-a\/checks\/model\.json" data-follow-state="sent"/,
    );
    assert.match(settings, /<button class="" disabled>Check<\/button>/);
    await s.relay();
    settings = await s.page("/ui/settings");
    assert.match(settings, /Its model check is running · <span data-since="[^"]+">\d+ s<\/span>\./);
    model.end({ ok: true, summary: "m answered with a correct tool call in 1.2 s" });
    await tick();
    await s.relay();
    settings = await s.page("/ui/settings");
    assert.match(settings, /Its model check passed \d+s ago: m answered with a correct tool call/);
    assert.match(settings, /<button class="">Check<\/button>/);
  });
});

describe("every button that sends a command (goal 080)", () => {
  test("Pause: sent, then done once the rig's report came with its outcome; each in words", async () => {
    const s = await stack();
    const sent = await s.send("/ui/commands", {
      rig: "rig-a",
      kind: "pause_run",
      run: "js-1",
      reason: "seen enough",
    });
    const a = JSON.parse(sent.text) as Answer;
    assert.equal(a.state, "sent");
    assert.match(a.said, /^Sent to rig-a at \d\d:\d\d UTC\. Waiting for the rig to take it\.$/);
    assert.match(a.follow ?? "", /^\/ui\/commands\/[0-9a-f-]+\.json$/);
    const url = a.follow ?? "";
    await s.relay();
    assert.equal(s.env.ledger.runs.get("js-1")?.status, "paused");
    const done = await s.follow(url);
    assert.deepEqual([done.state, done.final, done.tone], ["done", true, "ok"]);
    assert.match(done.said, /^Done\. rig-a took it at \d\d:\d\d UTC\.$/);
    // The page's parts drawn again now show it: the rig's runs say paused.
    const runs =
      /data-part="runs">([\s\S]*?)<div class="block" data-part="jobs">/.exec(
        await s.page("/ui/rigs/rig-a"),
      )?.[1] ?? "";
    assert.match(runs, /js-1/);
    assert.match(runs, /[Pp]aused/);
    // The script's steps for them: words each time, the button back at the end, no reload.
    const st = core.fwStep({ state: a.state, final: a.final, said: a.said, tone: a.tone }, done);
    assert.deepEqual([st.redraw, st.stop, st.reload, st.tone], [true, true, false, "ok"]);
  });

  test("control's refusal comes back in words to the script, and as before to a plain form", async () => {
    const s = await stack();
    const r = await s.send("/ui/commands", { rig: "no-such-rig", kind: "export_now" });
    assert.equal(r.status, 400);
    assert.deepEqual(JSON.parse(r.text), {
      state: "refused",
      final: true,
      tone: "bad",
      said: "Not sent: Unknown rig no-such-rig.",
    });
    assert.deepEqual(core.fwAnswer(400, r.text, false), JSON.parse(r.text));
    const plain = await s.post("/ui/commands", { rig: "no-such-rig", kind: "export_now" });
    assert.equal(plain.status, 400);
    assert.equal(await plain.text(), "refused: unknown rig no-such-rig");
    assert.deepEqual(core.fwAnswer(400, "refused: unknown rig no-such-rig", false), {
      state: "refused",
      final: true,
      tone: "bad",
      said: "Not sent: Unknown rig no-such-rig",
    });
    // A form token from an old page, and a session that ended, in words too.
    const forged = await s.send("/ui/commands", {
      csrf: "0".repeat(64),
      rig: "rig-a",
      kind: "export_now",
    });
    assert.equal(forged.status, 403);
    assert.match(
      core.fwAnswer(forged.status, forged.text, false).said,
      /^Not sent: This page is too old\. Load it again/,
    );
    assert.match(core.fwAnswer(200, "<html>", true).said, /^Not sent: your session ended\./);
  });

  test("a message to the run's agents: followed until the rig took it; one with no words is refused", async () => {
    const s = await stack();
    const empty = await s.send("/ui/campaigns/js-sum/runs/js-1/message", {
      to: "all",
      text: " ",
    });
    assert.equal(empty.status, 400);
    assert.equal((JSON.parse(empty.text) as Answer).said, "Not sent: Write a message first.");
    const sent = JSON.parse(
      (
        await s.send("/ui/campaigns/js-sum/runs/js-1/message", {
          to: "all",
          text: "try loop tiling",
        })
      ).text,
    ) as Answer;
    assert.equal(sent.state, "sent");
    await s.relay();
    await s.relay();
    assert.equal((await s.follow(sent.follow ?? "")).state, "done");
    // Live's composer and the Planner tab's form are sent by the script.
    assert.match(
      await s.page("/ui/campaigns/js-sum/runs/js-1/live"),
      /<form class="lcomposer" method="post" action="\/ui\/campaigns\/js-sum\/runs\/js-1\/message" data-act>/,
    );
  });

  test("Start a run: the Starting card follows the run's command, and opens the run once it reports", async () => {
    const s = await stack();
    const assign = s.env.assign.envelope.payload as Record<string, unknown>;
    const { id } = issueCommand(s.store, s.env.keys.privateKeyPem, {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: { ...assign, run: "js-2" },
      issuedBy: "owner:ui",
    });
    const campaign = String((assign.contract as { campaign: string }).campaign);
    // The new run's own page (goal 170), which waits as Starting until the rig reports the run.
    const at = `/ui/campaigns/${campaign}/runs/js-2`;
    let html = await s.page(at);
    assert.match(
      html,
      new RegExp(
        `<div class="card" style="margin-bottom:16px" data-part="starting" data-follow="/ui/commands/${id}\\.json" data-follow-state="sent"><b>Starting js-2 on rig-a\\.</b> <span class="">Sent to rig-a at \\d\\d:\\d\\d UTC\\. Waiting for the rig to take it\\.</span>`,
      ),
    );
    await s.relay();
    const done = await s.follow(`/ui/commands/${id}.json`);
    assert.deepEqual([done.state, done.final, done.reload], ["done", true, true]);
    assert.ok(core.fwStep(null, done).reload, "the page loads again: the run's own page");
    html = await s.page(at);
    assert.match(html, /id="run-js-2"/);
    assert.doesNotMatch(html, /data-part="starting"/);
  });

  test("Save changes on Edit rig: the rig's page follows the settings' command in its green line", async () => {
    const s = await stack();
    const form: Record<string, string> = { choice: "", harness: "pi" };
    for (const k of ["judge", "workers", "auditor", "teachers", "review", "exports"]) form[k] = "1";
    Object.assign(form, { lanes: "2", trial_minutes: "20", max_turns: "", promotion: "auto" });
    const r = await s.post("/ui/rigs/rig-a/edit", form);
    const to = String(r.headers.get("location"));
    const id = /&cmd=([0-9a-f-]+)$/.exec(to)?.[1] ?? "";
    assert.ok(id, to);
    let page = await s.page(to);
    assert.match(
      page,
      new RegExp(
        `<div class="card" style="margin-bottom:16px" data-follow="/ui/commands/${id}\\.json" data-follow-state="sent" data-say><b class="ok">Control sent \\d settings to rig-a\\. The rig takes the change in less than one minute\\.</b> <span class="" data-say>Sent to rig-a at \\d\\d:\\d\\d UTC\\. Waiting for the rig to take it\\.</span></div>`,
      ),
    );
    await s.relay();
    await s.relay();
    assert.equal((await s.follow(`/ui/commands/${id}.json`)).state, "done");
    // Once done, the same address says so, and follows nothing.
    page = await s.page(to);
    assert.match(page, /<span class="ok" data-say>Done\. rig-a took it at \d\d:\d\d UTC\.<\/span>/);
    assert.doesNotMatch(page, /data-follow="\/ui\/commands\//);
    assert.match(await s.page("/ui/rigs/rig-a/edit"), /<form id="edit-rig" method="post"/);
  });

  test("Use on Providers: the row follows the rig as it takes the model", async () => {
    const s = await stack();
    // The rig reports that its agents have no model yet.
    const dir = mkdtempSync(join(tmpdir(), "thermite-follow-route-"));
    s.env.service.models = new ModelSource(join(dir, "model-route.json"), undefined);
    await s.relay();
    s.store.modelProviders.put({
      name: "lab",
      type: "openai",
      base_url: "https://models.example.com/v1",
      key: { sealed: SecretBox.ephemeral().seal("not-a-key"), hint: "…-key" },
    });
    s.store.modelProviders.setModels("lab", [{ id: "m" }]);
    const a = JSON.parse(
      (await s.send("/ui/settings/rigs", { rig: "rig-a", choice: "lab|m", harness: "pi" })).text,
    ) as Answer;
    assert.deepEqual([a.state, a.final, a.tone], ["taking", false, "ok"]);
    assert.equal(a.follow, "/ui/rigs/rig-a/model.json");
    assert.match(a.said, /rig-a takes m from "lab" under Pi within a minute, and checks it/);
    assert.match(
      await s.page("/ui/settings"),
      /data-follow="\/ui\/rigs\/rig-a\/model\.json" data-follow-state="taking"/,
    );
    const r = await s.send("/ui/settings/rigs", { rig: "no-such-rig", choice: "lab|m" });
    assert.equal(r.status, 400);
    assert.equal((JSON.parse(r.text) as Answer).said, "Not sent: No such rig.");
  });
});

describe("the page's script (goal 080)", () => {
  test("its times count as the server writes them, and it waits longer after two minutes", () => {
    for (const ms of [0, 999, 1000, 59_999, 60_000, 72_500, 3_599_999, 3_600_000, 7_530_000])
      assert.equal(core.fwElapsed(ms), elapsedWords(ms), String(ms));
    assert.equal(elapsedWords(72_500), "1 m 12 s");
    assert.equal(core.fwDelay(1000), 2000);
    assert.equal(core.fwDelay(130_000), 5000);
  });

  test("it is served with the dashboard's script, and every page still posts its forms without it", async () => {
    assert.doesNotThrow(() => new Function(FOLLOW_JS));
    const s = await stack();
    const app = await s.page("/ui/assets/app.js");
    assert.ok(app.includes("fw:follow") && app.includes("const fwStep"));
    const rig = await s.page("/ui/rigs/rig-a");
    assert.match(rig, /<script src="\/ui\/assets\/app\.js" defer><\/script>/);
    // Run it is a plain form that posts to control: a browser without the script sends it too.
    assert.match(
      rowOf(rig, "smoke"),
      /<form class="inline" method="post" action="\/ui\/commands"><input type="hidden" name="csrf" value="[0-9a-f]+"><input type="hidden" name="rig" value="rig-a"><input type="hidden" name="kind" value="rig_check"><input type="hidden" name="check" value="smoke">/,
    );
    // The parts the script draws again are marked.
    for (const part of ["said", "banners", "checks", "runs", "jobs", "rig"])
      assert.match(rig, new RegExp(`data-part="${part}"`), part);
  });
});
