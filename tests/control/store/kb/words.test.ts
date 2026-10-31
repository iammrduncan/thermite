import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ControlStore } from "../../../../src/control/store/index.ts";
import { knowledgeSearch, passagesOf } from "../../../../src/control/store/kb/index.ts";
import type { SignedCommand } from "../../../../src/core/commands.ts";
import { kbOutcomeOf, verdictOutcome } from "../../../../src/core/kb.ts";

/**
 * The words index of control's knowledge base (goal 175): long texts cut into passages, each
 * item's outcome read from its records' fields (never from an agent's words), its context written
 * from Thermite's records, and store migration 17, which builds them for the items before it.
 */

const RIG = { rig: "rig-a", ledger: "ledger-a" };

function event(s: ControlStore, kind: string, subject: string, body: Record<string, unknown>) {
  s.kb().index(RIG, { at: "2026-10-29T10:00:00.000Z", actor: "harness", kind, subject, body });
}

/** Control's assignment of a run of a campaign to rig-a, with its contract's title and target. */
const assignment = (run: string, contract: Record<string, unknown>) =>
  ({
    envelope: {
      v: 1,
      id: `c-${run}`,
      rig: "rig-a",
      kind: "assign_campaign",
      issued_by: "owner:api",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      payload: { run, contract },
    },
    signature: "not checked by the store",
  }) as unknown as SignedCommand;

const row = (s: ControlStore, kind: string, ref: string) =>
  s.db
    .prepare("select outcome, context from kb_item where kind = ? and ref = ?")
    .get(kind, ref) as { outcome: string | null; context: string };

