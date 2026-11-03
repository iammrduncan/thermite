/**
 * What the tests of the scheduler's queue share: a hill climb with a fake planner, a signed
 * command, and the ledger's events.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { type CommandKind, signEnvelope } from "../../../../../src/core/commands.ts";
import { Scheduler } from "../../../../../src/harness/agents/scheduler/index.ts";
import type { TrialResult, TrialSpec } from "../../../../../src/harness/agents/worker/index.ts";
import { LocalRunner } from "../../../../../src/harness/broker/runner.ts";
import type { LedgerEvent } from "../../../../../src/harness/ledger/rows.ts";
import { briefText } from "../../../../helpers/brief-text.ts";
import { startFakeModel } from "../../../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../../../helpers/judge-env.ts";

export type Env = ReturnType<typeof makeJudgeEnv>;
export const RUN = "js-1";

export async function command(env: Env, kind: CommandKind, payload: unknown) {
  const out = await env.service.applyCommand(
    signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-a",
        kind,
        issued_by: "owner:ui",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload,
      },
      env.keys.privateKeyPem,
    ),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  return (out as { result: Record<string, unknown> }).result;
}

export const events = (env: { service: { ledger: Env["ledger"] } }, kind: string): LedgerEvent[] =>
  env.service.ledger.eventsAfter(0, 100_000).events.filter((e) => e.kind === kind);
export const body = (e: LedgerEvent | undefined) => (e?.body ?? {}) as Record<string, unknown>;

/**
 * A hill climb with `lanes` lanes, one trial each per round, run side by side. The planner is
 * off unless `planner` answers (its answer for each call); trials record their brief and end
 * without a submission, or wait to be stopped.
 */
export async function setup(
  t: TestContext,
  o: {
    lanes?: number;
    perEpoch?: number;
    planner?: ((prompt: string, call: number) => unknown) | undefined;
    trial?: ((spec: TrialSpec, signal: AbortSignal) => Promise<TrialResult>) | undefined;
  } = {},
) {
  const env = makeJudgeEnv({ lanes: { count: o.lanes ?? 2, trials_per_epoch: o.perEpoch ?? 1 } });
  await env.start();
  const prompts: string[] = [];
  const fake = await startFakeModel(({ messages, tools }) => {
    if (!tools.some((x) => x.function.name === "submit_plan")) return { text: "done" };
    const prompt = JSON.stringify(messages);
    prompts.push(prompt);
    return { toolCalls: [{ name: "submit_plan", args: o.planner?.(prompt, prompts.length) }] };
  });
  t.after(() => fake.close());
  const briefs: Record<string, string[]> = {};
  const scheduler = new Scheduler({
    service: env.service,
    runner: new LocalRunner(env.paths.scratchDir),
    model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
    owner: "scheduler-test",
    plannerOn: () => o.planner !== undefined,
    maxConcurrent: o.lanes ?? 2,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    runTrial:
      o.trial ??
      (async (spec) => {
        briefs[spec.lane] = [...(briefs[spec.lane] ?? []), briefText(spec.brief)];
        return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      }),
  });
  /** One round: planned, its trials run to their end, and the round ended. */
  const round = async () => {
    assert.ok(await scheduler.tick(), "trials started");
    await scheduler.idle();
    await scheduler.tick();
  };
  const add = async (title: string, more: Record<string, unknown> = {}) =>
    String((await command(env, "queue_add", { run: RUN, title, ...more })).experiment);
  /** Each lane's experiment, by title, as the assignments recorded it. */
  const given = () =>
    events(env, "experiment_assigned").map((e) => {
      const b = body(e);
      return `${b.lane}:${env.service.queue.get(String(b.id))?.title}`;
    });
  return { env, scheduler, prompts, briefs, round, add, given, q: env.service.queue };
}
