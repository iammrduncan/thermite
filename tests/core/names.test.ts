import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  bodyKeys,
  currentAgent,
  currentBody,
  currentCommand,
  currentContract,
  currentEvent,
  currentNoteKind,
  currentRule,
  eventKinds,
  oldCommandKeys,
  oldContractKeyError,
  oldRuleKeys,
} from "../../src/core/names.ts";

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

/** The public names of v0.1.1 (the guide's questions 11 and 23), read from older records. */
describe("directions, the kinds of notes and rules, source notes and a run's note", () => {
  const read = (kind: string, body: Record<string, unknown>) => currentEvent({ kind, body });

  test("an approach family's events, keys and records read as a direction", () => {
    assert.deepEqual(read("family_added", { family: "tiling", description: "d" }), {
      kind: "direction_added",
      body: { direction: "tiling", description: "d" },
    });
    assert.deepEqual(
      read("family_status", { family: "tiling", status: "exhausted" }).kind,
      "direction_status",
    );
    assert.deepEqual(read("trial_started", { trial: "t", family: "tiling" }).body, {
      trial: "t",
      direction: "tiling",
    });
    assert.deepEqual(
      read("epoch_started", { n: 1, assignments: [{ lane: "lane-1", family: "f" }] }).body,
      {
        n: 1,
        assignments: [{ lane: "lane-1", direction: "f" }],
      },
    );
    assert.deepEqual(
      read("conclusion_proposed", { approaches: [{ family: "f", attempts: 3 }] }).body,
      {
        approaches: [{ direction: "f", attempts: 3 }],
      },
    );
    assert.deepEqual(eventKinds("direction_added"), ["direction_added", "family_added"]);
    assert.deepEqual(bodyKeys("direction"), ["direction", "family"]);
  });

  test("a rule's kind note is planner_note, in a rule and in a list of rules; a field note's kind note is other", () => {
    assert.deepEqual(
      read("directive", { id: 2, body: { kind: "note", family: "f", rationale: "r" } }).body,
      {
        id: 2,
        body: { kind: "planner_note", direction: "f", rationale: "r" },
      },
    );
    assert.deepEqual(
      read("directives_left_out", { rules: [{ kind: "note" }, { kind: "try", family: "f" }] }).body,
      {
        rules: [{ kind: "planner_note" }, { kind: "try", direction: "f" }],
      },
    );
    assert.equal(read("journal_note", { id: 1, kind: "note", text: "t" }).body.kind, "other");
    // Only those kinds: another kind's `kind: note` is its own word.
    assert.equal(read("kb_item", { kind: "note", title: "t" }).body.kind, "note");
    assert.deepEqual(currentRule({ kind: "note", value: "x" }), {
      kind: "planner_note",
      value: "x",
    });
    assert.equal(currentNoteKind("note"), "other");
    assert.equal(currentNoteKind("lesson"), "lesson");
  });

  test("a research note is a source note; a run's note was its direction in run_created only", () => {
    assert.equal(read("research_note", { note: 1, text: "t" }).kind, "source_note");
    assert.deepEqual(eventKinds("source_note"), ["source_note", "research_note"]);
    assert.deepEqual(read("run_created", { campaign: "c", direction: "memory first" }).body, {
      campaign: "c",
      note: "memory first",
    });
    // A new run_created has its note already; a direction elsewhere is a direction.
    const now = { kind: "run_created", body: { campaign: "c", note: "n" } };
    assert.equal(currentEvent(now), now);
    assert.deepEqual(read("trial_started", { direction: "tiling" }).body, { direction: "tiling" });
  });

  test("reading under the new names twice changes nothing more", () => {
    for (const e of [
      { kind: "family_added", body: { family: "f" } },
      { kind: "directive", body: { id: 1, body: { kind: "note", family: "f" } } },
      { kind: "run_created", body: { direction: "d" } },
      { kind: "journal_note", body: { kind: "note" } },
    ]) {
      const once = currentEvent(e);
      assert.deepEqual(currentEvent(once), once);
    }
  });

  test("a command signed before v0.1.1 reads under the new names; a new one with an old name is refused in words", () => {
    assert.deepEqual(currentCommand("assign_campaign", { run: "r", direction: "memory first" }), {
      run: "r",
      note: "memory first",
    });
    assert.deepEqual(currentCommand("queue_add", { run: "r", title: "t", family: "f" }), {
      run: "r",
      title: "t",
      direction: "f",
    });
    assert.deepEqual(
      currentCommand("redirect", { run: "r", directives: [{ kind: "note", rationale: "x" }] }),
      { run: "r", directives: [{ kind: "planner_note", rationale: "x" }] },
    );
    assert.deepEqual(
      currentCommand("assign_campaign", { run: "r", queue: [{ title: "t", family: "f" }] }),
      { run: "r", queue: [{ title: "t", direction: "f" }] },
    );
    assert.deepEqual(oldCommandKeys("assign_campaign", { queue: [{ title: "t", family: "f" }] }), [
      "`queue`'s `family` is now `direction`",
    ]);
    const same = { run: "r", note: "n" };
    assert.equal(currentCommand("assign_campaign", same), same);
    assert.deepEqual(oldCommandKeys("assign_campaign", { direction: "d" }), [
      "`direction` is now `note`",
    ]);
    assert.deepEqual(oldCommandKeys("queue_edit", { family: "f" }), [
      "`family` is now `direction`",
    ]);
    assert.deepEqual(
      oldCommandKeys("redirect", { directives: [{ kind: "note", family: "f" }, { kind: "note" }] }),
      ["`family` is now `direction`", "the kind `note` is now `planner_note`"],
    );
    assert.deepEqual(oldCommandKeys("assign_campaign", { note: "n" }), []);
    assert.deepEqual(oldRuleKeys({ kind: "try", direction: "f" }), []);
  });

  test("a contract's notes read as additional_information; a strict schema refuses the old key in words", () => {
    assert.deepEqual(currentContract({ mode: "goal", notes: "n" }), {
      mode: "goal",
      additional_information: "n",
    });
    assert.equal(
      oldContractKeyError({ code: "unrecognized_keys", keys: ["notes", "other"] }),
      "`notes` is now `additional_information`",
    );
    assert.equal(oldContractKeyError({ code: "unrecognized_keys", keys: ["other"] }), undefined);
    assert.equal(oldContractKeyError({ code: "invalid_type" }), undefined);
  });
});