describe("the knowledge base's words index", () => {
  test("a short text is one passage; a long one is cut near 2,000 characters, at a sentence's end", () => {
    assert.deepEqual(passagesOf("A note."), [{ start: 0, end: 7 }]);
    assert.deepEqual(passagesOf(""), [{ start: 0, end: 0 }]);
    const sentence = "The kernel reads each row once and keeps the sums in registers. ";
    const long = sentence.repeat(160);
    const parts = passagesOf(long);
    assert.ok(parts.length >= 4, `${parts.length} passages`);
    // They cover the text in order, with nothing left out or read twice.
    assert.equal(parts[0]?.start, 0);
    assert.equal(parts.at(-1)?.end, long.length);
    for (const [i, p] of parts.entries()) {
      if (i > 0) assert.equal(p.start, parts[i - 1]?.end);
      if (i < parts.length - 1) {
        assert.ok(Math.abs(p.end - p.start - 2_000) <= 400, `passage ${i}: ${p.end - p.start}`);
        assert.match(long.slice(p.end - 2, p.end), /\. $/, "it ends after a sentence");
      }
    }
  });

  test("an outcome comes from the records' fields: the verdict, the result, the planner's drop", () => {
    assert.equal(verdictOutcome("win_confirmed (+6.10%)"), "won");
    assert.equal(verdictOutcome("goal_screened"), "screened");
    assert.equal(verdictOutcome("regress (-2.00%)"), "regress");
    assert.equal(verdictOutcome("not_confirmed (+0.20%)"), "neutral");
    assert.equal(verdictOutcome("crash_candidate"), "broken");
    assert.equal(verdictOutcome("invalidated (withdrawn: a noisy rig)"), "unclear");
    assert.equal(verdictOutcome(undefined), "open");
    assert.equal(verdictOutcome("starting_point"), null);
    const none = () => undefined;
    assert.equal(kbOutcomeOf("experiment", {}, none), "open");
    assert.equal(kbOutcomeOf("experiment", { result: "Dropped: tried before" }, none), "dropped");
    assert.equal(
      kbOutcomeOf("experiment", { result: "Result: no attempt (error)" }, none),
      "unclear",
    );
    assert.equal(
      kbOutcomeOf("experiment", { result: "Result: attempt a-7 (submitted)" }, (r) =>
        r === "a-7" ? "won" : undefined,
      ),
      "won",
    );
    assert.equal(kbOutcomeOf("attempt", { refused: "a banned call" }, none), "broken");
    // An agent's words never make an outcome: a note has none, whatever it says.
    assert.equal(
      kbOutcomeOf("note", { result: "Dropped: x", verdict: "win_confirmed" }, none),
      null,
    );
  });

  test("an experiment takes its attempt's outcome, also when the verdict comes later; the context says it", () => {
    const s = new ControlStore(":memory:");
    const contract = {
      campaign: "gemv",
      title: "GEMV decode speed",
      target: { type: "cuda", class: "sm90" },
    };
    s.commands.enqueue(assignment("gs-1", contract));
    event(s, "run_created", "gs-1", { campaign: "gemv", mode: "hill_climb" });
    event(s, "experiment_added", "gs-1", { id: "x-1", title: "Vector loads", by: "planner" });
    assert.equal(row(s, "experiment", "x-1").outcome, "open");
    event(s, "attempt_recorded", "a-1", { run: "gs-1", hypothesis: "Wider loads", lane: "lane-1" });
    event(s, "experiment_finished", "gs-1", { id: "x-1", attempt: "a-1", result: "submitted" });
    assert.equal(row(s, "experiment", "x-1").outcome, "open");
    event(s, "verdict", "a-1", { run: "gs-1", verdict: "regress", delta: -0.02 });
    assert.equal(row(s, "attempt", "a-1").outcome, "regress");
    const x = row(s, "experiment", "x-1");
    assert.equal(x.outcome, "regress");
    // The campaign's title and target come from the run's assignment; a version saved on control
    // comes first once there is one.
    assert.equal(x.context, "experiment regress records gs-1 gemv GEMV decode speed cuda sm90");
    s.campaigns.put({
      campaign: "gemv",
      version: 1,
      contract: { ...contract, title: "GEMV v2" },
      sha: "a",
      by: "owner:ui",
    });
    event(s, "experiment_added", "gs-1", { id: "x-3", title: "Split K", by: "planner" });
    assert.equal(
      row(s, "experiment", "x-3").context,
      "experiment open records gs-1 gemv GEMV v2 cuda sm90",
    );
    // The words index follows: its context finds it, with the outcome's own word.
    const r = s.kb().find("regress", [{ campaign: "gemv" }], { kinds: ["experiment"] });
    assert.deepEqual(
      r.hits.map((h) => [h.ref, h.outcome]),
      [["x-1", "regress"]],
    );
    assert.match(r.hits[0]?.why ?? "", /its context .* has regress/);
    event(s, "experiment_added", "gs-1", { id: "x-2", title: "Tiles", by: "planner" });
    event(s, "experiment_dropped", "gs-1", { id: "x-2", why: "tried before" });
    assert.equal(row(s, "experiment", "x-2").outcome, "dropped");
  });

  test("migration 17 gives the items before it their outcomes, contexts and passages, once", () => {
    const s = new ControlStore(":memory:");
    event(s, "run_created", "gs-1", { campaign: "gemv", mode: "hill_climb" });
    event(s, "attempt_recorded", "a-1", { run: "gs-1", hypothesis: "Wider loads", lane: "lane-1" });
    event(s, "verdict", "a-1", { run: "gs-1", verdict: "win_confirmed", delta: 0.061 });
    event(s, "experiment_added", "gs-1", { id: "x-1", title: "Vector loads", by: "planner" });
    event(s, "experiment_finished", "gs-1", { id: "x-1", attempt: "a-1", result: "submitted" });
    event(s, "source_fetched", "gs-1", {
      source: "s-1",
      title: "A long page",
      url: "https://example.org/a",
      text: "Each warp reads one row. ".repeat(400),
    });
    // The index as migration 14 left it: gone, with the columns' values.
    s.db.exec(`drop view kb_passage_text; drop table kb_words_terms; drop table kb_words;
      drop table kb_passage; drop index kb_item_outcome;
      alter table kb_item drop column outcome; alter table kb_item drop column context;`);
    knowledgeSearch(s.db);
    assert.equal(row(s, "experiment", "x-1").outcome, "won");
    assert.match(row(s, "source", "s-1").context, /^source records gs-1 gemv$/);
    const passages = s.db.prepare("select count(*) as n from kb_passage").get() as { n: number };
    assert.ok(passages.n > 5, `${passages.n} passages`);
    const hit = s.kb().find("warp", [{ campaign: "gemv" }]).hits[0];
    assert.equal(hit?.ref, "s-1");
    assert.ok((hit?.passage?.of ?? 0) > 3);
    // Again: nothing changes.
    knowledgeSearch(s.db);
    const again = s.db.prepare("select count(*) as n from kb_passage").get() as { n: number };
    assert.equal(again.n, passages.n);
  });
});
