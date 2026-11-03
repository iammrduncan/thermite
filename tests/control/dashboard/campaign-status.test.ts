import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 099 on control's side, from a rig's events: a goal run that met its goals reads Completed,
 * and its campaign reads as its newest run, over an older paused one; a judge-only run says so on
 * its page and over its queue.
 */

async function control() {
  const { store, control, api } = controlOnly({ tokens: { rigs: { "rig-a": "t-a-abcdef" } } });
  const { page } = await signIn(control);
  const rest = async (path: string) => (await api("GET", path)).json();
  let id = 0;
  // Each event a minute after the one before, so the runs' starts have an order.
  const t0 = Date.now() - 24 * 3600_000;
  const ingest = async (
    events: { kind: string; subject: string; body: Record<string, unknown> }[],
  ) => {
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: id,
      next: id + events.length,
      events: events.map((e) => ({
        id: ++id,
        at: new Date(t0 + id * 60_000).toISOString(),
        actor: "harness",
        ...e,
      })),
      summary: {},
    });
  };
  return { page, rest, ingest };
}

const created = (run: string, campaign: string, more: Record<string, unknown> = {}) => ({
  kind: "run_created",
  subject: run,
  body: {
    campaign,
    version: 1,
    mode: "goal",
    seed: { repo: "proj", commit: "a".repeat(40) },
    ...more,
  },
});
const status = (run: string, s: string, reason: string | null = null) => ({
  kind: "run_status",
  subject: run,
  body: { status: s, reason },
});
/** A goal report on champion 2 with both goals met: the first check, or the confirming one. */
const report = (run: string, o: { complete: boolean; confirming?: boolean }) => ({
  kind: "goal_report",
  subject: run,
  body: {
    run,
    champion_seq: 2,
    goals: [
      { goal: "quality", status: o.complete ? "met" : "unmet", reasons: "checked" },
      { goal: "fast", status: "met", reasons: "checked" },
    ],
    complete: o.complete,
    ...(o.confirming ? { confirming: true } : {}),
  },
});

/** The left navigation's row of a campaign, and its word. */
const navWord = (html: string, campaign: string) =>
  new RegExp(
    `data-campaign="${campaign}"[^>]*>[\\s\\S]*?<span class="right label ([a-z]+)">([A-Za-z]+)</span>`,
  )
    .exec(html)
    ?.slice(1, 3);

