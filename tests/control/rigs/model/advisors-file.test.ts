import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { advisorsFileOf } from "../../../../src/control/rigs/model.ts";
import { mcpClient } from "../../../helpers/control-stack.ts";
import { figuresCall } from "../../../helpers/control-store.ts";
import { stack, TOKENS, text } from "./stack.ts";

/**
 * The rig's advisors file, as its supervisor reports it (goal 074): control reads the new field,
 * treats it as absent from an older supervisor, and gives it in rig_models and its REST twin.
 */

describe("the advisors file, as control reads it from the supervisor", () => {
  const STATS = {
    teacher_runs: 0,
    directive_sets: 0,
    directives: 0,
    audits: 0,
    reviews: 0,
    errors: 0,
    tokens_in: 0,
    tokens_out: 0,
    usd: 0,
  };
  const ROLES = { teachers: 1, merged_by: false, auditor: true, review_panel: 0 };
  const AUDITOR = {
    harness: "claude-code",
    model: "opus-5.5",
    provider: null,
    api: "claude",
    context_window: 200_000,
    compact_at: null,
  };
  const FILE = {
    teachers: [{ ...AUDITOR, harness: "pi", model: "model-a", api: "openai", compact_at: 70 }],
    merged_by: null,
    auditor: AUDITOR,
    review_panel: [],
  };

  test("old supervisor and new: the field, none (null advisors), or not reported", () => {
    assert.equal(advisorsFileOf(null), undefined, "no report yet");
    assert.equal(advisorsFileOf({ at: "now" }), undefined, "a report with no advisors field");
    assert.equal(
      advisorsFileOf({ advisors: { ...STATS, roles: ROLES } }),
      undefined,
      "an older supervisor: roles only",
    );
    assert.deepEqual(
      advisorsFileOf({ advisors: null }),
      { teachers: [], merged_by: null, auditor: null, review_panel: [] },
      "no advisors at all: none in the file",
    );
    assert.deepEqual(advisorsFileOf({ advisors: { ...STATS, roles: ROLES, file: FILE } }), FILE);
    // A field this control does not know is dropped; a malformed file is not reported.
    const newer = { ...FILE, auditor: { ...AUDITOR, later: "a newer field" }, later: 1 };
    assert.deepEqual(advisorsFileOf({ advisors: { file: newer } }), FILE);
    assert.equal(advisorsFileOf({ advisors: { file: { teachers: "x" } } }), undefined);
  });

  test("the supervisor's report keeps it; rig_models and GET /v1/rigs/<rig>/model give it", async () => {
    const s = await stack();
    const report = (advisors: unknown) =>
      figuresCall(s.store, "rig-a", { at: new Date().toISOString(), advisors });
    const read = async () => (await (await s.owner("GET")).json()) as Record<string, unknown>;
    // Not reported yet.
    assert.equal((await read()).advisors_file, null);
    // An older supervisor: its roles, and no file.
    assert.equal((await report({ ...STATS, roles: ROLES })).status, 200);
    assert.equal((await read()).advisors_file, null);
    // A new one.
    assert.equal((await report({ ...STATS, roles: ROLES, file: FILE })).status, 200);
    assert.deepEqual((await read()).advisors_file, FILE);
    const mcp = await mcpClient(s.api, TOKENS.read);
    const seen = text(await mcp.callTool({ name: "rig_models", arguments: { rig: "rig-a" } }));
    assert.deepEqual(seen.advisors_file, FILE);
    await mcp.close();
    // A malformed file drops the file, not the report: the other figures are kept.
    const bad = await report({ ...STATS, audits: 3, roles: ROLES, file: { teachers: "x" } });
    assert.equal(bad.status, 200);
    assert.equal((await read()).advisors_file, null);
    assert.equal(
      (s.store.reportedRigs.supervisor("rig-a")?.advisors as { audits?: number } | undefined)
        ?.audits,
      3,
    );
    // No advisors at all.
    assert.equal((await report(null)).status, 200);
    assert.deepEqual((await read()).advisors_file, {
      teachers: [],
      merged_by: null,
      auditor: null,
      review_panel: [],
    });
  });
});
