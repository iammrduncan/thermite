import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CommandKind } from "../../../src/core/commands.ts";
import type { ResearchContract } from "../../../src/core/contract.ts";
import { indexEvent, type KbFields } from "../../../src/core/kb-index.ts";
import { HYPOTHESIS_STATUS } from "../../../src/harness/research/research/index.ts";
import { researchPackage } from "../../../src/harness/research/review/index.ts";
import { hillClimbFixture } from "../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";
import { researchEnv } from "../../helpers/research-run.ts";

/**
 * Goal 117: a research run's hypotheses change status by command. The owner (or an operator for
 * the owner) promotes one of the pool, so the review panel must give it a verdict, returns a
 * promoted one to the pool, or retires one; the author's can't be changed this way. The planner's
 * promotions and retirements go through the same function (research-planner.test.ts).
 */

async function hypothesisEnv() {
  const { env, research, contract } = await researchEnv({
    questions: ["First?", "Second?"],
    hypotheses: ["Stateless workers make long runs safe."],
  });
  const author = String(
    (
      env.service.ledger.db.prepare("select id from hypothesis where status = 'author'").get() as {
        id: string;
      }
    ).id,
  );
  /** A signed command, applied: its result, or its refusal in words. */
  const command = async (kind: CommandKind, payload: unknown, issuedBy = "owner:ui") => {
    const r = await env.service.applyCommand(env.sign(kind, payload, { issuedBy }));
    assert.equal(r.status, "applied", JSON.stringify(r));
    const a = r as { accepted: boolean; result: unknown };
    return a.accepted
      ? { ok: true as const, result: a.result as Record<string, unknown> }
      : { ok: false as const, error: String((a.result as { error?: string }).error ?? a.result) };
  };
  const statusOf = (id: string) =>
    (
      env.service.ledger.db.prepare("select status from hypothesis where id = ?").get(id) as {
        status: string;
      }
    ).status;
  const events = () =>
    env.service.ledger.eventsAfter(0, 100_000).events.filter((e) => e.kind === HYPOTHESIS_STATUS);
  return {
    env,
    research,
    author,
    command,
    statusOf,
    events,
    contract: contract as ResearchContract,
  };
}

