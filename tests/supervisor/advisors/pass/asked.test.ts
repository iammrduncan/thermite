import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { teachersRoundRefusal } from "../../../../src/core/agents.ts";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import { AdvisorsConfig } from "../../../../src/supervisor/advisors/index.ts";
import {
  type AdviseConfig,
  type AdviseState,
  adviseOnce,
  emptyAdviseState,
  teachersCalled,
} from "../../../../src/supervisor/advisors/pass/index.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

/**
 * Goal 194 (issue 53): the owner asks a running run's teachers for a round now. The rig's harness
 * records the request, or refuses it for a run that is not running; the supervisor starts one
 * round for each request, off the clock, and the next timed round counts from it. At the day's
 * spending limit the request waits, said once.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
type Env = ReturnType<typeof makeJudgeEnv>;

function config(env: Env, advisors: AdvisorsConfig, lines: string[]): AdviseConfig {
  const api = createHarnessApi(env.service, tokens);
  return {
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
    advisors,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      return api.request(`${url.pathname}${url.search}`, init as RequestInit);
    },
    live: (l) => lines.push(`${l.run ?? "-"} ${l.kind}: ${l.text}`),
  };
}

function runtime(url: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
  writeFileSync(join(dir, "key"), "test-key\n");
  return { name, runtime: "openai", base_url: url, model: name, api_key_file: join(dir, "key") };
}

const events = (env: Env, kind: string) =>
  env.ledger.eventsAfter(0, 5000).events.filter((e) => e.kind === kind);

const ask = (env: Env) =>
  env.service.applyCommand(env.sign("start_teachers_round", { run: "js-1" }));

describe("a teachers' round on request (goal 194)", () => {
  test("the rig records a request for a running run and refuses one for a paused run", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const r = await ask(env);
    assert.ok(r.status === "applied" && r.accepted, JSON.stringify(r));
    const [asked] = events(env, "teachers_round_requested");
    assert.ok(asked);
    assert.equal(asked.subject, "js-1");
    assert.deepEqual(r.result, { run: "js-1", asked: true, event: asked.id });
    await env.service.applyCommand(env.sign("pause_run", { run: "js-1", reason: "a look" }));
    const paused = await ask(env);
    assert.ok(paused.status === "applied" && !paused.accepted);
    assert.deepEqual(paused.result, {
      error: "js-1 is paused: resume it first, and its teachers review it at their next round.",
    });
    assert.equal(events(env, "teachers_round_requested").length, 1);
    assert.equal(
      teachersRoundRefusal("js-1", "closed"),
      "js-1 is closed: its teachers review only a running run.",
    );
    assert.equal(teachersRoundRefusal("js-1", "running"), "");
  });

  test("each request starts one round off the clock, and the next timed one counts from it", async (t: TestContext) => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    let briefs = 0;
    const fake = await startFakeModel(() => {
      briefs++;
      return { toolCalls: [{ name: "answer", args: { summary: "s", portfolio: [] } }] };
    });
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({ teachers: [runtime(fake.url, "teacher-a")] });
    const lines: string[] = [];
    const cfg = config(env, advisors, lines);
    // A round ran a minute ago: the clock says wait an hour.
    const before = new Date(Date.now() - 60_000).toISOString();
    let state: AdviseState = { ...emptyAdviseState(), lastTeacherAt: { "js-1": before } };
    assert.equal(await teachersCalled(cfg, state), false);
    state = await adviseOnce(cfg, state);
    assert.equal(briefs, 0, "on the clock: no round yet");
    await ask(env);
    assert.equal(await teachersCalled(cfg, state), true);
    state = await adviseOnce(cfg, state);
    assert.equal(briefs, 1);
    assert.match(
      lines.join("\n"),
      /js-1 status: the teachers review js-1 now: the owner asked for a round/,
    );
    assert.ok(
      Date.parse(state.lastTeacherAt["js-1"] ?? "") > Date.parse(before),
      "the clock starts again",
    );
    // One request, one round.
    assert.equal(await teachersCalled(cfg, state), false);
    state = await adviseOnce(cfg, state);
    assert.equal(briefs, 1);
    // Another request starts another.
    await ask(env);
    assert.equal(await teachersCalled(cfg, state), true);
    state = await adviseOnce(cfg, state);
    assert.equal(briefs, 2);
  });

  test("at the day's spending limit a request starts no round, and says so once", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    await ask(env);
    const advisors = AdvisorsConfig.parse({
      teachers: [runtime("http://127.0.0.1:9", "teacher-a")],
      max_usd_per_day: 1,
    });
    const state = {
      ...emptyAdviseState(),
      spend: { day: new Date().toISOString().slice(0, 10), usd: 1 },
    };
    const lines: string[] = [];
    assert.equal(await teachersCalled(config(env, advisors, lines), state), false);
    let next = await adviseOnce(config(env, advisors, lines), state);
    next = await adviseOnce(config(env, advisors, lines), next);
    assert.equal(next.stats.teacher_runs, 0);
    assert.deepEqual(lines, [
      "js-1 status: the advisors reached the day's spending limit (1 USD): the teachers review js-1 after midnight UTC",
    ]);
  });
});
