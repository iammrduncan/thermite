import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { portReplaced } from "../../../src/harness/judge/ports.ts";
import { FAST_KERNEL, FAST_KERNEL_RESTATED, makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * The stand-in runner times the kernels: a change screened against a champion with the same
 * effect is an A/A comparison, which real runs on a loaded machine can show as a win.
 */
async function setup() {
  const env = makeJudgeEnv();
  await env.start();
  const submit = async (kernel: string, hypothesis: string) =>
    (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(kernel), hypothesis, known_flaws: [] },
        "proposer",
      )
    ).attempt;
  /** Makes an attempt the champion by another path than the judge's. */
  const crown = (attempt: string, expectedSeq: number) => {
    env.ledger.verdicts.record({ attempt, verdict: "win_confirmed", reasons: "t", judgedBy: "t" });
    const commitSha = String(env.ledger.attempts.get(attempt)?.commit_sha);
    return env.ledger.champions.promote({ run: "js-1", expectedSeq, attempt, commitSha, by: "t" });
  };
  const ports = () =>
    env.service.queue
      .all("js-1")
      .filter((x) => x.title.startsWith("Port "))
      .map((x) => ({ title: x.title, by: x.added_by, state: x.state }));
  return { ...env, submit, crown, ports };
}

describe("changes carried to a new champion (goal 135)", () => {
  test("a change written on an older champion that loses to the new one, but helped on its own, is ported", async () => {
    const env = await setup();
    const a = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    const b = await env.submit(FAST_KERNEL_RESTATED, "the same, restated");
    // b becomes champion #2; a was written on #1.
    assert.deepEqual(env.crown(b, 1), { ok: true, seq: 2 });
    // The judge screens a against #2: no win, the same speed. Then against #1, the champion it
    // was written on: its own effect, for a port.
    await env.drain();
    const screened = env.ledger.latestEventBody("parent_screened", a) as { verdict: string };
    assert.equal(screened.verdict, "win_screened", env.explain(a));
    // Its verdict and lifecycle are the ones against the current champion.
    assert.notEqual(env.ledger.verdicts.current(a)?.verdict, "win_screened");
    assert.equal(String(env.ledger.attempts.get(a)?.lifecycle), "judged");
    assert.deepEqual(env.ports(), [
      { title: `Port ${a} onto champion #2`, by: "judge", state: "queued" },
    ]);
    const x = env.service.queue.all("js-1").find((e) => e.title.startsWith("Port "));
    assert.match(
      String(x?.details),
      /Measured against champion #1, the champion it was written on: \+/,
    );
    assert.match(String(x?.details), /work\.mjs/);
    // b is the champion: its change is in it, so it is neither measured on #1 nor ported.
    assert.equal(env.ledger.latestEventBody("parent_screened", b), undefined);
    // Once for each change and champion.
    assert.equal(
      env.ledger.db.prepare("select count(*) as n from event where kind = 'port_queued'").get()?.n,
      1,
    );
  });

  test("a new champion written on an older one gets the champion it replaced ported onto it", async () => {
    const env = await setup();
    const a = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    const b = await env.submit(FAST_KERNEL_RESTATED, "the same, restated");
    assert.deepEqual(env.crown(a, 1), { ok: true, seq: 2 });
    // a's own promotion, on #1, needs no port.
    await portReplaced(env.service, "js-1");
    assert.deepEqual(env.ports(), []);
    // b, written on #1 too, replaces #2: a's change is not in it.
    assert.deepEqual(env.crown(b, 2), { ok: true, seq: 3 });
    await env.service.syncChampionRef("js-1");
    assert.deepEqual(env.ports(), [
      { title: `Port ${a} onto champion #3`, by: "judge", state: "queued" },
    ]);
    await env.service.syncChampionRef("js-1");
    assert.equal(env.ports().length, 1, "queued once");
  });
});
