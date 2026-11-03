import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attemptHref,
  campaignHref,
  championPatchHref,
  knowledgeHref,
  knowledgeParts,
  liveHref,
  paperHref,
  RUN_ROUTES,
  RUN_TABS,
  rigHref,
  rigLiveStreamHref,
  runHref,
  runLiveHref,
  runLiveStreamHref,
  runMessageHref,
  runTab,
} from "../../../src/control/ui/urls.ts";

/**
 * The dashboard's addresses (goal 170): a run hangs from its campaign, and what it owns from it;
 * the rig a run ran on is no part of them. Each link is the path of the route that answers it.
 */

const run = { id: "sort-speed-3", campaign: "sort-speed" };

test("a run's links hang from its campaign, and an attempt's from its run", () => {
  assert.equal(campaignHref("sort speed"), "/ui/campaigns/sort%20speed");
  assert.equal(runHref(run), "/ui/campaigns/sort-speed/runs/sort-speed-3");
  assert.equal(runHref(run, "overview"), "/ui/campaigns/sort-speed/runs/sort-speed-3");
  assert.equal(runHref(run, "attempts"), "/ui/campaigns/sort-speed/runs/sort-speed-3/attempts");
  assert.equal(
    attemptHref(run, "a-0123456789abcdef"),
    "/ui/campaigns/sort-speed/runs/sort-speed-3/attempts/a-0123456789abcdef",
  );
  assert.equal(runLiveHref(run), "/ui/campaigns/sort-speed/runs/sort-speed-3/live");
  assert.equal(
    runLiveHref(run, { w: "lane-2", compose: true }),
    "/ui/campaigns/sort-speed/runs/sort-speed-3/live?w=lane-2&compose=1",
  );
  // Everyone is the filter Live starts on: no part of the address.
  assert.equal(runLiveHref(run, { w: "all" }), "/ui/campaigns/sort-speed/runs/sort-speed-3/live");
  assert.equal(runLiveStreamHref(run), "/ui/campaigns/sort-speed/runs/sort-speed-3/live/stream");
  assert.equal(runMessageHref(run), "/ui/campaigns/sort-speed/runs/sort-speed-3/message");
  assert.equal(paperHref(run), "/ui/campaigns/sort-speed/runs/sort-speed-3/paper.md");
  assert.equal(
    championPatchHref(run, 4),
    "/ui/campaigns/sort-speed/runs/sort-speed-3/champions/4.patch",
  );
  // A run assigned without a campaign is its own campaign.
  assert.equal(runHref({ id: "r-1", campaign: null }), "/ui/campaigns/r-1/runs/r-1");
  // Names are encoded, so a name never makes another address.
  assert.equal(
    attemptHref({ id: "r/1", campaign: "c?x" }, "a#1"),
    "/ui/campaigns/c%3Fx/runs/r%2F1/attempts/a%231",
  );
});

test("a rig's own links are the rig's: its page and its whole Live", () => {
  assert.equal(rigHref("gpu-1"), "/ui/rigs/gpu-1");
  assert.equal(liveHref("gpu-1"), "/ui/rigs/gpu-1/live");
  assert.equal(liveHref("gpu-1", "trial:t-1"), "/ui/rigs/gpu-1/live?source=trial%3At-1");
  assert.equal(rigLiveStreamHref("gpu-1"), "/ui/rigs/gpu-1/live/stream");
});

test("each link is the path of the route that answers it; every tab but the overview has its part", () => {
  const route = (pattern: string, params: Record<string, string>) =>
    pattern.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ""));
  const at = { campaign: run.campaign, run: run.id };
  assert.equal(route(RUN_ROUTES.run, at), runHref(run));
  assert.equal(route(RUN_ROUTES.attempt, { ...at, attempt: "a-1" }), attemptHref(run, "a-1"));
  assert.equal(route(RUN_ROUTES.live, at), runLiveHref(run));
  assert.equal(route(RUN_ROUTES.liveStream, at), runLiveStreamHref(run));
  assert.equal(route(RUN_ROUTES.message, at), runMessageHref(run));
  assert.equal(route(RUN_ROUTES.paper, at), paperHref(run));
  assert.equal(route(RUN_ROUTES.champion, { ...at, file: "2.patch" }), championPatchHref(run, 2));
  for (const tab of RUN_TABS.filter((t) => t !== "overview")) {
    assert.equal(route(RUN_ROUTES.tab, { ...at, tab }), runHref(run, tab));
    assert.equal(runTab(tab), tab);
  }
  // The routes beside the tabs are not tabs; nor is the overview, which has no part.
  for (const part of ["overview", "live", "stream", "message", "paper.md", "steering", ""])
    assert.equal(runTab(part), undefined, part);
  // No address of a run's names its rig.
  for (const pattern of Object.values(RUN_ROUTES)) assert.doesNotMatch(pattern, /rig/);
});

test("the knowledge explorer's addresses: a place's parts, and an item's id kept whole in one part", () => {
  assert.equal(knowledgeHref(), "/ui/knowledge");
  assert.equal(knowledgeHref("gemv/gs-1/worker-1"), "/ui/knowledge/gemv/gs-1/worker-1");
  assert.equal(
    knowledgeHref("gemv/gs-1/worker-1/finding:2"),
    "/ui/knowledge/gemv/gs-1/worker-1/finding:2",
  );
  // A document's id holds its lane and path: one part, its slashes encoded.
  const doc = "gemv/gs-1/records/doc:lane-1/drafts/a b.md";
  const href = knowledgeHref(doc);
  assert.equal(href, "/ui/knowledge/gemv/gs-1/records/doc:lane-1%2Fdrafts%2Fa%20b.md");
  assert.deepEqual(knowledgeParts(href), ["gemv", "gs-1", "records", "doc:lane-1/drafts/a b.md"]);
  assert.deepEqual(knowledgeParts("/ui/knowledge"), []);
  assert.deepEqual(knowledgeParts("/ui/knowledge/gemv/"), ["gemv"]);
  assert.equal(knowledgeParts("/ui/knowledge/%zz"), undefined);
  assert.equal(knowledgeParts("/ui/knowledgebase"), undefined);
});
