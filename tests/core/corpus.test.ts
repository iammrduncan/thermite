import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  hypothesisEvent,
  readClaim,
  readFinding,
  readHypothesis,
  readSourceNote,
  storedList,
} from "../../src/core/corpus.ts";

describe("the research corpus, read in one place (goal 125, T11)", () => {
  test("a row's JSON lists: read, and a damaged one is empty, never a failed read", () => {
    assert.deepEqual(storedList('["c-1", 2]'), ["c-1", 2]);
    for (const damaged of ["{", '{"a":1}', "", null, undefined])
      assert.deepEqual(storedList(damaged), []);
    const claim = readClaim({
      id: "c-1",
      verified: false,
      quotes: JSON.stringify([
        { source: "s-1", quote: "forty-two pages" },
        { source: "s-2", quote: "a clock", resolved_from: "https://example.com/b" },
      ]),
      problems: '["quote not found verbatim in s-1"]',
    });
    assert.deepEqual(claim, {
      id: "c-1",
      verified: false,
      quotes: [
        { source: "s-1", quote: "forty-two pages" },
        { source: "s-2", quote: "a clock", resolved_from: "https://example.com/b" },
      ],
      problems: ["quote not found verbatim in s-1"],
    });
    assert.deepEqual(readFinding({ id: "f-1", supporting: '["c-1"]', problems: "[]" }), {
      id: "f-1",
      supporting: ["c-1"],
      problems: [],
    });
    assert.deepEqual(readHypothesis({ id: "h-1", supporting: "[3]" }).supporting, ["3"]);
    assert.deepEqual(readSourceNote({ id: 1, sources: '["s-1"]' }).sources, ["s-1"]);
  });

  test("a hypothesis's events: what each change says, and what it leaves unsaid", () => {
    assert.equal(hypothesisEvent("claim_added", { claim: "c-1" }), undefined);
    assert.deepEqual(
      hypothesisEvent("hypothesis_added", {
        hypothesis: "h-1",
        lane: null,
        text: "Stateless workers make long runs safe.",
        supporting: [],
        from: "brief",
        question: null,
        status: "author",
      }),
      {
        change: "added",
        id: "h-1",
        text: "Stateless workers make long runs safe.",
        question: null,
        status: "author",
        into: "",
        supporting: [],
        lane: "",
        by: "",
        reason: "",
        from: "brief",
      },
    );
    // A merge's status is `merged`, with what it went into, whatever its body says.
    const merged = hypothesisEvent("hypothesis_merged", {
      hypothesis: "h-2",
      into: "h-1",
      lane: "lane-2",
      text: "t",
      question: 1,
      supporting: ["c-1", 7],
    });
    assert.deepEqual(
      [merged?.change, merged?.status, merged?.into, merged?.question, merged?.supporting],
      ["merged", "merged", "h-1", 1, ["c-1", "7"]],
    );
    // A question it does not name stays unsaid, and one that is not a number is the whole run.
    const status = hypothesisEvent("hypothesis_status", {
      hypothesis: "h-1",
      status: "promoted",
      by: "planner",
      reason: "two verified claims",
    });
    assert.equal(status && "question" in status, false);
    assert.equal(status && "supporting" in status, false);
    assert.deepEqual([status?.by, status?.reason], ["planner", "two verified claims"]);
    assert.equal(hypothesisEvent("hypothesis_revised", { question: "2" })?.question, null);
  });
});
