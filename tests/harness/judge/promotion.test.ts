import assert from "node:assert/strict";
import { test } from "node:test";
import { FAST_KERNEL, makeJudgeEnv } from "../../helpers/judge-env.ts";
import { uniforms } from "../../helpers/property.ts";

test("an approval that fails after the champion moves leaves the record whole (goal 163)", async () => {
  const env = makeJudgeEnv({ realRuns: true, promotion: "owner_approval" });
  await env.start();
  const { attempt } = await env.service.submitAttempt(
    {
      run: "js-1",
      patch_base64: env.patch(FAST_KERNEL),
      hypothesis: "drop the wasted inner loop",
      known_flaws: ["it was only timed on the small case"],
    },
    "proposer",
  );
  await env.drain();
  // Declared flaws send it to an audit, which the owner's approval overrides.
  assert.equal(env.ledger.attempts.get(attempt)?.lifecycle, "awaiting_audit", env.explain(attempt));
  // The champion moves, then the git ref can't be written: the step after the ledger fails.
  env.service.syncChampionRef = async () => {
    throw new Error("git: no space left on device");
  };
  const out = await env.service.applyCommand(
    env.sign("approve_promotion", { run: "js-1", attempt }),
  );
  assert.equal(out.status, "applied");
  assert.equal(env.ledger.champions.current("js-1").attempt, attempt);
  // The champion, its flaws' acceptance, the override and the lifecycle were written together.
  const a = env.ledger.attempts.get(attempt);
  assert.equal(a?.lifecycle, "promoted", env.explain(attempt));
  assert.equal(a?.flaws_cleared_by, "control:owner");
  const kinds = env.ledger
    .eventsAfter(0, 10_000)
    .events.filter((e) => e.subject === attempt || e.subject === "js-1")
    .map((e) => e.kind);
  assert.ok(kinds.includes("champion_promoted"));
  assert.ok(kinds.includes("flaws_accepted"));
  assert.ok(kinds.includes("audit_overridden"));
});

test("promotion is a compare-and-swap on the champion, on seeded random sequences of calls", async () => {
  for (const seed of [21, 22, 23]) {
    const env = makeJudgeEnv();
    await env.start();
    const d = uniforms(seed);
    // A dozen promotable changes, each a distinct commit with a confirmed win.
    const attempts: { attempt: string; commitSha: string }[] = [];
    for (let k = 0; k < 12; k++) {
      const { attempt } = await env.service.submitAttempt(
        {
          run: "js-1",
          patch_base64: env.patch(`${FAST_KERNEL}// variant ${seed}-${k}\n`),
          hypothesis: `variant ${k}`,
          known_flaws: [],
        },
        "t",
      );
      env.ledger.verdicts.record({
        attempt,
        verdict: "win_confirmed",
        reasons: "t",
        judgedBy: "t",
      });
      attempts.push({ attempt, commitSha: String(env.ledger.attempts.get(attempt)?.commit_sha) });
    }
    const seqs = () =>
      env.ledger.db
        .prepare("select seq from champion where run = 'js-1' order by seq")
        .all()
        .map((r) => Number(r.seq));
    let current = env.ledger.champions.current("js-1").seq;
    // Each change is offered once, against the champion's seq or a stale or a future one.
    for (const a of attempts) {
      const pick = d();
      const expectedSeq = pick < 0.5 ? current : pick < 0.8 ? current - 1 : current + 1;
      const events = env.ledger.eventsAfter(0, 100_000).events.length;
      const r = env.ledger.champions.promote({ run: "js-1", expectedSeq, ...a, by: "t" });
      const where = `seed ${seed}, ${a.attempt} against ${expectedSeq} with ${current}`;
      if (expectedSeq === current) {
        assert.deepEqual(r, { ok: true, seq: current + 1 }, where);
        current += 1;
        assert.equal(String(env.ledger.attempts.get(a.attempt)?.lifecycle), "promoted", where);
      } else {
        assert.deepEqual(r, { ok: false, currentSeq: current }, where);
        assert.equal(env.ledger.eventsAfter(0, 100_000).events.length, events, where);
        assert.notEqual(String(env.ledger.attempts.get(a.attempt)?.lifecycle), "promoted", where);
      }
      assert.equal(env.ledger.champions.current("js-1").seq, current, where);
    }
    // The champions are numbered one by one, with no gap.
    assert.deepEqual(
      seqs(),
      Array.from({ length: current }, (_, i) => i + 1),
      `seed ${seed}`,
    );
    assert.ok(current > 2, `seed ${seed}: the sequence promoted something`);
  }
});
