import assert from "node:assert/strict";
import { test } from "node:test";
import {
  campaignFilter,
  campaignKind,
  campaignsListBody,
  isRigCheck,
} from "../../../../src/control/ui/campaigns/list.ts";
import type { CampaignView, RunView } from "../../../../src/control/views/index.ts";
import { rig, statusRun } from "./fixtures.ts";

/**
 * The Campaigns list: what it shows by default and under each filter, and how it counts the
 * campaigns it hides.
 */

const run = (id: string, status: string, campaign: string): RunView =>
  ({
    id,
    campaign,
    status,
    mode: "hill_climb",
    attempts: [],
    timeline: [],
    created_at: "2026-10-20T00:00:00Z",
    champion: [],
    goals: [],
    research: null,
  }) as unknown as RunView;

const camp = (name: string, ...statuses: string[]): CampaignView => ({
  name,
  mode: "hill_climb",
  runs: statuses.map((s, i) => ({ rig, run: run(`${name}-${i + 1}`, s, name) })),
});

test("the Campaigns list hides rig checks and finished campaigns unless asked", () => {
  const camps = [
    camp("speed", "running", "paused"),
    camp("old", "closed"),
    camp("rig-check-smoke-cpu-1a2b3c4d", "closed", "closed"),
  ];
  assert.equal(isRigCheck("rig-check-smoke-cpu-1a2b3c4d"), true);
  assert.equal(campaignKind(camps[0] as CampaignView), "active");
  assert.equal(campaignKind(camps[1] as CampaignView), "finished");
  assert.equal(campaignKind(camps[2] as CampaignView), "check");
  const body = (f: string, q = "") =>
    campaignsListBody({
      camps,
      atWork: [],
      waiting: [],
      filter: campaignFilter(f),
      query: q,
      now: Date.parse("2026-10-20T01:00:00Z"),
      best: () => "+1.0% gain",
      about: (k) => (k.name === "speed" ? "Make it faster" : ""),
    });
  const dflt = body("");
  assert.match(dflt, /<b>speed<\/b>/);
  assert.doesNotMatch(dflt, /<b>old<\/b>/);
  assert.doesNotMatch(dflt, /<b>rig-check-smoke/);
  assert.match(dflt, /Show the 1 rig check/);
  assert.match(dflt, /Make it faster/);
  assert.match(body("check"), /<b>rig-check-smoke-cpu-1a2b3c4d<\/b>/);
  assert.match(body("check"), /rig check/);
  assert.match(body("all"), /<b>old<\/b>/);
  // Search matches names, descriptions, runs and rigs.
  assert.match(body("all", "faster"), /<b>speed<\/b>/);
  assert.doesNotMatch(body("all", "faster"), /<b>old<\/b>/);
  assert.match(body("all", "nothing-like-this"), /No campaign matches/);
  // An unknown filter is the default one.
  assert.equal(campaignFilter("bogus"), "default");
});

test("the Campaigns list hides a campaign whose newest run completed, and counts it apart (goal 099)", () => {
  const camps: CampaignView[] = [
    {
      name: "quality",
      mode: "goal",
      runs: [
        { rig, run: statusRun("q-1", "paused", "2026-10-20T00:00:00Z") },
        {
          rig,
          run: statusRun("q-2", "closed", "2026-10-21T00:00:00Z", { goals_complete: true }),
        },
        { rig, run: statusRun("q-3", "closed", "2026-10-19T00:00:00Z") },
      ],
    },
  ];
  const body = (f: string) =>
    campaignsListBody({
      camps,
      atWork: [],
      waiting: [],
      filter: campaignFilter(f),
      query: "",
      now: Date.parse("2026-10-22T00:00:00Z"),
      best: () => "2/2 goals met",
      about: () => "",
    });
  assert.doesNotMatch(body(""), /<b>quality<\/b>/);
  assert.doesNotMatch(body("paused"), /<b>quality<\/b>/);
  assert.match(
    body("all"),
    /<span class="kdot pause">1 paused<\/span><span class="kdot ok">1 completed<\/span><span class="kdot done">1 finished<\/span>/,
  );
});
