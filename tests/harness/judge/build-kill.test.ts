import assert from "node:assert/strict";
import { test } from "node:test";
import { FAST_KERNEL, makeJudgeEnv } from "../../helpers/judge-env.ts";

test("a candidate's build killed for time is tried once more before it counts against the change (goal 163)", async () => {
  // A kernel that says SLOW builds for longer than the kit's 2 seconds: killed every time.
  const env = makeJudgeEnv({
    realRuns: true,
    kitBuild: {
      command: [
        "sh",
        "-c",
        "if grep -q SLOW src/kernel/work.mjs; then sleep 10; fi; mkdir -p out && cp src/kernel/work.mjs .kit/bench/run.mjs out/",
      ],
      timeout_s: 2,
    },
  });
  await env.start();
  const { attempt } = await env.service.submitAttempt(
    {
      run: "js-1",
      patch_base64: env.patch(`${FAST_KERNEL}\n// SLOW\n`),
      hypothesis: "a slow build",
      known_flaws: [],
    },
    "proposer",
  );
  await env.drain();
  const verdicts = env.ledger.db
    .prepare("select verdict, reasons from verdict where attempt = ? order by id")
    .all(attempt) as { verdict: string; reasons: string }[];
  assert.deepEqual(
    verdicts.map((v) => v.verdict),
    ["crash_infra", "crash_candidate"],
    env.explain(attempt),
  );
  assert.match(verdicts[0]?.reasons ?? "", /build killed \(timeout\); tried once more/);
});
