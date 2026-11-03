import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Decision } from "../../../src/control/store/index.ts";
import { moreText } from "../../../src/control/ui/components/index.ts";
import { decidedState, outcome, waitingOn } from "../../../src/control/ui/operator/index.ts";
import type { AttemptView, RigView, RunView } from "../../../src/control/views/index.ts";

const NOW = Date.parse("2026-10-21T21:00:00Z");
const item = { rig: "rig-a", run: "run-1", attempt: "a-1" };
const label = (d: Decision) =>
  d.kind === "approve_promotion" ? "Make it the champion" : "Reject it";
const decision = (o: Partial<Decision>): Decision => ({
  id: "c-1",
  rig: "rig-a",
  kind: "decline_promotion",
  run: "run-1",
  attempt: "a-1",
  issued_at: "2026-10-21T20:59:50Z",
  status: "pending",
  acked_at: null,
  outcome: null,
  ...o,
});

describe("a decision the owner made", () => {
  test("sent, or done by the rig: the item leaves the lists at once", () => {
    const pending = decidedState([decision({})], item, "2026-10-21T20:00:00Z", label, NOW);
    assert.equal(pending?.sent, true);
    assert.match(pending?.html ?? "", /Control sent it to the rig/);
    const done = decidedState(
      [decision({ status: "delivered", outcome: { accepted: true, result: {} } })],
      item,
      "2026-10-21T20:00:00Z",
      label,
      NOW,
    );
    assert.equal(done?.sent, true);
    assert.match(done?.html ?? "", /The rig rejected the change\./);
    assert.doesNotMatch(done?.html ?? "", /goes away after the next report/);
  });

  test("refused by the rig: the item comes back, with the cause and its buttons", () => {
    const refused = decidedState(
      [
        decision({
          status: "delivered",
          outcome: { accepted: false, result: { error: "the run is closed" } },
        }),
      ],
      item,
      "2026-10-21T20:00:00Z",
      label,
      NOW,
    );
    assert.equal(refused?.sent, false);
    assert.match(
      refused?.html ?? "",
      /The rig did not do it\. The cause from the rig: the run is closed\./,
    );
    const expired = decidedState([decision({ status: "expired" })], item, undefined, label, NOW);
    assert.equal(expired?.sent, false);
  });

  test("an item that waits again, after the choice, needs the owner again", () => {
    // The item began waiting after the owner's choice: the old choice is not this wait's.
    const again = decidedState([decision({})], item, "2026-10-21T20:59:55Z", label, NOW);
    assert.equal(again, undefined);
  });
});

describe("what waits for the owner (goal 079)", () => {
  test("an audit the rig's auditor will decide is not counted; a block, or no auditor, is", () => {
    const audit = (decision: string | null) => ({
      attempt: "a-1",
      reason: "gain 20.0% above 15%",
      decision,
      at: "2026-10-21T20:00:00Z",
      expected_seq: 1,
      reasons: null,
    });
    const run = (audits: ReturnType<typeof audit>[]) =>
      ({
        status: "running",
        pending_promotions: [],
        agents_stopped: null,
        audits,
        reviews: [],
        conclusions: [],
      }) as unknown as RunView;
    const rig = (auditor: boolean) =>
      ({ supervisor: { advisors: { roles: { auditor } } } }) as unknown as RigView;
    assert.equal(waitingOn(run([audit(null)]), rig(true)), 0);
    assert.equal(waitingOn(run([audit(null)]), rig(false)), 1);
    assert.equal(waitingOn(run([audit("block")]), rig(true)), 1);
    assert.equal(waitingOn(run([audit("skipped")]), rig(false)), 0);
  });
});

describe("a long text on the dashboard", () => {
  test("shows its start and, with more, all of it, without the page's script", () => {
    assert.equal(moreText("short <b>", 200), "short &lt;b&gt;");
    const long = `GK-PN.1: ${"every PN MUL_MAT uses an fp32 reference path; ".repeat(8)}the end <i>`;
    const html = moreText(long, 200);
    assert.match(html, /^<details class="more"><summary><span class="more-part">GK-PN\.1: /);
    assert.match(html, /…<\/span> <span class="more-tog"><\/span><\/summary>/);
    assert.ok(html.endsWith("the end &lt;i&gt;</details>"), "the whole text, escaped");
    assert.doesNotMatch(html, /<i>/);
  });
});

describe("an audit the rig's auditor will decide (goal 079)", () => {
  const run = (audits: unknown[]) =>
    ({ champion: [], audits, pending_promotions: [] }) as unknown as RunView;
  const attempt = { id: "a-1", lifecycle: "awaiting_audit", history: [] } as unknown as AttemptView;
  const rig = (auditor: boolean) =>
    ({ supervisor: { advisors: { roles: { auditor } } } }) as unknown as RigView;
  const held = [{ attempt: "a-1", decision: null, reason: "big_gain", at: "2026-10-22T07:00:00Z" }];

  test("with an auditor it is Auditing, not Needs you; with none, or no rig given, it needs you", () => {
    assert.deepEqual(outcome(run(held), attempt, rig(true)), { word: "Auditing", tone: "info" });
    assert.equal(outcome(run(held), attempt, rig(false)).word, "Needs you");
    assert.equal(outcome(run(held), attempt).word, "Needs you");
  });
});

describe("an attempt whose judge's job was set aside (goal 161)", () => {
  test("it shows Errored, not Judging", () => {
    const run = { champion: [], audits: [], pending_promotions: [] } as unknown as RunView;
    const errored = { id: "a-2", lifecycle: "errored", verdict: null } as unknown as AttemptView;
    assert.deepEqual(outcome(run, errored), { word: "Errored", tone: "" });
  });
});
