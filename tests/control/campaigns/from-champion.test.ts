import assert from "node:assert/strict";
import { test } from "node:test";
import { runBranchesOf } from "../../../src/control/campaigns/from-champion.ts";
import { resultsOf } from "../../../src/control/campaigns/new.ts";

test("where a campaign's runs' work goes, from the page's draft: a destination needs an access that can push (goal 185)", () => {
  assert.equal(resultsOf(undefined), undefined);
  assert.equal(resultsOf({ to: "control" }), undefined);
  assert.deepEqual(resultsOf({ to: "project", access: "deploy-rw" }), {
    to: "project",
    access: "deploy-rw",
  });
  assert.deepEqual(
    resultsOf({ to: "repository", git: "git@git.example:you/results.git", access: "deploy-rw" }),
    { to: "repository", git: "git@git.example:you/results.git", access: "deploy-rw" },
  );
  assert.match(
    String(resultsOf({ to: "project", access: "" })),
    /choose a Git access that can push/,
  );
  assert.match(
    String(resultsOf({ to: "repository", git: "file:///tmp/x", access: "a" })),
    /https:\/\/, ssh:\/\/ or git@host:path/,
  );
  assert.match(String(resultsOf({ to: "elsewhere", access: "a" })), /is not a choice/);
});

test("a run's branches from its rig's supervisor figures; a malformed report gives none (goal 185)", () => {
  const sha = "a".repeat(40);
  const figures = {
    run_branches: {
      "mm-2": {
        git: "https://git.example/you/project.git",
        branch: "thermite/mm-2/champion",
        champions: { "1": sha, "2": "b".repeat(40) },
        lanes: { "thermite/mm-2/lane-1": "c".repeat(40) },
        waiting: false,
        pushed_at: "2026-11-02T20:00:00.000Z",
        error: null,
      },
    },
  };
  assert.equal(runBranchesOf(figures, "mm-2")?.champions["2"], "b".repeat(40));
  assert.equal(runBranchesOf(figures, "other"), null);
  assert.equal(runBranchesOf(null, "mm-2"), null);
  assert.equal(
    runBranchesOf(
      {
        run_branches: {
          "mm-2": { ...figures.run_branches["mm-2"], champions: { "1": "not a sha" } },
        },
      },
      "mm-2",
    ),
    null,
  );
});
