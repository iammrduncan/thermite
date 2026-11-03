import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  MCP_AGENT_KINDS,
  MCP_OPERATOR_KINDS,
  MCP_OWNER_KINDS,
  OWNER_ONLY_KINDS,
  RUN_KINDS,
} from "../../../src/core/commands.ts";
import type { HarnessEnv } from "../../helpers/harness-env.ts";
import {
  type Answer,
  type Applied,
  assigned,
  judge,
  promote,
  RUN,
  submit,
  twoChampions,
} from "../../helpers/withdraw-env.ts";

/**
 * The owner withdraws bad evidence (goal 174): `invalidate_evidence`, owner only. A preview says
 * what it reaches and changes nothing; the confirmation names the preview's sha and does exactly
 * that: an attempt and those built on it withdrawn for good, or a job's measurements withdrawn and
 * what rested on them judged again, verdicts superseded, champions reopened and the run's champion
 * moved back with a recorded step. Nothing is deleted.
 */

async function apply(env: HarnessEnv, payload: unknown, issuedBy = "owner:ui"): Promise<Applied> {
  return (await env.service.applyCommand(
    env.sign("invalidate_evidence", payload, { issuedBy }),
  )) as Applied;
}

const count = (env: HarnessEnv, table: string) =>
  Number(
    (env.service.ledger.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n,
  );

/** The rows of each table that holds the research record, and the newest event. */
const record = (env: HarnessEnv) => ({
  attempts: count(env, "attempt"),
  verdicts: count(env, "verdict"),
  jobs: count(env, "job"),
  champions: count(env, "champion"),
  invalidations: count(env, "invalidation"),
  reopened: env.service.ledger.champions.reopened(RUN),
  champion: env.service.ledger.champions.current(RUN).seq,
  lifecycles: env.service.ledger.attempts.lifecycles(RUN),
});

describe("invalidate_evidence (goal 174)", () => {
  test("an attempt is withdrawn for good, with every attempt built on it: its champions reopen and the champion moves back", async () => {
    const { env, a, b, c, d } = await twoChampions();
    const ledger = env.service.ledger;
    assert.equal(ledger.champions.current(RUN).seq, 3);
    const reason = "the timer was wrong on this card";

    // The preview: what it reaches, with nothing changed.
    const before = record(env);
    const preview = await apply(env, { run: RUN, attempt: a.attempt, reason, preview: true });
    assert.equal(preview.accepted, true, JSON.stringify(preview));
    const seen = preview.result as Answer;
    assert.equal(seen.preview, true);
    assert.deepEqual(record(env), before);
    const r = seen.reach;
    assert.deepEqual(
      r.attempts.map((x) => [x.attempt, x.why, x.parent, x.then]),
      [
        [a.attempt, "subject", null, "withdrawn"],
        [b.attempt, "lineage", a.attempt, "withdrawn"],
        [d.attempt, "lineage", b.attempt, "withdrawn"],
      ],
    );
    assert.equal(r.for_good, true);
    assert.equal(r.superseded, 2);
    assert.deepEqual(
      r.champions.map((x) => [x.seq, x.attempt, x.published]),
      [
        [2, a.attempt, false],
        [3, b.attempt, false],
      ],
    );
    assert.deepEqual(r.champion, { from: 3, to: 1, to_attempt: null, validate: false });
    const dJob = ledger.jobs.openOf([d.attempt]);
    assert.equal(dJob.length, 1);
    assert.deepEqual(
      r.jobs.cancelled.map((j) => j.id),
      dJob.map((j) => j.id),
    );
    assert.match(seen.words.join(" "), /built on it .* are withdrawn for good/);
    assert.match(seen.words.join(" "), /moves back from #3 to #1, the starting point/);

    // A confirmation must name what the preview reached.
    const wrong = await apply(env, { run: RUN, attempt: a.attempt, reason, reach: "0".repeat(64) });
    assert.equal(wrong.accepted, false);
    assert.match(JSON.stringify(wrong.result), /what it reaches changed since the preview/);
    assert.deepEqual(record(env), before);

    // The confirmation does what the preview said.
    const done = await apply(env, { run: RUN, attempt: a.attempt, reason, reach: seen.sha });
    assert.equal(done.accepted, true, JSON.stringify(done));
    const did = done.result as Answer & { invalidation: number };
    assert.deepEqual(did.reach, seen.reach);
    assert.deepEqual(did.words, seen.words);
    assert.equal(did.sha, seen.sha);

    // Withdrawn for good: marked, and an invalidated verdict superseding the one before.
    for (const id of [a.attempt, b.attempt, d.attempt]) {
      assert.equal(Number(ledger.attempts.get(id)?.invalidated_by), did.invalidation);
      assert.equal(ledger.verdicts.current(id)?.verdict, "invalidated");
    }
    const history = ledger.db
      .prepare("select verdict, supersedes from verdict where attempt = ? order by id")
      .all(a.attempt) as { verdict: string; supersedes: number | null }[];
    assert.deepEqual(
      history.map((h) => h.verdict),
      ["win_confirmed", "invalidated"],
    );
    assert.ok(history[1]?.supersedes);
    assert.throws(
      () =>
        ledger.verdicts.record({
          attempt: a.attempt,
          verdict: "win_confirmed",
          reasons: "again",
          judgedBy: "judge",
        }),
      /invalidated/,
    );
    // Nothing else is touched.
    assert.equal(ledger.verdicts.current(c.attempt)?.verdict, "neutral");
    assert.equal(ledger.attempts.get(c.attempt)?.invalidated_by, null);
    // The champions reopen, and the run's champion moves back, with a recorded step.
    assert.equal(ledger.champions.current(RUN).seq, 1);
    assert.deepEqual(ledger.champions.reopened(RUN), [2, 3]);
    const moved = ledger.latestEventBody("champion_moved_back", RUN);
    assert.deepEqual(moved, {
      from: 3,
      to: 1,
      attempt: null,
      commit: env.seedCommit,
      invalidation: did.invalidation,
      reason,
    });
    // Its git ref follows the ledger.
    const run = ledger.runs.get(RUN);
    const ref = execFileSync("git", ["rev-parse", `refs/thermite/runs/${RUN}/champion`], {
      cwd: env.service.mirrorFor(String(run?.seed_repo)),
      encoding: "utf8",
    }).trim();
    assert.equal(ref, env.seedCommit);
    // The judge's job for the change that waited is cancelled, and the change settles.
    assert.equal(ledger.jobs.get(dJob[0]?.id ?? 0)?.state, "cancelled");
    assert.equal(
      ledger.latestEventBody("job_cancelled", String(dJob[0]?.id))?.invalidation,
      did.invalidation,
    );
    assert.equal(String(ledger.attempts.get(d.attempt)?.lifecycle), "judged");
    assert.deepEqual(ledger.latestEventBody("invalidation", a.attempt), {
      id: did.invalidation,
      run: RUN,
      kind: "attempt",
      reason,
      attempts: [a.attempt, b.attempt, d.attempt],
      verdicts: (
        ledger.db
          .prepare("select id from verdict where verdict = 'invalidated' order by id")
          .all() as { id: number }[]
      ).map((v) => v.id),
      champions: [2, 3],
    });

    // The record is whole: nothing deleted, only new rows.
    const after = record(env);
    assert.equal(after.attempts, before.attempts);
    assert.equal(after.verdicts, before.verdicts + 3);
    assert.equal(after.jobs, before.jobs);
    assert.equal(after.champions, before.champions);
    assert.equal(after.invalidations, 1);
    const events = env.service.ledger.db
      .prepare("select count(*) as n, max(id) as m from event")
      .get() as { n: number; m: number };
    assert.equal(events.n, events.m);

    // A change a trial built on a withdrawn champion is withdrawn with it as it arrives.
    const late = await submit(env, "e.c", b.commit);
    assert.equal(late.lifecycle, "judged");
    assert.equal(ledger.verdicts.current(late.attempt)?.verdict, "invalidated");
    assert.equal(Number(ledger.attempts.get(late.attempt)?.invalidated_by), did.invalidation);
    assert.deepEqual(ledger.jobs.openOf([late.attempt]), []);
    // Withdrawn already: nothing more to withdraw.
    const again = await apply(env, { run: RUN, attempt: a.attempt, reason, preview: true });
    assert.equal(again.accepted, false);
    assert.match(JSON.stringify(again.result), /was withdrawn already, for good/);
  });

  test("a job's measurements are withdrawn: what rested on them is measured again, and what was built on it judged again", async () => {
    const env = await assigned();
    const ledger = env.service.ledger;
    const a = await submit(env, "a.c");
    const jobA = judge(env, a.attempt, "win_confirmed");
    promote(env, a.attempt, 1, a.commit);
    const b = await submit(env, "b.c", a.commit);
    judge(env, b.attempt, "neutral");
    const c = await submit(env, "c.c", env.seedCommit);
    judge(env, c.attempt, "neutral");
    const reason = "the device throttled during job";

    // A job still waiting has no measurements to withdraw.
    const waiting = await submit(env, "w.c", a.commit);
    const open = ledger.jobs.openOf([waiting.attempt])[0];
    const early = await apply(env, { run: RUN, job: open?.id, reason, preview: true });
    assert.equal(early.accepted, false);
    assert.match(JSON.stringify(early.result), /is queued: it has no measurements to withdraw yet/);

    const preview = (await apply(env, { run: RUN, job: jobA, reason, preview: true }))
      .result as Answer;
    assert.equal(preview.reach.for_good, false);
    assert.deepEqual(
      preview.reach.attempts.map((x) => [x.attempt, x.why, x.then]),
      [
        [a.attempt, "evidence", "judged_again"],
        [b.attempt, "lineage", "judged_again"],
        [waiting.attempt, "lineage", "judged_again"],
      ],
    );
    assert.equal(preview.reach.jobs.queued, 3);
    assert.deepEqual(preview.reach.champion, { from: 2, to: 1, to_attempt: null, validate: false });
    assert.match(preview.words.join(" "), /3 attempts go back to the judge/);

    const done = await apply(env, { run: RUN, job: jobA, reason, reach: preview.sha });
    assert.equal(done.accepted, true, JSON.stringify(done));
    assert.deepEqual((done.result as Answer).reach, preview.reach);
    for (const id of [a.attempt, b.attempt, waiting.attempt]) {
      // Not for good: the attempt may be measured again.
      assert.equal(ledger.attempts.get(id)?.invalidated_by, null);
      assert.equal(ledger.verdicts.current(id)?.verdict, "invalidated");
      assert.equal(String(ledger.attempts.get(id)?.lifecycle), "queued");
      const jobs = ledger.jobs.openOf([id]);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.kind, "evaluate");
    }
    // The job that waited is cancelled, and a fresh one queued in its place.
    assert.equal(ledger.jobs.get(open?.id ?? 0)?.state, "cancelled");
    assert.equal(ledger.verdicts.current(c.attempt)?.verdict, "neutral");
    assert.equal(ledger.champions.current(RUN).seq, 1);
    assert.equal(ledger.latestEventBody("champion_moved_back", RUN)?.from, 2);
    // Its evidence measured again: a new verdict supersedes the invalidated one.
    judge(env, a.attempt, "neutral");
    assert.equal(ledger.verdicts.current(a.attempt)?.verdict, "neutral");
    const history = ledger.db
      .prepare("select verdict from verdict where attempt = ? order by id")
      .all(a.attempt) as { verdict: string }[];
    assert.deepEqual(
      history.map((h) => h.verdict),
      ["win_confirmed", "invalidated", "neutral"],
    );
  });

  test("only the owner withdraws evidence: every other issuer is refused, and a confirmation needs a preview's sha", async () => {
    const { env, a } = await twoChampions();
    const before = record(env);
    const p = { run: RUN, attempt: a.attempt, reason: "r", preview: true };
    for (const by of [
      "agent:mcp",
      "owner:operator",
      "reader:mcp",
      "supervisor",
      "judge",
      "control",
    ]) {
      const out = await apply(env, p, by);
      assert.equal(out.accepted, false, by);
      assert.match(
        JSON.stringify(out.result),
        new RegExp(`is the owner's (own )?to issue, not ${by}'s`),
      );
    }
    for (const by of ["owner", "owner:ui", "owner:api", "owner:mcp"])
      assert.equal((await apply(env, p, by)).accepted, true, by);
    assert.deepEqual(record(env), before);
    // Control's lists: the owner's MCP token may send it; an operator's and an agent's may not.
    assert.ok(OWNER_ONLY_KINDS.has("invalidate_evidence"));
    assert.ok(RUN_KINDS.has("invalidate_evidence"));
    assert.ok((MCP_OWNER_KINDS as readonly string[]).includes("invalidate_evidence"));
    assert.ok(!(MCP_OPERATOR_KINDS as readonly string[]).includes("invalidate_evidence"));
    assert.ok(!(MCP_AGENT_KINDS as readonly string[]).includes("invalidate_evidence"));
    // Without a preview's sha, or naming both an attempt and a job, the payload is refused.
    const bare = await apply(env, { run: RUN, attempt: a.attempt, reason: "r" });
    assert.equal(bare.status, "rejected");
    assert.match(String(bare.reason), /reach: send a preview first/);
    const both = await apply(env, {
      run: RUN,
      attempt: a.attempt,
      job: 1,
      reason: "r",
      preview: true,
    });
    assert.match(String(both.reason), /name one attempt or one job/);
  });

  test("the steps reach the export", async () => {
    const { env, a } = await twoChampions();
    const reason = "bad timer";
    const seen = (await apply(env, { run: RUN, attempt: a.attempt, reason, preview: true }))
      .result as Answer;
    await apply(env, { run: RUN, attempt: a.attempt, reason, reach: seen.sha });
    const out = await env.service.export("owner", {});
    const kinds = readFileSync(join(out.dir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { kind: string }).kind);
    for (const k of ["invalidation", "champion_reopened", "champion_moved_back", "job_cancelled"])
      assert.ok(kinds.includes(k), k);
  });
});
