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
