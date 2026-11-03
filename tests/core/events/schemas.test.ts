import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_ACTOR_MAX, whyUnreadable } from "../../../src/core/events/schemas.ts";

/**
 * The bodies control's views read (core/events/schemas.ts): an event whose body is not one its
 * kind's schema takes, or whose actor is too long, gets why in words; the words name the fields,
 * never what they hold.
 */

const event = (kind: string, body: unknown, actor = "harness") => ({ kind, actor, body });

test("a body as its writer gives it is read, an older one without its fields too", () => {
  const recorded = {
    run: "r-1",
    lane: "lane-1",
    lifecycle: "submitted",
    commit: "c".repeat(40),
    parent: "p".repeat(40),
    hypothesis: null,
    known_flaws: [],
    files: [{ path: "src/a.c", added: 3, removed: null }],
    files_total: 1,
  };
  assert.equal(whyUnreadable(event("attempt_recorded", recorded)), undefined);
  // An older ledger's event, without the fields added since.
  assert.equal(
    whyUnreadable(event("attempt_recorded", { run: "r-1", lifecycle: "submitted" })),
    undefined,
  );
  assert.equal(whyUnreadable(event("trial_finished", {})), undefined);
  assert.equal(whyUnreadable(event("run_status", { status: "paused", reason: null })), undefined);
  // A kind the views read nothing of is not looked at.
  assert.equal(whyUnreadable(event("lane_best", "not an object")), undefined);
  assert.equal(whyUnreadable(event("no_such_kind", [1, 2])), undefined);
});

test("a body the views can't read gets why: each field, and what it should be", () => {
  assert.match(
    whyUnreadable(event("attempt_recorded", { run: "r-1", lifecycle: "x", files: [null] })) ?? "",
    /^files\.0: .*expected object, received null$/,
  );
  // A field the views make words of, given as an object that can't become words.
  assert.match(
    whyUnreadable(event("run_status", { status: { toString: 1 } })) ?? "",
    /^status: .*expected string, received object$/,
  );
  assert.match(whyUnreadable(event("run_status", {})) ?? "", /^status: /);
  assert.match(whyUnreadable(event("verdict", "a win")) ?? "", /^its body: .*expected object/);
  assert.match(
    whyUnreadable(event("job_finished", { result: { gained: ["speed", 7] } })) ?? "",
    /^result\.gained\.1: /,
  );
  assert.match(
    whyUnreadable(event("experiment_returned", { id: "x-1", returns: "two" })) ?? "",
    /^returns: /,
  );
});

test("the words never hold what a field holds, name 3 problems at most and stay short", () => {
  const held = "words-a-field-held";
  const why = whyUnreadable(
    event("epoch_started", {
      n: held,
      source: 1,
      notes: 2,
      plan: 3,
      assignments: [held],
      refused: [7],
    }),
  );
  assert.ok(why);
  assert.doesNotMatch(why, /words-a-field-held/);
  assert.match(why, /; and 3 more$/);
  assert.equal(why.split("; ").length, 4);
  assert.ok(why.length <= 300);
});

test("an actor longer than the limit is refused; one at it is read", () => {
  const at = "a".repeat(EVENT_ACTOR_MAX);
  assert.equal(whyUnreadable(event("run_status", { status: "running" }, at)), undefined);
  assert.equal(
    whyUnreadable(event("run_status", { status: "running" }, `${at}a`)),
    `its actor is ${EVENT_ACTOR_MAX + 1} characters long, longer than the ${EVENT_ACTOR_MAX} control takes`,
  );
  // The limit holds for a kind with no schema too.
  assert.ok(whyUnreadable(event("lane_best", {}, `${at}a`)));
});
