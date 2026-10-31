import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { type CommandKind, signEnvelope } from "../../src/core/commands.ts";
import { Scheduler } from "../../src/harness/agents/scheduler/index.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { Audits } from "../../src/harness/audits.ts";
import { LocalRunner } from "../../src/harness/broker/runner.ts";
import { Conclusions } from "../../src/harness/conclusions.ts";
import { Reviews } from "../../src/harness/reviews.ts";
import { FAST_KERNEL, makeJudgeEnv, SEED_KERNEL, WRONG_KERNEL } from "../helpers/judge-env.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

async function submit(env: ReturnType<typeof makeJudgeEnv>, kernel: string, flaws: string[] = []) {
  return (
    await env.service.submitAttempt(
      {
        run: "js-1",
        patch_base64: env.patch(kernel),
        hypothesis: "h",
        known_flaws: flaws,
      },
      "test",
    )
  ).attempt;
}

/** A command as control would sign it for a given issuer (agents are not the owner). */
function signAs(
  env: ReturnType<typeof makeJudgeEnv>,
  issuer: string,
  kind: CommandKind,
  payload: unknown,
) {
  return signEnvelope(
    {
      v: 1,
      id: randomUUID(),
      rig: "rig-a",
      kind,
      issued_by: issuer,
      issued_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      payload,
    },
    env.keys.privateKeyPem,
  );
}

const lowAudit = {
  acceptance: { looks: [3, 6], confirm_blocks: 4, audit: { ratio_to_median: 3, absolute: 0.15 } },
};