describe("a hypothesis's status by command (goal 117)", () => {
  test("the owner promotes one of the pool: the review panel must judge it; then returns and retires it", async () => {
    const s = await hypothesisEnv();
    const pool = s.research.proposeHypothesis("r-1", "lane-1", {
      text: "Caches help long runs most.",
      question: 1,
    });
    const id = pool.hypothesis;
    const pkg = () => researchPackage(s.env.service.ledger, "r-1", s.contract);
    assert.deepEqual(
      pkg().hypotheses.map((h) => h.id),
      [s.author],
      "the pool's never need a verdict",
    );
    const up = await s.command("hypothesis_status", {
      run: "r-1",
      id,
      status: "promoted",
      reason: "the second question turns on it",
    });
    assert.ok(up.ok, JSON.stringify(up));
    assert.deepEqual(
      [up.result.hypothesis, up.result.status, up.result.from, up.result.changed],
      [id, "promoted", "pool", true],
    );
    assert.equal(s.statusOf(id), "promoted");
    assert.deepEqual(
      pkg().hypotheses.map((h) => h.id),
      [s.author, id],
      "a promoted one needs a verdict, as the author's do",
    );
    assert.match(
      s.research.hypothesesBrief("r-1"),
      new RegExp(
        `They need a verdict:[^]*${id} \\(promoted, which needs a verdict; Question 2 \\(index 1\\)\\)`,
      ),
    );
    const e = s.events().at(-1);
    assert.equal(e?.actor, "control:owner:ui");
    assert.deepEqual(e?.body, {
      hypothesis: id,
      status: "promoted",
      from: "pool",
      by: "control:owner:ui",
      reason: "the second question turns on it",
      question: 1,
      text: "Caches help long runs most.",
    });
    // Back to the pool, then retired: each a new event; the same status again changes nothing.
    assert.ok(
      (
        await s.command("hypothesis_status", {
          run: "r-1",
          id,
          status: "pool",
          reason: "not central after all",
        })
      ).ok,
    );
    assert.equal(s.statusOf(id), "pool");
    assert.deepEqual(
      pkg().hypotheses.map((h) => h.id),
      [s.author],
    );
    const same = await s.command("hypothesis_status", {
      run: "r-1",
      id,
      status: "pool",
      reason: "again",
    });
    assert.ok(same.ok);
    assert.equal(same.result.changed, false);
    assert.match(String(same.result.note), /is in the pool already: nothing changed/);
    assert.ok(
      (
        await s.command("hypothesis_status", {
          run: "r-1",
          id,
          status: "retired",
          reason: "out of scope",
        })
      ).ok,
    );
    assert.equal(s.statusOf(id), "retired");
    assert.deepEqual(
      s.events().map((x) => (x.body as { status: string }).status),
      ["promoted", "pool", "retired"],
    );
    // A retired hypothesis is not live: its words may be proposed again; then it can't come back.
    const twin = s.research.proposeHypothesis("r-1", "lane-2", {
      text: "caches help long runs most",
    });
    const back = await s.command("hypothesis_status", {
      run: "r-1",
      id,
      status: "pool",
      reason: "back",
    });
    assert.ok(!back.ok);
    assert.match(
      back.error,
      new RegExp(
        `hypothesis ${id}'s words repeat ${twin.hypothesis} \\(in the pool\\): change ${twin.hypothesis} instead`,
      ),
    );
    // The knowledge base follows: the item's status, and who set it and why.
    const items = new Map<string, KbFields>();
    const target = {
      runCreated: () => {},
      item: (_r: string, _k: string, ref: string) => {
        const x = items.get(ref);
        return x?.body === undefined ? undefined : { body: x.body, meta: x.meta ?? {} };
      },
      attempt: () => undefined,
      put: (_r: string, _k: string, ref: string, f: KbFields) => {
        items.set(ref, { ...items.get(ref), ...f });
      },
    };
    for (const ev of s.env.service.ledger.eventsAfter(0, 100_000).events)
      if (ev.kind.startsWith("hypothesis_"))
        indexEvent(target, {
          at: ev.at,
          actor: ev.actor,
          kind: ev.kind,
          subject: "r-1",
          body: ev.body as Record<string, unknown>,
        });
    assert.match(
      String(items.get(id)?.body),
      /\nStatus: retired\nStatus set by control:owner:ui: out of scope$/,
    );
    assert.doesNotMatch(String(items.get(id)?.body), /Status: in the pool/);
  });

  test("refused in words: the author's, a merged one, an unknown one, another run's mode, and an agent's token", async () => {
    const s = await hypothesisEnv();
    const a = s.research.proposeHypothesis("r-1", "lane-1", { text: "Caches help." });
    const b = s.research.proposeHypothesis("r-1", "lane-1", { text: "Contexts hurt." });
    s.research.reviseHypothesis("r-1", "lane-2", { id: b.hypothesis, text: "caches help" });
    const cases: [unknown, RegExp][] = [
      [
        { run: "r-1", id: s.author, status: "retired", reason: "x" },
        new RegExp(
          `hypothesis ${s.author} is one of the author's: it needs a verdict already, and only the campaign's brief changes it`,
        ),
      ],
      [
        { run: "r-1", id: b.hypothesis, status: "promoted", reason: "x" },
        new RegExp(
          `hypothesis ${b.hypothesis} was merged into ${a.hypothesis}: change ${a.hypothesis} instead`,
        ),
      ],
      [
        { run: "r-1", id: "h-nope", status: "promoted", reason: "x" },
        /no hypothesis h-nope in run r-1/,
      ],
    ];
    for (const [payload, why] of cases) {
      const r = await s.command("hypothesis_status", payload);
      assert.ok(!r.ok);
      assert.match(r.error, why);
    }
    assert.equal(s.events().length, 0, "nothing refused is recorded");
    // Only the owner, or an operator in the owner's name, sends it.
    const agent = await s.command(
      "hypothesis_status",
      { run: "r-1", id: a.hypothesis, status: "promoted", reason: "x" },
      "agent:mcp",
    );
    assert.ok(!agent.ok);
    assert.match(agent.error, /hypothesis_status is the owner's to issue, not agent:mcp's/);
    // A reason is needed: the payload's schema refuses spaces alone.
    const bare = await s.env.service.applyCommand(
      s.env.sign("hypothesis_status", {
        run: "r-1",
        id: a.hypothesis,
        status: "promoted",
        reason: "  ",
      }),
    );
    assert.notEqual((bare as { accepted?: boolean }).accepted, true);
    assert.equal(s.statusOf(a.hypothesis), "pool");
  });

  test("a hill-climb run has no hypotheses to promote", async () => {
    const env = makeHarnessEnv("rig-h");
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const run = (env.service.ledger.db.prepare("select id from run").get() as { id: string }).id;
    assert.ok(hillClimbFixture);
    const r = await env.service.applyCommand(
      env.sign("hypothesis_status", { run, id: "h-1", status: "promoted", reason: "x" }),
    );
    assert.equal((r as { accepted?: boolean }).accepted, false);
    assert.match(
      JSON.stringify(r),
      new RegExp(
        `run ${run} is not a research run: only a research run has hypotheses to promote or retire`,
      ),
    );
  });
});
