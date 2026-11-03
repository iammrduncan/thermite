import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { outcome } from "../../../src/control/ui/operator/index.ts";
import { sentence } from "../../../src/control/ui/words/index.ts";
import type { RigView, StoredEvent } from "../../../src/control/views/index.ts";

const event = (kind: string, actor: string, body: Record<string, unknown>) =>
  ({
    seq: 1,
    id: 1,
    at: "2026-10-24T03:00:00.000Z",
    actor,
    kind,
    subject: "r-1",
    body,
  }) as never as StoredEvent;
const said = (e: StoredEvent) => sentence({} as RigView, e)?.text;

describe("the dashboard's words for research reviews and closed runs' attempts", () => {
  test("an attempt its run closed before the judge got to says Not judged, not Judging", () => {
    const r = { champion: [], audits: [], status: "closed", pending_promotions: [] } as never;
    assert.deepEqual(outcome(r, { id: "a-1", lifecycle: "not_judged", verdict: null } as never), {
      word: "Not judged",
      tone: "",
    });
  });

  test("a research review is asked as one of the research questions, not of a goal", () => {
    assert.equal(
      said(event("review_requested", "scheduler", { goal: "research", review: 4 })),
      "The review panel was asked whether the research questions are answered (review 4).",
    );
    assert.equal(
      said(event("review_requested", "harness", { goal: "readable" })),
      'The review panel was asked to judge the goal "readable".',
    );
  });

  test("a pass taken hands-off is not said to be yours; your own word is", () => {
    assert.equal(
      said(
        event("review_decided", "harness (hands-off)", { goal: "research", decision: "accepted" }),
      ),
      "The review panel's pass was taken hands-off: this run does not ask you about reviews.",
    );
    assert.equal(
      said(event("review_decided", "control:owner:ui", { goal: "research", decision: "accepted" })),
      "You accepted the review panel's answers to the research questions.",
    );
    assert.equal(
      said(event("review_decided", "control:owner:ui", { goal: "readable", decision: "rejected" })),
      "You rejected a review.",
    );
  });
});

describe("the History's words for the owner's input into an agent's terminal", () => {
  const input = (body: Record<string, unknown>) =>
    said(
      event("terminal_input", "harness", {
        command: "c-1",
        trial: "t-1",
        lane: "lane-2",
        wait: "queue",
        ...body,
      }),
    );

  test("words given as a follow-up say so, and when the agent gets them; words that steer do not", () => {
    assert.equal(
      input({ text: "also try the tiled loop", follow_up: true, outcome: "typed" }),
      "You typed “also try the tiled loop” into lane-2's terminal (trial t-1) as a follow-up: the agent gets it when it would stop, at the end of a reply that calls no tool.",
    );
    assert.equal(
      input({ text: "also try the tiled loop", outcome: "typed" }),
      "You typed “also try the tiled loop” into lane-2's terminal (trial t-1).",
    );
    assert.equal(
      input({
        text: "/model x",
        follow_up: true,
        outcome: "refused",
        why: "a follow-up is words for the agent.",
      }),
      "Not typed into lane-2's terminal (trial t-1): “/model x”, as a follow-up. a follow-up is words for the agent.",
    );
  });
});
