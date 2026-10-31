import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { currentAgent, currentBody, currentEvent, eventKinds } from "../../src/core/names.ts";

/** Records written under v0.1.0's names read under the public ones (goal 125, T1). */
describe("the agents' public names", () => {
  test("an agent alone, or naming a writer; other names unchanged", () => {
    assert.equal(currentAgent("combiner"), "merged_by");
    assert.equal(currentAgent("panel"), "review_panel");
    assert.equal(currentAgent("panel:reviewer-2"), "review_panel:reviewer-2");
    for (const name of ["review_panel", "teachers:teacher-1", "panelist", "lane-1", ""])
      assert.equal(currentAgent(name), name);
  });

  test("each kind's field that names an agent; the same event when nothing changes", () => {
    const old = (kind: string, body: Record<string, unknown>) =>
      currentEvent({ id: 1, kind, body }).body;
    assert.deepEqual(old("model_call", { agent: "combiner", model: "m" }), {
      agent: "merged_by",
      model: "m",
    });
    assert.deepEqual(old("advisor_answer", { role: "panel" }), { role: "review_panel" });
    assert.deepEqual(old("agent_message", { to: "panel" }), { to: "review_panel" });
    assert.deepEqual(old("agent_message_read", { by: "panel" }), { by: "review_panel" });
    assert.deepEqual(old("journal_note", { by: "panel:reviewer-1" }), {
      by: "review_panel:reviewer-1",
    });
    // Another kind's field of that name is not an agent's.
    assert.deepEqual(old("review_panel", { result: "panel" }), { result: "panel" });
    const now = { id: 2, kind: "model_call", body: { agent: "workers" } };
    assert.equal(currentEvent(now), now);
  });
});

describe("the old names of kinds and keys", () => {
  test("an old kind and an old key read under the new names", () => {
    const e = currentEvent({ kind: "instance_created", body: { instance: "r-1", unit: "u" } });
    assert.deepEqual(e, { kind: "run_created", body: { run: "r-1", rig: "u" } });
    assert.deepEqual(eventKinds("run_status"), ["run_status", "instance_status"]);
    assert.deepEqual(eventKinds("verdict"), ["verdict"]);
  });

  test("the names every object has are no old names", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      const e = { kind: name, body: { [name]: 1, by: "panel" } };
      assert.equal(currentEvent(e), e);
      assert.equal(currentBody(e.body), e.body);
      assert.equal(currentAgent(name), name);
      assert.deepEqual(eventKinds(name), [name]);
    }
  });
});
