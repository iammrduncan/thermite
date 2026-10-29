import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseContract } from "../../../src/core/contract.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { researchFixture } from "../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/**
 * A running trial's session on its own route (`POST /v1/trial/live`): its lines from any of its
 * processes, and its counters and its waits for the provider only from a worker that reports its
 * own session (Pi's). For OpenCode, Claude Code and Codex the harness reads them from the
 * program's output.
 */
describe("a trial's counters and waits on its route", () => {
  test("only a worker that reports its own session sends them, and a wait holds its run one trial at most", async (t) => {
    const env = makeHarnessEnv("rig-l");
    t.after(() => env.service.ledger.close());
    const parsed = parseContract(researchFixture);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const out = await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    new Registry(env.service.ledger).startTrial({
      id: "t-1",
      run: "r-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: "p",
      token: "tok-1",
    });
    const api = createHarnessApi(env.service, { supervisor: "s" });
    const post = async (body: object) => {
      const r = await api.request("/v1/trial/live", {
        method: "POST",
        headers: { authorization: "Bearer trial.tok-1", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, text: await r.text() };
    };
    const progress = { turns: 1, tool_calls: 2, tokens_in: 3, tokens_out: 4 };
    const far = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const wait = { until: far, kind: "rate_limit", words: "429 try again later" };
    const holds = () =>
      env.service.ledger.db
        .prepare("select body from event where kind = 'agents_wait_for_limit'")
        .all()
        .map((e) => JSON.parse(String(e.body)) as { until: string });

    // A command-line program's trial: its lines go in; its counters and waits are refused.
    assert.equal((await post({ entries: [{ kind: "text", text: "working" }] })).status, 200);
    const refused = await post({ entries: [], progress });
    assert.equal(refused.status, 409);
    assert.match(refused.text, /this trial's counters and waits come from the harness/);
    assert.equal((await post({ entries: [], wait })).status, 409);
    assert.equal(env.service.ledger.trials.get("t-1")?.turns, null);
    assert.deepEqual(holds(), []);

    // A Pi worker's trial, while its worker reports its own session.
    const close = env.service.reportsOwnSession("t-1");
    assert.equal((await post({ entries: [], progress })).status, 200);
    assert.equal(env.service.ledger.trials.get("t-1")?.turns, 1);
    assert.equal((await post({ entries: [], wait })).status, 200);
    // A month away asked; at most a day held, the longest a trial may be set to last.
    const held = Date.parse(holds()[0]?.until ?? "") - Date.now();
    assert.ok(held > 23.9 * 3_600_000 && held <= 24 * 3_600_000, `about a day (${held} ms)`);
    close();
    assert.equal((await post({ entries: [], progress })).status, 409, "not once it ends");
  });
});