describe("status words of runs and campaigns, and judge-only runs (goal 099)", () => {
  test("a goal run that met its goals reads Completed; its campaign too, over an older paused run", async () => {
    const c = await control();
    await c.ingest([
      created("q-1", "quality"),
      status("q-1", "running"),
      status("q-1", "paused", "replaced by q-2"),
      created("q-2", "quality"),
      status("q-2", "running"),
      report("q-2", { complete: true, confirming: true }),
      report("q-2", { complete: true }),
      { kind: "goal_complete", subject: "q-2", body: { champion_seq: 2 } },
      status("q-2", "closed", "every required goal is met"),
      // Another campaign: a goal run the owner closed with its goals unmet, and one closed while
      // the judge still had to confirm its champion.
      created("o-1", "other"),
      status("o-1", "running"),
      report("o-1", { complete: false }),
      status("o-1", "closed", "the owner closed it"),
      created("w-1", "waiting"),
      status("w-1", "running"),
      report("w-1", { complete: true, confirming: true }),
      status("w-1", "closed", "the owner closed it"),
    ]);
    const list = await c.page("/ui/campaigns?f=all");
    assert.deepEqual(navWord(list, "quality"), ["ok", "Completed"]);
    assert.deepEqual(navWord(list, "other"), ["muted", "Finished"]);
    assert.deepEqual(navWord(list, "waiting"), ["muted", "Finished"]);
    // The list counts the completed run apart; the default filter leaves the campaign out.
    assert.match(
      list,
      /<b>quality<\/b>[\s\S]*?<span class="kdot pause">1 paused<\/span><span class="kdot ok">1 completed<\/span>/,
    );
    assert.doesNotMatch(await c.page("/ui/campaigns"), /<b>quality<\/b>/);
    // The run's page, and Earlier runs on the campaign's page.
    assert.match(
      await c.page("/ui/campaigns/quality/runs/q-2"),
      /· goal · <span class="label ok"><svg[^>]*>[\s\S]*?<\/svg>Completed<\/span>/,
    );
    assert.match(
      await c.page("/ui/campaigns/other/runs/o-1"),
      /· goal · <span class="label muted"><svg[^>]*>[\s\S]*?<\/svg>Finished<\/span>/,
    );
    const camp = await c.page("/ui/campaigns/quality");
    assert.match(camp, /<span class="kst ok">Completed<\/span><\/td><td><a [^>]*><b>q-2<\/b>/);
    assert.match(camp, /<span class="kst pause">Paused<\/span><\/td><td><a [^>]*><b>q-1<\/b>/);
    // REST gives it as goals_complete.
    const view = (await c.rest("/v1/rigs/rig-a/view")) as {
      runs: { id: string; goals_complete: boolean }[];
    };
    assert.deepEqual(view.runs.map((r) => [r.id, r.goals_complete]).sort(), [
      ["o-1", false],
      ["q-1", false],
      ["q-2", true],
      ["w-1", false],
    ]);
    // A newer paused run makes the campaign Paused again, and lists it under Active and paused.
    await c.ingest([
      created("q-3", "quality"),
      status("q-3", "running"),
      status("q-3", "paused", "x"),
    ]);
    assert.deepEqual(navWord(await c.page("/ui/campaigns"), "quality"), ["muted", "Paused"]);
    assert.match(await c.page("/ui/campaigns"), /<b>quality<\/b>/);
  });

  test("a judge-only run says so on its page, and its queue says how to carry the experiments", async () => {
    const c = await control();
    await c.ingest([
      created("j-1", "quality", { agents: false }),
      status("j-1", "running"),
      {
        kind: "experiment_added",
        subject: "j-1",
        body: { id: "x-000000000001", title: "tile the loop", by: "teacher" },
      },
    ]);
    const run = await c.page("/ui/campaigns/quality/runs/j-1");
    assert.match(
      run,
      /<b>Judge only:<\/b> No workers run\. The judge checks the champion; the advisors' ideas wait in the queue for a run with workers\./,
    );
    assert.match(run, /· goal · judge only · <span class="label info">/);
    assert.match(
      run,
      /<dt>Agents<\/dt><dd>None: judge only\. No workers run; changes come from people<\/dd>/,
    );
    const exp = await c.page("/ui/campaigns/quality/runs/j-1/experiments");
    assert.match(
      exp,
      /<b>Judge only:<\/b> no worker takes these experiments, so they wait for a run with workers\. To carry them over, <a href="\/ui\/campaigns\/quality\?start=1&amp;copy=j-1">Start a run<\/a> of the campaign with <b>Copy the untried experiments of<\/b> j-1 ticked\./,
    );
    // The at-work card marks it too.
    assert.match(
      await c.page("/ui/campaigns"),
      /quality › j-1<\/a> <span class="chip" title="[^"]*">judge only<\/span>/,
    );

    // A run with workers says none of it.
    await c.ingest([created("w-1", "with-workers"), status("w-1", "running")]);
    await c.ingest([
      {
        kind: "experiment_added",
        subject: "w-1",
        body: { id: "x-000000000002", title: "unroll", by: "teacher" },
      },
    ]);
    assert.doesNotMatch(await c.page("/ui/campaigns/with-workers/runs/w-1"), /judge only/i);
    assert.doesNotMatch(
      await c.page("/ui/campaigns/with-workers/runs/w-1/experiments"),
      /Judge only/,
    );
  });
});