describe("directives", () => {
  test("the supervisor's set needs citations and replaces its last set; epochs record what steered them", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    // With its baseline (goal 115): the run's rounds wait for it.
    await env.start();
    assert.throws(
      () =>
        env.service.addDirectives(
          "js-1",
          [{ kind: "mandate", family: "tiling", rationale: "no source" }],
          "supervisor",
        ),
      /citation/,
    );
    assert.throws(() =>
      env.service.addDirectives(
        "js-1",
        [{ kind: "try", family: "x1", rationale: "r", citations: ["c"], verdict: "win_confirmed" }],
        "supervisor",
      ),
    );
    const first = env.service.addDirectives(
      "js-1",
      [{ kind: "avoid", family: "unrolling", rationale: "measured null", citations: ["a-1"] }],
      "supervisor",
    );
    const second = env.service.addDirectives(
      "js-1",
      [{ kind: "mandate", family: "tiling", rationale: "paper X", citations: ["arxiv:1"] }],
      "supervisor",
    );
    const active = env.ledger.directives.active("js-1").map((d) => d.id);
    assert.deepEqual(active, second);
    assert.ok(!active.includes(first[0] as number));
    // The fallback planner (no model reachable) must assign the mandated family, attributed.
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "s",
      runTrial: async () => ({
        stopped: "no_submission",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    await scheduler.tick();
    await scheduler.idle();
    const epoch = scheduler.registry.currentEpoch("js-1");
    assert.deepEqual(epoch?.directives, second);
    const tiling = epoch?.assignments.find((a) => a.family === "tiling");
    assert.equal(tiling?.directive, second[0]);
    const ev = env.ledger.eventsAfter(0, 10_000).events.find((e) => e.kind === "epoch_started");
    assert.ok(ev);
    assert.deepEqual((ev.body as { directives: number[] }).directives, second);
  });
});

describe("audits", () => {
  test("a gain above the trigger waits for the audit; a block holds it, and only the owner can override", async () => {
    const env = makeJudgeEnv({ contract: lowAudit });
    await env.service.applyCommand(env.assign);
    const id = await submit(env, FAST_KERNEL);
    await env.drain();
    assert.equal(env.ledger.verdicts.current(id)?.verdict, "win_confirmed");
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_audit");
    assert.equal(env.ledger.champions.current("js-1").seq, 1);
    const api = createHarnessApi(env.service, tokens);
    const pending = (await (
      await api.request("/v1/audits/pending", { headers: auth(tokens.supervisor) })
    ).json()) as { audits: { attempt: string; reason: string; diff: string }[] };
    assert.equal(pending.audits[0]?.attempt, id);
    assert.match(pending.audits[0]?.reason ?? "", /gain/);
    assert.match(pending.audits[0]?.diff ?? "", /work\.mjs/);
    // The proposer token cannot decide audits.
    const forbidden = await api.request("/v1/audits", {
      method: "POST",
      headers: auth(tokens.proposer),
      body: JSON.stringify({ attempt: id, decision: "clear", reasons: "r", auditor: "x" }),
    });
    assert.equal(forbidden.status, 401);
    const blocked = await api.request("/v1/audits", {
      method: "POST",
      headers: auth(tokens.supervisor),
      body: JSON.stringify({
        attempt: id,
        decision: "block",
        reasons: "timer looks touched",
        auditor: "opus",
      }),
    });
    assert.equal(blocked.status, 200);
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "audit_blocked");
    // A second decision is refused: decisions are written once.
    const again = await api.request("/v1/audits", {
      method: "POST",
      headers: auth(tokens.supervisor),
      body: JSON.stringify({ attempt: id, decision: "clear", reasons: "r", auditor: "opus" }),
    });
    assert.equal(again.status, 409);
    assert.equal(env.ledger.champions.current("js-1").seq, 1);
    const approved = await env.service.applyCommand(
      env.sign("approve_promotion", { run: "js-1", attempt: id }),
    );
    assert.ok(approved.status === "applied" && approved.accepted, JSON.stringify(approved));
    assert.equal(env.ledger.champions.current("js-1").attempt, id);
  });

  test("an auditor's clear is the last step: large gains and declared flaws promote with no owner step (goal 079)", async () => {
    // Above the absolute trigger: the auditor's clear promotes it.
    const big = makeJudgeEnv({ contract: lowAudit });
    await big.service.applyCommand(big.assign);
    const large = await submit(big, FAST_KERNEL);
    await big.drain();
    assert.equal(String(big.ledger.attempts.get(large)?.lifecycle), "awaiting_audit");
    const cleared = (await big.service.decideAudit({
      attempt: large,
      decision: "clear",
      reasons: "ok",
      citations: [],
      auditor: "a",
    })) as { effect?: string };
    assert.equal(cleared.effect, "promoted");
    assert.equal(big.ledger.champions.current("js-1").attempt, large);

    // Declared flaws: the auditor's clear accepts them, and the record says who did.
    const env2 = makeJudgeEnv({ contract: lowAudit });
    await env2.service.applyCommand(env2.assign);
    const flawed = await submit(env2, FAST_KERNEL, ["only tested on small inputs"]);
    await env2.drain();
    assert.equal(String(env2.ledger.attempts.get(flawed)?.lifecycle), "awaiting_audit");
    await env2.service.decideAudit({
      attempt: flawed,
      decision: "clear",
      reasons: "ok",
      citations: [],
      auditor: "a",
    });
    assert.equal(env2.ledger.champions.current("js-1").attempt, flawed);
    assert.match(String(env2.ledger.attempts.get(flawed)?.flaws_cleared_by), /the auditor's clear/);
    assert.ok(env2.ledger.latestEventBody("flaws_accepted", flawed));

    // The auditor's block stops it, with its reasons.
    const env3 = makeJudgeEnv({ contract: lowAudit });
    await env3.service.applyCommand(env3.assign);
    const stopped = await submit(env3, FAST_KERNEL);
    await env3.drain();
    await env3.service.decideAudit({
      attempt: stopped,
      decision: "block",
      reasons: "the timer is read twice",
      citations: [],
      auditor: "a",
    });
    assert.equal(String(env3.ledger.attempts.get(stopped)?.lifecycle), "audit_blocked");
    assert.match(
      String(env3.ledger.latestEventBody("promotion_blocked", stopped)?.reason),
      /blocked by the audit: the timer is read twice/,
    );
    assert.equal(env3.ledger.champions.current("js-1").seq, 1);
  });

  test("with no auditor, a win the judge confirms is promoted, and the skipped audit is recorded (goal 079)", async () => {
    // The supervisor said: no auditor. A large gain with declared flaws promotes at once.
    const env = makeJudgeEnv({ contract: lowAudit });
    await env.service.applyCommand(env.assign);
    await env.service.setAdvisors({ auditor: false, review_panel: 0 }, "supervisor");
    const win = await submit(env, FAST_KERNEL, ["only tested on small inputs"]);
    await env.drain();
    assert.equal(env.ledger.champions.current("js-1").attempt, win, env.explain(win));
    assert.equal(String(env.ledger.attempts.get(win)?.lifecycle), "promoted");
    assert.match(String(env.ledger.latestEventBody("audit_skipped", win)?.why), /no auditor/);
    assert.match(String(env.ledger.attempts.get(win)?.flaws_cleared_by), /no audit/);

    // An audit held before the supervisor said goes on when it says there is no auditor.
    const held = makeJudgeEnv({ contract: lowAudit });
    await held.service.applyCommand(held.assign);
    const x = await submit(held, FAST_KERNEL);
    await held.drain();
    assert.equal(String(held.ledger.attempts.get(x)?.lifecycle), "awaiting_audit");
    const api = createHarnessApi(held.service, tokens);
    const said = await api.request("/v1/advisors", {
      method: "PUT",
      headers: auth(tokens.supervisor),
      body: JSON.stringify({ auditor: false, review_panel: 0 }),
    });
    assert.equal(said.status, 200);
    assert.deepEqual(((await said.json()) as { released: string[] }).released, [x]);
    assert.equal(held.ledger.champions.current("js-1").attempt, x);
    assert.ok(held.ledger.latestEventBody("audit_skipped", x));
    // Only the supervisor's token may say it.
    const refused = await api.request("/v1/advisors", {
      method: "PUT",
      headers: auth(tokens.proposer),
      body: JSON.stringify({ auditor: false, review_panel: 0 }),
    });
    assert.equal(refused.status, 401);
  });

  test("a goal campaign's win promotes with no owner step too (goal 079)", async () => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 90e6 } });
    await env.service.applyCommand(env.assign);
    assert.equal(env.ledger.runs.get("js-1")?.promotion, null, "no policy of its own");
    await env.drain();
    const win = await submit(env, FAST_KERNEL);
    await env.drain();
    assert.equal(env.ledger.champions.current("js-1").attempt, win, env.explain(win));
  });

  test("a run set to ask the owner keeps its asks; a run that asked for approval keeps it (goal 079)", async () => {
    // Above a gain the run names: the win waits for the owner, with why.
    const gain = makeJudgeEnv({ contract: lowAudit, assign: { ask_owner: { above_gain: 0.05 } } });
    await gain.service.applyCommand(gain.assign);
    assert.deepEqual(gain.ledger.runs.get("js-1")?.ask_owner, { above_gain: 0.05 });
    await gain.service.setAdvisors({ auditor: false, review_panel: 0 }, "supervisor");
    const a = await submit(gain, FAST_KERNEL);
    await gain.drain();
    assert.equal(String(gain.ledger.attempts.get(a)?.lifecycle), "awaiting_approval");
    assert.match(
      String(gain.ledger.latestEventBody("promotion_pending", a)?.reason),
      /you asked to decide gains above 5\.0%/,
    );
    // An agent's credential cannot approve: control records who issued a command.
    const byAgent = signAs(gain, "agent:mcp", "approve_promotion", { run: "js-1", attempt: a });
    const refused = await gain.service.applyCommand(byAgent);
    assert.ok(refused.status === "applied" && !refused.accepted, JSON.stringify(refused));
    const ok = await gain.service.applyCommand(
      gain.sign("approve_promotion", { run: "js-1", attempt: a }),
    );
    assert.ok(ok.status === "applied" && ok.accepted, JSON.stringify(ok));
    assert.equal(gain.ledger.champions.current("js-1").attempt, a);

    // Declared flaws, when the run asks: after the auditor's clear, the owner decides.
    const flaws = makeJudgeEnv({
      contract: lowAudit,
      assign: { ask_owner: { declared_flaws: true } },
    });
    await flaws.service.applyCommand(flaws.assign);
    const f = await submit(flaws, FAST_KERNEL, ["only tested on small inputs"]);
    await flaws.drain();
    await flaws.service.decideAudit({
      attempt: f,
      decision: "clear",
      reasons: "ok",
      citations: [],
      auditor: "a",
    });
    assert.equal(String(flaws.ledger.attempts.get(f)?.lifecycle), "awaiting_approval");
    assert.equal(flaws.ledger.champions.current("js-1").seq, 1);
    assert.equal(flaws.ledger.attempts.get(f)?.flaws_cleared_by, null);

    // A run that asked for the owner's approval (a run from before goal 079 keeps its choice).
    const old = makeJudgeEnv({ promotion: "owner_approval" });
    await old.service.applyCommand(old.assign);
    await old.service.setAdvisors({ auditor: false, review_panel: 0 }, "supervisor");
    const o = await submit(old, FAST_KERNEL);
    await old.drain();
    assert.equal(String(old.ledger.attempts.get(o)?.lifecycle), "awaiting_approval");
    const own = makeJudgeEnv({ assign: { promotion: "owner_approval" } });
    await own.service.applyCommand(own.assign);
    await own.service.setAdvisors({ auditor: false, review_panel: 0 }, "supervisor");
    const w = await submit(own, FAST_KERNEL);
    await own.drain();
    assert.equal(String(own.ledger.attempts.get(w)?.lifecycle), "awaiting_approval");
    assert.match(
      String(own.ledger.latestEventBody("promotion_pending", w)?.reason),
      /you asked to decide every change/,
    );

    // The ratio trigger (far above earlier confirmed gains): with an auditor, its clear promotes.
    const env = makeJudgeEnv({
      contract: {
        acceptance: {
          looks: [3, 6],
          confirm_blocks: 4,
          audit: { ratio_to_median: 3, absolute: 1000 },
        },
      },
    });
    await env.service.applyCommand(env.assign);
    for (const tag of ["x", "y", "z"]) {
      const earlier = await submit(env, `${FAST_KERNEL}// ${tag}\n`);
      env.ledger.verdicts.record({
        attempt: earlier,
        verdict: "win_confirmed",
        delta: 0.01,
        reasons: "t",
        judgedBy: "t",
      });
      env.ledger.attempts.setLifecycle(earlier, "judged", "t");
    }
    env.ledger.db.prepare("update job set state = 'cancelled' where state = 'queued'").run();
    const clean = await submit(env, FAST_KERNEL);
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(clean)?.lifecycle), "awaiting_audit");
    assert.equal(String(new Audits(env.ledger).get(clean)?.trigger), "ratio");
    await env.service.decideAudit({
      attempt: clean,
      decision: "clear",
      reasons: "ok",
      citations: [],
      auditor: "a",
    });
    assert.equal(String(env.ledger.attempts.get(clean)?.lifecycle), "promoted");
  });
});

