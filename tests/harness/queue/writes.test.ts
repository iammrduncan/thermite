import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { RUN, setup } from "./setup.ts";

/**
 * The advisors' and workers' writes to the queue: the supervisor's route adds and moves with the
 * advisor's role as author, and a worker's idea is proposed by its lane while its trial is open.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

describe("the advisors' and workers' writes", () => {
  test("the supervisor's route adds and moves with the advisor's role as author; other tokens are refused", async () => {
    const s = await setup();
    const api = createHarnessApi(s.env.service, tokens);
    const first = s.q.add(RUN, { title: "first", by: "owner" }, "o");
    const post = (body: unknown, token = tokens.supervisor) =>
      api.request("/v1/queue", {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify(body),
      });
    const r = await post({
      run: RUN,
      role: "teacher",
      add: [
        {
          title: "vector loads",
          family: "memory",
          why: "the profile says reads dominate",
          position: "top",
        },
      ],
      move: [
        { id: first.id, position: "top", why: "it is cheapest" },
        { id: "x-0123456789ab", position: "top", why: "no such" },
      ],
    });
    assert.equal(r.status, 200, await r.clone().text());
    const out = (await r.json()) as { added: string[]; moved: string[]; refused: string[] };
    assert.equal(out.added.length, 1);
    assert.deepEqual(out.moved, [first.id]);
    assert.match(String(out.refused[0]), /move x-0123456789ab: no experiment/);
    assert.deepEqual(
      s.q.queued(RUN).map((x) => [x.title, x.added_by]),
      [
        ["first", "owner"],
        ["vector loads", "teacher"],
      ],
    );
    const added = s.events("experiment_added").at(-1);
    assert.equal(added?.actor, "supervisor:teacher");
    assert.equal((added?.body as { by: string } | undefined)?.by, "teacher");
    const moved = s.events("experiment_moved").at(-1);
    assert.deepEqual(moved?.body, {
      id: first.id,
      by: "teacher",
      position: "top",
      why: "it is cheapest",
    });
    // An auditor's check; a why is required; advisors can't drop; other tokens are refused.
    assert.equal(
      (
        await post({
          run: RUN,
          role: "auditor",
          add: [{ title: "re-measure a-1", family: "check", why: "a doubt" }],
        })
      ).status,
      200,
    );
    assert.equal(
      (await post({ run: RUN, role: "teacher", add: [{ title: "no why" }] })).status,
      400,
    );
    assert.equal((await post({ run: RUN, role: "teacher", drop: [{ id: first.id }] })).status, 400);
    assert.equal((await post({ run: RUN, role: "owner", add: [] })).status, 400);
    assert.equal((await post({ run: RUN, role: "teacher" }, tokens.proposer)).status, 401);
    assert.equal((await post({ run: RUN, role: "teacher" }, "trial.nope")).status, 401);
  });

  test("a worker's idea is proposed by its lane, and only while its trial is open", async () => {
    const s = await setup();
    const api = createHarnessApi(s.env.service, tokens);
    const token = randomBytes(16).toString("hex");
    const registry = new Registry(s.env.service.ledger);
    registry.startTrial({
      id: "t-0123456789abcdef",
      run: RUN,
      lane: "lane-2",
      epoch: 1,
      family: "f",
      parent: s.env.seedCommit,
      token,
    });
    const idea = (body: unknown, t = token) =>
      api.request("/v1/trial/idea", {
        method: "POST",
        headers: auth(`trial.${t}`),
        body: JSON.stringify(body),
      });
    const r = await idea({
      title: "unroll the tail loop",
      why: "the profile shows it",
      family: "unroll",
      run: "other",
    });
    assert.equal(
      r.status,
      400,
      "a worker names nothing but its idea: its trial decides run and lane",
    );
    const ok = await idea({
      title: "unroll the tail loop",
      why: "the profile shows it",
      family: "unroll",
    });
    assert.equal(ok.status, 201, await ok.clone().text());
    const { experiment } = (await ok.json()) as { experiment: string };
    const x = s.q.get(experiment);
    assert.equal(x?.state, "proposed");
    assert.equal(x?.added_by, "lane-2");
    assert.equal(x?.run, RUN);
    const e = s.events("experiment_added").at(-1);
    assert.equal(e?.actor, "lane-2");
    assert.deepEqual(e?.body, {
      id: experiment,
      title: "unroll the tail loop",
      family: "unroll",
      why: "the profile shows it",
      by: "lane-2",
      state: "proposed",
      trial: "t-0123456789abcdef",
    });
    assert.equal((await idea({ title: "a second idea" })).status, 201);
    assert.equal((await idea({ title: "" })).status, 400, "an idea needs a title");
    registry.finishTrial(
      "t-0123456789abcdef",
      { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 },
      "s",
    );
    assert.equal(
      (await idea({ title: "after the end" })).status,
      409,
      "a trial that ended proposes nothing",
    );
    assert.equal((await idea({ title: "x" }, "unknown")).status, 401);
    assert.deepEqual(
      s.q.proposed(RUN).map((p) => p.title),
      ["unroll the tail loop", "a second idea"],
    );
  });
});
