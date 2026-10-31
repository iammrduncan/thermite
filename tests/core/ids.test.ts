import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandPayloads, MESSAGE_TARGET } from "../../src/core/commands.ts";
import { IdSchema } from "../../src/core/contract.ts";
import {
  CampaignId,
  EXPERIMENT_ID,
  ExperimentId,
  newAttemptId,
  newExperimentId,
  newTrialId,
  RIG_ID,
  RunId,
  TRIAL_ID,
} from "../../src/core/ids.ts";

test("a campaign's and a run's name have no dot; a kit's, a repository's and a case's keep theirs (goal 170)", () => {
  for (const ok of ["sort-speed", "sort_speed-2", "q4"]) {
    assert.ok(CampaignId.safeParse(ok).success, ok);
    assert.ok(RunId.safeParse(ok).success, ok);
  }
  for (const bad of ["llama.cpp-speed", "Sort", "-x", "a".repeat(65), ""]) {
    assert.ok(!CampaignId.safeParse(bad).success, bad);
    assert.ok(!RunId.safeParse(bad).success, bad);
  }
  assert.match(
    String(RunId.safeParse("a.b").error?.issues[0]?.message),
    /^a run's name is lowercase letters, digits, dashes and underscores/,
  );
  assert.ok(IdSchema.safeParse("llama.cpp").success, "a repository's name keeps its dots");
  // Every command that names a run takes the run's rule.
  assert.ok(!CommandPayloads.pause_run.safeParse({ run: "a.b", reason: "x" }).success);
  assert.ok(CommandPayloads.pause_run.safeParse({ run: "a-b", reason: "x" }).success);
  assert.ok(RIG_ID.test("rig-1") && !RIG_ID.test("rig-") && !RIG_ID.test("r"));
});

test("a run's attempts, trials and experiments: one shape each, minted at random (goal 170)", () => {
  const many = (mint: () => string) => new Set(Array.from({ length: 200 }, mint));
  for (const [mint, shape] of [
    [newAttemptId, /^a-[0-9a-f]{16}$/],
    [newTrialId, TRIAL_ID],
    [newExperimentId, EXPERIMENT_ID],
  ] as const) {
    const ids = many(mint);
    assert.equal(ids.size, 200, "no two alike");
    for (const id of ids) assert.match(id, shape);
  }
  assert.ok(ExperimentId.safeParse(newExperimentId()).success);
  assert.ok(!ExperimentId.safeParse("x-123").success);
  // An owner's message to one trial names it by its ID, as the scheduler mints it.
  assert.ok(MESSAGE_TARGET.test(`trial:${newTrialId()}`));
  for (const bad of ["trial:t-1", "trial:t-0123abcd", "trial:t-0123456789abcdef0", "lane-17"])
    assert.ok(!MESSAGE_TARGET.test(bad), bad);
  for (const ok of ["all", "review_panel", "lane-16"]) assert.ok(MESSAGE_TARGET.test(ok), ok);
});