describe("audits when the champion moves", () => {
  test("a held win confirmed again against a new champion gets a new audit the auditor sees", async () => {
    const env = makeJudgeEnv({ contract: lowAudit });
    await env.service.applyCommand(env.assign);
    const x = await submit(env, FAST_KERNEL);
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(x)?.lifecycle), "awaiting_audit");
    const first = Number(new Audits(env.ledger).get(x)?.id);
    // Meanwhile another change becomes the champion.
    const y = await submit(env, `${SEED_KERNEL}// a restated seed\n`);
    env.ledger.db.prepare("update job set state = 'cancelled' where state = 'queued'").run();
    env.ledger.verdicts.record({
      attempt: y,
      verdict: "win_confirmed",
      reasons: "t",
      judgedBy: "t",
    });
    env.ledger.champions.promote({
      run: "js-1",
      expectedSeq: 1,
      attempt: y,
      commitSha: String(env.ledger.attempts.get(y)?.commit_sha),
      by: "t",
    });
    // The owner overrides the hold: the champion moved, so it is screened again...
    const r = await env.service.applyCommand(
      env.sign("approve_promotion", { run: "js-1", attempt: x }),
    );
    assert.ok(r.status === "applied" && r.accepted, JSON.stringify(r));
    assert.equal((r.result as { rescreen?: boolean }).rescreen, true);
    await env.drain();
    // ...and as it still wins, it waits for a new audit against the new champion.
    const audits = new Audits(env.ledger);
    assert.equal(String(env.ledger.attempts.get(x)?.lifecycle), "awaiting_audit");
    const second = audits.get(x);
    assert.notEqual(Number(second?.id), first);
    assert.equal(Number(second?.expected_seq), 2);
    assert.ok(audits.pending().includes(Number(second?.id)));
  });
});

