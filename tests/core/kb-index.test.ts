import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cutSaid,
  indexEvent,
  type KbFields,
  type KbHeld,
  type KbIndexTarget,
  type KbStored,
  mergeItem,
  metaOf,
} from "../../src/core/kb-index.ts";

/** The index's items in memory, by kind and ref, merged as the targets merge them. */
function memory() {
  const items = new Map<string, KbStored>();
  const held = (s: KbStored | undefined): KbHeld | undefined =>
    s && { body: s.body, meta: metaOf(s.meta) };
  const t: KbIndexTarget = {
    runCreated: () => {},
    item: (_run, kind, ref) => held(items.get(`${kind}:${ref}`)),
    attempt: (ref) => {
      const h = held(items.get(`attempt:${ref}`));
      return h && { run: "r-1", ...h };
    },
    put: (_run, kind, ref, f: KbFields) =>
      void items.set(`${kind}:${ref}`, mergeItem(ref, items.get(`${kind}:${ref}`), f)),
  };
  const ev = (kind: string, body: Record<string, unknown>, subject = "r-1") =>
    indexEvent(t, { at: "2026-10-27T06:00:00Z", actor: "planner", kind, subject, body });
  return { items, ev };
}

describe("the knowledge base keeps the agents' own words whole (goal 162)", () => {
  test("an experiment whose details hold 'Result: ' keeps them when its result arrives", () => {
    const { items, ev } = memory();
    const details = "Try it.\nResult: in the paper, 2x\nThen measure the tail.";
    ev("experiment_added", { id: "x-1", title: "Faster tail", details, why: "the profile" });
    ev("experiment_finished", { id: "x-1", attempt: "a-1", result: "submitted" });
    const body = items.get("experiment:x-1")?.body ?? "";
    assert.ok(body.startsWith(details), body);
    assert.match(body, /\nWhy: the profile\nResult: attempt a-1 \(submitted\)$/);
    ev("experiment_dropped", { id: "x-1", why: "a duplicate" });
    assert.match(
      items.get("experiment:x-1")?.body ?? "",
      /Then measure the tail\.\nWhy: the profile\nDropped: a duplicate$/,
    );
  });

  test("an attempt whose hypothesis holds 'Verdict: ' keeps it when the judge decides", () => {
    const { items, ev } = memory();
    const hypothesis = "Unroll by 8. Verdict: the guide says it helps.";
    ev("attempt_recorded", { hypothesis, claim: "faster", lane: "lane-1" }, "a-1");
    ev("verdict", { verdict: "win_confirmed", delta: 0.061 }, "a-1");
    ev("verdict", { verdict: "regress", delta: -0.02 }, "a-1");
    assert.equal(
      items.get("attempt:a-1")?.body,
      `${hypothesis}\nClaim: faster\nVerdict: regress (-2.00%)`,
    );
  });

  test("an edit of a waiting experiment reaches its item, which keeps its result", () => {
    const { items, ev } = memory();
    ev("experiment_added", {
      id: "x-2",
      title: "First words",
      details: "old details",
      family: "f",
    });
    ev("experiment_edited", { id: "x-2", title: "New words", details: "new details" });
    let x = items.get("experiment:x-2");
    assert.equal(x?.title, "New words");
    assert.equal(x?.body, "new details\nDirection: f");
    assert.deepEqual(metaOf(x?.meta), { details: "new details", why: "", family: "f" });
    ev("experiment_finished", { id: "x-2", attempt: "a-2", result: "submitted" });
    ev("experiment_edited", { id: "x-2", why: "a new reason" });
    x = items.get("experiment:x-2");
    assert.equal(
      x?.body,
      "new details\nWhy: a new reason\nDirection: f\nResult: attempt a-2 (submitted)",
    );
  });
});

describe("a research run's report, paper, cards and decisions (goal 162)", () => {
  test("a cut always says so, and how long the whole is", () => {
    assert.equal(cutSaid("short", 100, "report"), "short");
    const cut = cutSaid("x".repeat(500), 200, "report");
    assert.equal(cut.length, 200);
    assert.match(
      cut,
      /\(Cut: the report has 500 characters; the run's research folder keeps it whole\.\)$/,
    );
  });

  test("the paper, each answer card and each decision of the panel are items of their own", () => {
    const { items, ev } = memory();
    const paper = `# The paper\n${"Words. ".repeat(4000)}`;
    ev("research_paper_accepted", { paper, writer: "writer-1", experiments: [] });
    ev("card_written", {
      question: 0,
      version: 2,
      certainty: "high",
      claims: 4,
      gaps: 1,
      answer: "Yes, when a verifier exists.",
      by: "synth",
    });
    ev("item_decided", {
      review: "rv-1",
      kind: "question",
      key: "0",
      card_version: 2,
      decision: "accepted",
      certainty: "high",
      dissent: [],
    });
    ev("research_final", { report: `${paper}\n# Supplementary material` });
    const p = items.get("report:paper");
    assert.equal(p?.title, "Research paper");
    assert.match(p?.body ?? "", /\(Cut: the paper has \d+ characters/);
    assert.equal(
      items.get("report:card-q0")?.body,
      "Yes, when a verifier exists.\nCertainty: high\nClaims cited: 4; gaps: 1",
    );
    assert.match(items.get("report:card-q0")?.title ?? "", /^Answer card: Question 1 .*version 2$/);
    const d = items.get("report:decision-question-0");
    assert.match(d?.title ?? "", /^The review panel on Question 1 .*: accepted$/);
    assert.equal(
      d?.body,
      "Decision: accepted, high certainty\nOn answer card version 2\nReview: rv-1",
    );
    assert.match(items.get("report:final")?.body ?? "", /\(Cut: the report has \d+ characters/);
  });
  test("a mode or a next experiment's kind named like an object's own property is plain words", () => {
    const { items, ev } = memory();
    ev("run_created", { campaign: "c", mode: "constructor" }, "r-9");
    assert.equal(items.get("run:r-9")?.title, "Run r-9: constructor, c");
    ev("research_paper_accepted", {
      paper: "# The paper",
      writer: "writer-1",
      experiments: [{ id: "x-9", title: "Next", kind: "toString", details: "d" }],
    });
    const x = items.get("experiment:x-9");
    assert.equal(x?.body, "d");
    assert.equal(metaOf(x?.meta).next_for, undefined);
  });
});
