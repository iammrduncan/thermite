import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { messageText, promptRecord, systemText } from "../../../src/agents/prompt.ts";
import { renderAuditor, renderWorker, renderWorkerTurn } from "../../../src/agents/roles/index.ts";
import { laneLimits } from "../../../src/core/contract.ts";
import { PROMPT_EVENT_TEXT_CHARS, partText } from "../../../src/core/prompts.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { PROMPTS_FILE } from "../../../src/harness/outbox.ts";
import { exportForSupervisor } from "../../../src/harness/service/reports.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

const RUN = "smoke-1";
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

async function setup() {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  return { env, api: createHarnessApi(env.service, { supervisor: "sup" }) };
}

/** A worker's prompt in Pi, as a trial on lane-1 would be sent it. */
const workerPrompt = (brief: string) =>
  renderWorker({
    program: { id: "pi", name: "Pi", turnWords: "each model reply is one" },
    brief,
    mcpServers: [],
    limits: laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }),
    editablePaths: ["src/**"],
    minutes: 30,
    endsAt: Date.parse("2026-10-28T12:00:00Z"),
  });

describe("the prompts a run's agents were sent (goal 166)", () => {
  test("a prompt is kept whole and compressed, and its event gives its sections and sources", async () => {
    const { env } = await setup();
    const sent = workerPrompt(
      "# Assignment (epoch 1, trial 1 of 1, lane-1)\nFocus: unroll the loop",
    );
    const id = env.service.ledger.prompts.record(
      "harness",
      RUN,
      promptRecord(sent, { lane: "lane-1", trial: "t-1" }),
    );
    const kept = env.service.ledger.prompts.get(id);
    assert.ok(kept);
    // The text sent, byte for byte, from what is kept.
    assert.equal(partText(kept.sections, "system"), systemText(sent));
    assert.equal(partText(kept.sections, "message"), messageText(sent));
    assert.ok(kept.bytes > 0 && kept.bytes < kept.chars, "compressed");
    assert.deepEqual(
      env.service.ledger.prompts.list(RUN).map((p) => [p.id, p.role, p.program, p.lane, p.trial]),
      [[id, "worker", "pi", "lane-1", "t-1"]],
    );
    const event = env.service.ledger.events.newest("agent_prompt", { subject: RUN });
    assert.ok(event);
    assert.equal(event.run, RUN);
    const body = event.body;
    assert.equal(body.id, id);
    assert.equal(body.chars, systemText(sent).length + messageText(sent).length);
    assert.match(body.version, /^[0-9a-f]{12}$/);
    // A fixed text of the role's definition is named by its sha256, never sent to control; what
    // the run added is.
    const instructions = body.sections.find((s) => s.id === "instructions");
    assert.equal(instructions?.source, "role");
    assert.equal(instructions?.text, undefined);
    const brief = body.sections.find((s) => s.id === "brief");
    assert.deepEqual([brief?.source, brief?.part], ["assignment", "message"]);
    assert.match(String(brief?.text), /unroll the loop/);
    // The same role's text gives the same version, whatever the run added.
    const again = env.service.ledger.prompts.record(
      "harness",
      RUN,
      promptRecord(workerPrompt("another brief"), {}),
    );
    const second = env.service.ledger.events.newest("agent_prompt", { subject: RUN });
    assert.equal(second?.body.id, again);
    assert.equal(second?.body.version, body.version);
  });

  test("an event carries the run's text up to its limit, and says where it was cut", async () => {
    const { env } = await setup();
    const big = "x".repeat(PROMPT_EVENT_TEXT_CHARS + 500);
    env.service.ledger.prompts.record("harness", RUN, promptRecord(workerPrompt(big), {}));
    const body = env.service.ledger.events.newest("agent_prompt", { subject: RUN })?.body;
    const brief = body?.sections.find((s) => s.id === "brief");
    assert.equal(brief?.text?.length, PROMPT_EVENT_TEXT_CHARS);
    assert.equal(brief?.cut, true);
    assert.equal(brief?.chars, big.length);
    // Past the limit, a section of the run's carries no text, and says it is cut.
    const budget = body?.sections.find((s) => s.id === "budget");
    assert.deepEqual([budget?.text, budget?.cut], ["", true]);
    // The ledger keeps it whole.
    const kept = env.service.ledger.prompts.get(Number(body?.id));
    assert.match(partText(kept?.sections ?? [], "message"), new RegExp(`x{${big.length}}`));
  });

  test("the supervisor keeps an advisor's prompt; a worker's is the harness's own", async () => {
    const { api } = await setup();
    const auditor = promptRecord(
      renderAuditor({ pkg: { diff: "d" } }, { program: "pi", mcpServers: [] }),
      { call: "audit a-1" },
    );
    const post = (body: unknown, token = "sup") =>
      api.request("/v1/prompts", {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify(body),
      });
    assert.equal((await post({ run: RUN, ...auditor }, "nope")).status, 401);
    const kept = await post({ run: RUN, ...auditor });
    assert.equal(kept.status, 201);
    const { id } = (await kept.json()) as { id: number };
    // A worker's prompt is never the supervisor's to keep.
    const worker = promptRecord(workerPrompt("b"), {});
    assert.equal((await post({ run: RUN, ...worker })).status, 400);
    assert.equal((await post({ run: "no-run", ...auditor })).status, 404);
    const list = (await (
      await api.request(`/v1/runs/${RUN}/prompts`, { headers: auth("sup") })
    ).json()) as { prompts: { id: number; role: string; call: string }[] };
    assert.deepEqual(
      list.prompts.map((p) => [p.id, p.role, p.call]),
      [[id, "auditor", "audit a-1"]],
    );
    const one = await api.request(`/v1/runs/${RUN}/prompts/${id}`, { headers: auth("sup") });
    const whole = (await one.json()) as { sections: { id: string; text: string }[] };
    assert.match(whole.sections.find((s) => s.id === "package")?.text ?? "", /Audit package/);
    assert.equal(
      (await api.request(`/v1/runs/other/prompts/${id}`, { headers: auth("sup") })).status,
      404,
    );
  });

  test("a Pi worker keeps a later turn with its trial's token: the trial decides the run, the lane and the trial", async () => {
    const { env, api } = await setup();
    new Registry(env.service.ledger).startTrial({
      id: "t-later",
      run: RUN,
      lane: "lane-2",
      epoch: 1,
      family: "f",
      parent: env.seedCommit,
      token: "tok-later",
    });
    const nudge = renderWorkerTurn({ program: "pi", turn: 2, kind: "nudge" });
    const { role, program, turn, sections } = promptRecord(nudge, {});
    const post = (body: unknown, token = "tok-later") =>
      api.request("/v1/trial/prompt", {
        method: "POST",
        headers: auth(`trial.${token}`),
        body: JSON.stringify(body),
      });
    const kept = await post({ role, program, turn, sections });
    assert.equal(kept.status, 201, await kept.clone().text());
    const { id } = (await kept.json()) as { id: number };
    const p = env.service.ledger.prompts.get(id);
    assert.deepEqual(
      [p?.role, p?.program, p?.turn, p?.lane, p?.trial, p?.call],
      ["worker", "pi", 2, "lane-2", "t-later", null],
    );
    assert.equal(partText(p?.sections ?? [], "message"), messageText(nudge));
    assert.equal(env.service.ledger.events.newest("agent_prompt", { subject: RUN })?.body.turn, 2);
    // Only a later turn of a worker's, and only with a trial's own token.
    assert.equal((await post({ role, program, turn: 0, sections })).status, 400);
    assert.equal((await post({ role: "planner", program, turn, sections })).status, 400);
    assert.equal((await post({ role, program, turn, sections, run: "other" })).status, 400);
    assert.equal((await post({ role, program, turn, sections }, "nope")).status, 401);
  });

  test("a run's export holds the prompts its agents were sent, whole", async () => {
    const { env } = await setup();
    const sent = workerPrompt("# Assignment\nFocus: one change");
    env.service.ledger.prompts.record("harness", RUN, promptRecord(sent, { trial: "t-1" }));
    const r = await exportForSupervisor(env.service, "test", { run: RUN });
    const file = join(r.dir, PROMPTS_FILE);
    assert.ok(existsSync(file));
    const lines = gunzipSync(readFileSync(file)).toString("utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const p = JSON.parse(lines[0] as string) as { role: string; sections: never[] };
    assert.equal(p.role, "worker");
    assert.equal(partText(p.sections, "message"), messageText(sent));
    // Nothing is written in the run's research folder, which the workers read.
    const folder = env.service.knowledge.folder(RUN);
    assert.ok(!existsSync(join(folder, PROMPTS_FILE)));
  });
});