describe("propagation", () => {
  test("another rig's champion is judged by the receiving rig and accepted there", async () => {
    const a = makeJudgeEnv();
    await a.service.applyCommand(a.assign);
    const win = await submit(a, FAST_KERNEL);
    await a.drain();
    assert.equal(a.ledger.champions.current("js-1").attempt, win, a.explain(win));
    const exp = await a.service.export("test");
    const published = a.ledger
      .eventsAfter(0, 10_000)
      .events.find((e) => e.kind === "champion_published")?.body as {
      seq: number;
      repo: string;
      base_commit: string;
      tree: string;
      sha256: string;
      path: string;
    };
    assert.equal(published.seq, 2);

    const b = makeJudgeEnv({
      rig: "rig-b",
      share: { root: a.root, seed: a.seed, kitCommit: a.kitCommit },
    });
    await b.service.applyCommand(b.assign);
    // What B's supervisor does: fetch the patch from the results repository into B's inbox.
    const staged = join(b.paths.inboxDir, "propagate", "rig-a", "js-1", "2.patch");
    mkdirSync(dirname(staged), { recursive: true });
    copyFileSync(join(exp.dir, published.path), staged);
    const command = (over: Record<string, unknown> = {}) =>
      b.sign("propagate", {
        run: "js-1",
        source_rig: "rig-a",
        source_run: "js-1",
        source_seq: 2,
        import: {
          kind: "champion_patch",
          path: "propagate/rig-a/js-1/2.patch",
          repo: published.repo,
          base_commit: published.base_commit,
          tree: published.tree,
          sha256: published.sha256,
          ...over,
        },
      });
    // A tree or a file that does not match the signed values is refused.
    const badTree = await b.service.applyCommand(command({ tree: "0".repeat(40) }));
    assert.ok(badTree.status === "applied" && !badTree.accepted);
    assert.match(JSON.stringify(badTree.result), /tree mismatch/);
    const badSha = await b.service.applyCommand(command({ sha256: "f".repeat(64) }));
    assert.ok(badSha.status === "applied" && !badSha.accepted);
    const ok = await b.service.applyCommand(command());
    assert.ok(ok.status === "applied" && ok.accepted, JSON.stringify(ok));
    const attempt = (ok.result as { attempt: string }).attempt;
    await b.drain();
    assert.equal(b.ledger.verdicts.current(attempt)?.verdict, "win_confirmed");
    assert.equal(b.ledger.champions.current("js-1").attempt, attempt);
    const { settlePropagations } = await import("../../src/harness/propagation.ts");
    settlePropagations(b.ledger, "t");
    const accepted = b.ledger
      .eventsAfter(0, 10_000)
      .events.find((e) => e.kind === "propagation_accepted")?.body as Record<string, unknown>;
    assert.deepEqual(
      { rig: accepted.source_rig, run: accepted.source_run, seq: accepted.source_seq },
      { rig: "rig-a", run: "js-1", seq: 2 },
    );
    // The same tree as B's champion now: a second propagation is recognised as identical.
    const again = await b.service.applyCommand(command());
    assert.ok(again.status === "applied" && again.accepted);
    assert.equal((again.result as { identical?: boolean }).identical, true);
    assert.ok(readFileSync(staged).length > 0);
  });
});

