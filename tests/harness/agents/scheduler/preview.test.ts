import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { messageText, systemText } from "../../../../src/agents/prompt.ts";
import { BRIEF_FILE } from "../../../../src/core/brief.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

const auth = { authorization: "Bearer sup" };

test("a role's next prompt is previewed on the rig with no side effect (goal 166)", async () => {
  const env = makeJudgeEnv({
    lanes: { count: 1, trials_per_epoch: 1 },
    contract: { notes: "The kernel sums an array of numbers." },
  });
  await env.start();
  const run = (env.assign.envelope.payload as { run: string }).run;
  const command = (kind: Parameters<typeof env.sign>[0], payload: unknown) =>
    env.service.applyCommand(env.sign(kind, payload));
  await command("message_agent", { run, to: "all", text: "Prefer a change a reader can follow." });
  await command("queue_add", { run, title: "Unroll the loop by four", family: "loops", why: "w" });
  const api = createHarnessApi(env.service, { supervisor: "sup" });
  const preview = (q: string) =>
    api.request(`/v1/runs/${run}/prompt-preview?${q}`, { headers: auth });

  // A rig with no scheduler renders none, and says why.
  assert.equal((await preview("role=worker")).status, 409);
  const scheduler = new Scheduler({
    service: env.service,
    runner: new LocalRunner(env.paths.scratchDir),
    model: {
      baseUrl: "http://127.0.0.1:9",
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 0,
    },
    owner: "preview-test",
    runTrial: async () => ({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
  });
  env.service.promptPreview = (r, ask) => scheduler.preview(r, ask);

  const worker = scheduler.preview(run, { role: "worker", lane: "lane-1" });
  assert.equal(worker.role, "worker");
  assert.equal(worker.program, "pi");
  assert.match(messageText(worker), /# Assignment \(epoch 1, trial 1 of 1, lane-1\)/);
  assert.match(messageText(worker), /Focus: Unroll the loop by four/);
  assert.match(messageText(worker), /# Messages from the campaign's owner\n- Prefer a change/);
  assert.ok(systemText(worker).startsWith("You are a research worker"));
  // Nothing kept, no message given, no file written.
  assert.deepEqual(env.service.ledger.prompts.list(run), []);
  assert.equal(env.service.ledger.events.newest("agent_message_read", {}), undefined);
  assert.ok(!existsSync(join(env.service.knowledge.folder(run), BRIEF_FILE)));

  const planner = scheduler.preview(run, { role: "planner" });
  assert.equal(planner.role, "planner");
  assert.match(messageText(planner), /"queue":/);
  assert.equal(env.service.ledger.events.newest("agent_message_read", {}), undefined);

  // Over the rig's API, with the supervisor's token: the sections and their sources.
  const r = await preview("role=worker&lane=lane-1");
  assert.equal(r.status, 200);
  const body = (await r.json()) as { role: string; sections: { id: string; source: string }[] };
  assert.equal(body.role, "worker");
  assert.ok(body.sections.some((s) => s.id === "owner-waiting" && s.source === "owner"));
  assert.equal((await preview("role=teacher")).status, 400);
  assert.equal(
    (await api.request(`/v1/runs/${run}/prompt-preview?role=worker`)).status,
    401,
    "the supervisor's token only",
  );
  await scheduler.shutdown("test over");
});
