import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ModelConfig } from "../../../../src/agents/model/index.ts";
import { promptRecord } from "../../../../src/agents/prompt.ts";
import { renderPlannerTurn } from "../../../../src/agents/roles/index.ts";
import { type CommandKind, signEnvelope } from "../../../../src/core/commands.ts";
import { plannerCallId } from "../../../../src/core/terminal-input.ts";
import { callUsage, MODEL_CALL_EVENT } from "../../../../src/core/usage.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { Compactions } from "../../../../src/harness/compactions.ts";
import { ResearchFolder } from "../../../../src/harness/research/folder.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

/**
 * A planner in Pi on a rig whose agents run in their own terminal runs in a process of its own,
 * in its Pi view (goal 169). The scheduler hands planInView its call, with a credential bound to
 * it; the process reaches the harness's routes with that credential for its session (its lines,
 * the owner's messages, its later turns, its usage, its compactions) and gives its answer at the
 * planner's route. Here a stand-in for the process does over HTTP what planner-main.ts does.
 */

type Env = ReturnType<typeof makeJudgeEnv>;

const workers: ModelConfig = {
  baseUrl: "http://127.0.0.1:9/v1",
  model: "workers-model",
  apiKey: "workers-key",
  contextWindow: 0,
  maxTokens: 0,
};

const PLAN = {
  new_families: [{ id: "tidy", description: "Small tidy-ups." }],
  assignments: [{ lane: "lane-1", family: "tidy", focus: "tidy the kernel", parent: "champion" }],
  notes: "planned in its Pi view",
};

async function command(env: Env, kind: CommandKind, payload: unknown) {
  const out = await env.service.applyCommand(
    signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-a",
        kind,
        issued_by: "owner",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload,
      },
      env.keys.privateKeyPem,
    ),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
}

describe("the planner in Pi in its Pi view", () => {
  test("its process plans over its call's routes, and the owner's message it took during its call is read by its round", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
    env.service.compactions = new Compactions({
      ledger: env.service.ledger,
      live: env.service.live,
      folder: new ResearchFolder({
        ledger: env.service.ledger,
        scratchRoot: join(env.paths.scratchDir, "research"),
        stateRoot: join(env.paths.stateDir, "research-work"),
        runner: new LocalRunner(env.paths.scratchDir),
      }),
    });
    const api = createHarnessApi(env.service, { supervisor: "s" });
    const seen: Record<string, unknown> = {};
    let auth = "";
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: workers,
      owner: "planner-view-test",
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      planInView: async (c, sent, spec) => {
        auth = c.link.auth;
        Object.assign(seen, {
          id: c.link.id,
          program: sent.program,
          role: sent.role,
          spec: spec.id,
          heading: c.heading,
          model: c.model.model,
        });
        const call = async (method: string, path: string, body?: unknown) => {
          const r = await api.request(path, {
            method,
            headers: { authorization: `Bearer ${c.link.auth}`, "content-type": "application/json" },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
          return { status: r.status, body: (await r.json()) as Record<string, unknown> };
        };
        seen.live = (
          await call("POST", "/v1/trial/live", {
            entries: [{ kind: "text", text: "reading the queue" }],
          })
        ).status;
        // The owner writes to the planner while it plans; its process takes the message in
        // before its next model call, and says so.
        await command(env, "message_agent", { run: "js-1", to: "planner", text: "spread wider" });
        const waiting = (await call("GET", "/v1/trial/messages")).body.messages as {
          id: number;
          text: string;
        }[];
        seen.waiting = waiting.map((m) => m.text);
        seen.read = (
          await call("POST", "/v1/trial/messages/read", {
            ids: waiting.map((m) => m.id),
          })
        ).status;
        const later = promptRecord(
          renderPlannerTurn({
            program: "pi",
            turn: 1,
            kind: "owner",
            id: waiting[0]?.id,
            text: "spread wider",
          }),
          {},
        );
        seen.kept = (
          await call("POST", "/v1/trial/prompt", {
            role: later.role,
            program: later.program,
            turn: later.turn,
            sections: later.sections,
          })
        ).status;
        seen.usage = (
          await call("POST", "/v1/trial/usage", {
            calls: [callUsage({ at: Date.now(), tokensIn: 120, tokensOut: 30 })],
          })
        ).status;
        seen.snapshot = (
          await call("POST", "/v1/trial/snapshot", {
            number: 1,
            markdown: "# The planner's conversation before compaction 1",
          })
        ).status;
        seen.answer = (await call("POST", "/v1/planner/answer", { plan: PLAN })).status;
        const a = c.answer();
        return a && "plan" in a ? a.plan : undefined;
      },
    });
    await scheduler.tick();
    await scheduler.idle();
    assert.deepEqual(seen, {
      id: plannerCallId("js-1", 1),
      program: "pi",
      role: "planner",
      spec: "plan",
      heading: "Thermite's view of the planner in Pi · run js-1 · round 1 · workers-model",
      model: "workers-model",
      live: 200,
      waiting: ["spread wider"],
      read: 200,
      kept: 201,
      usage: 201,
      snapshot: 201,
      answer: 200,
    });
    const epoch = env.ledger.db.prepare("select source from epoch where n = 1").get() as {
      source: string;
    };
    assert.equal(epoch.source, "planner", "its answer was checked and used");
    const events = env.ledger.eventsAfter(0, 10_000).events as {
      kind: string;
      body: Record<string, unknown>;
    }[];
    const read = events.find((e) => e.kind === "agent_message_read");
    assert.deepEqual(
      { by: read?.body.by, how: read?.body.how, round: read?.body.round },
      { by: "planner", how: "next-call", round: 1 },
    );
    const prompt = env.ledger.db
      .prepare("select call, lane, trial from prompt where turn = 1")
      .get() as { call: string; lane: string | null; trial: string | null };
    assert.deepEqual({ ...prompt }, { call: "epoch 1", lane: null, trial: null });
    const usage = events
      .filter((e) => e.kind === MODEL_CALL_EVENT)
      .map((e) => ({
        agent: e.body.agent,
        round: e.body.round,
        trial: e.body.trial,
        tokens_in: e.body.tokens_in,
      }));
    assert.deepEqual(usage, [{ agent: "planner", round: "epoch 1", trial: null, tokens_in: 120 }]);
    const lines = env.service.live
      .since(0)
      .entries.filter((l) => l.source === "planner")
      .map((l) => l.text);
    assert.ok(lines.includes("reading the queue"), lines.join("\n"));
    // The call has ended: its credential no longer works.
    assert.equal(env.service.callOf(auth), undefined);
  });
});