describe("goal reviews and conclusions", () => {
  test("a subjective goal passes the panel, and is met only when the owner accepts it", async () => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1e12 } });
    await env.service.applyCommand(env.assign);
    await env.drain(); // validates the seed and requests the review
    const reviews = new Reviews(env.ledger);
    const pending = reviews.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.goal, "readable");
    assert.ok(!JSON.stringify(pending[0]).includes("lane"));
    const id = pending[0]?.id as number;
    assert.throws(
      () => reviews.recordPanel(id, [{ reviewer: "one", pass: true, reasons: "fine" }], "s"),
      /at least 2/,
    );
    assert.equal(
      reviews.recordPanel(
        id,
        [
          { reviewer: "opus", pass: true, reasons: "clear" },
          { reviewer: "sol", pass: true, reasons: "clear" },
        ],
        "s",
      ),
      "review_passed",
    );
    const goalStatus = () =>
      String(
        env.ledger.db
          .prepare("select status from goal where run = 'js-1' and id = 'readable'")
          .get()?.status,
      );
    await env.drain();
    assert.equal(goalStatus(), "not_runnable", "panel pass alone is not enough");
    const r = await env.service.applyCommand(
      env.sign("accept_review", { run: "js-1", review: id, accept: true }),
    );
    assert.ok(r.status === "applied" && r.accepted, JSON.stringify(r));
    await env.drain();
    assert.equal(goalStatus(), "verified");
  });

  test("a review panel's pass is accepted with no owner step, unless the run asks (goal 079)", async () => {
    const results = [
      { reviewer: "opus", pass: true, reasons: "clear" },
      { reviewer: "sol", pass: true, reasons: "clear" },
    ];
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1e12 } });
    await env.service.applyCommand(env.assign);
    await env.drain();
    const id = new Reviews(env.ledger).pending()[0]?.id as number;
    assert.deepEqual(env.service.recordReviewPanel(id, results, "s"), {
      result: "review_passed",
      accepted: true,
    });
    await env.drain();
    assert.equal(
      env.ledger.db.prepare("select status from goal where run = 'js-1' and id = 'readable'").get()
        ?.status,
      "verified",
    );
    // A run set to ask: the pass waits for the owner.
    const asks = makeJudgeEnv({
      goal: { opsPerSecond: 1e12 },
      assign: { ask_owner: { reviews: true } },
    });
    await asks.service.applyCommand(asks.assign);
    await asks.drain();
    const id2 = new Reviews(asks.ledger).pending()[0]?.id as number;
    assert.deepEqual(asks.service.recordReviewPanel(id2, results, "s"), {
      result: "review_passed",
    });
    assert.equal(
      asks.ledger.db.prepare("select owner_decision from review").get()?.owner_decision,
      null,
    );
  });

  test("'not possible' is proposed from refuted approaches and ends the campaign unless the run asks (goal 079)", async () => {
    const refute = async (env: ReturnType<typeof makeJudgeEnv>) => {
      await env.service.applyCommand(env.assign);
      await env.drain();
      for (const k of [WRONG_KERNEL, `${WRONG_KERNEL}// b\n`, `${WRONG_KERNEL}// c\n`]) {
        const id = await submit(env, k);
        env.ledger.db.prepare("update attempt set family = 'closed-form' where id = ?").run(id);
        env.ledger.db
          .prepare(
            "insert or ignore into family (run, id, description, created_by, created_at) values ('js-1', 'closed-form', 'd', 't', ?)",
          )
          .run(new Date().toISOString());
      }
      await env.drain();
    };
    // Hands-off: the evidence ends the campaign.
    const auto = makeJudgeEnv({
      goal: { opsPerSecond: 1e12 },
      contract: { infeasibility: { allowed: true, min_refuted_approaches: 1 } },
    });
    await refute(auto);
    assert.equal(auto.ledger.runs.get("js-1")?.status, "closed");
    assert.match(String(auto.ledger.runs.get("js-1")?.pause_reason ?? ""), /not possible/);
    // A run set to ask: the proposal waits for the owner, and the campaign goes on.
    const env = makeJudgeEnv({
      goal: { opsPerSecond: 1e12 },
      contract: { infeasibility: { allowed: true, min_refuted_approaches: 1 } },
      assign: { ask_owner: { not_possible: true } },
    });
    await refute(env);
    const c = new Conclusions(env.ledger);
    const open = c.open("js-1");
    assert.ok(open, "a proposal exists");
    assert.equal(env.ledger.runs.get("js-1")?.status, "running");
    const r = await env.service.applyCommand(
      env.sign("conclude", { run: "js-1", proposal: Number(open?.id), accept: true }),
    );
    assert.ok(r.status === "applied" && r.accepted, JSON.stringify(r));
    assert.equal(env.ledger.runs.get("js-1")?.status, "closed");
  });
});

describe("supervisor limits", () => {
  test("the supervisor's token reads briefs and posts directives, but cannot submit or judge", async () => {
    const env = makeJudgeEnv({ heldOut: true });
    await env.service.applyCommand(env.assign);
    const api = createHarnessApi(env.service, tokens);
    const brief = await api.request("/v1/brief?run=js-1", {
      headers: auth(tokens.supervisor),
    });
    assert.equal(brief.status, 200);
    const text = await brief.text();
    assert.ok(!text.includes("held"), "no held-out cells in a brief");
    const attempt = await api.request("/v1/attempts", {
      method: "POST",
      headers: auth(tokens.supervisor),
      body: JSON.stringify({
        run: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "h",
      }),
    });
    assert.equal(attempt.status, 401);
    const noBrief = await api.request("/v1/brief?run=js-1", {
      headers: auth(tokens.proposer),
    });
    assert.equal(noBrief.status, 401);
  });
});
