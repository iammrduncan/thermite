import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { LedgerError, type SourceRow } from "../../../src/harness/ledger/index.ts";
import { sourceText } from "../../../src/harness/research/research/context.ts";
import { researchEnv } from "../../helpers/research-run.ts";

describe("research API", () => {
  test("a worker's calls go to its own trial's run and lane, whatever it asks", async () => {
    const { env, research } = await researchEnv();
    const registry = new Registry(env.service.ledger);
    registry.startTrial({
      id: "t-1",
      run: "r-1",
      lane: "lane-1",
      epoch: 1,
      family: "explore",
      parent: "research",
      token: "secret-token",
    });
    const api = createHarnessApi(env.service, { supervisor: "s", proposer: "p" }, { research });
    const call = (token: string, body: unknown) =>
      api.request("/v1/research/section", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = await call("trial.secret-token", {
      run: "someone-else",
      lane: "owner",
      name: "summary",
      body: "text",
    });
    assert.equal(ok.status, 200);
    const row = env.service.ledger.db.prepare("select run, updated_by from report_section").get();
    assert.deepEqual({ ...row }, { run: "r-1", updated_by: "lane-1" });
    assert.equal((await call("trial.wrong", { name: "x", body: "y" })).status, 401);
    assert.equal((await call("p", { name: "x", body: "y" })).status, 401);
    registry.finishTrial(
      "t-1",
      { stopped: "finished", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 },
      "t",
    );
    assert.equal((await call("trial.secret-token", { name: "x", body: "y" })).status, 409);
  });

  test("a fault answers an id only, and a source whose text is gone names only the source", async () => {
    const { env } = await researchEnv();
    env.service.snapshot = () => {
      throw new Error("ENOENT: no such file, open '/var/lib/thermite/state/ledger.db'");
    };
    const api = createHarnessApi(env.service, { supervisor: "s", proposer: "p" });
    const r = await api.request("/v1/snapshot", { headers: { authorization: "Bearer s" } });
    assert.equal(r.status, 500);
    assert.match(((await r.json()) as { error: string }).error, /^internal error [0-9a-f]{8}$/);
    const gone = { id: "s-1", text_path: "/var/lib/thermite/state/research/s-1.txt" };
    assert.throws(
      () => sourceText(gone as SourceRow),
      (err: unknown) =>
        err instanceof LedgerError &&
        err.code === "not_found" &&
        err.message === "the text of source s-1 can't be read on this rig",
    );
  });
});
