import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sentence } from "../../../src/control/ui/words/index.ts";
import { rigView } from "../../../src/control/views/index.ts";
import { applied, controlStore, foldedEvents, ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 117 on control's side: a research run's answer cards reach control as `card_written`
 * events, and its refused cards as `card_refused`. The run's view (get_run, REST and the
 * dashboard's data) carries each question's newest card and the newest refusal since it, and the
 * run's History says each in words.
 */

function store() {
  const s = controlStore();
  let id = 0;
  const t0 = Date.now() - 3_600_000;
  const ingest = async (
    ...events: { kind: string; subject: string; body: Record<string, unknown> }[]
  ) =>
    await ingestReport(s, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: id,
      next: id + events.length,
      events: events.map((e) => ({
        id: ++id,
        at: new Date(t0 + id * 1000).toISOString(),
        actor: "supervisor",
        ...e,
      })),
      summary: {},
    });
  const run = async () => {
    await applied(s);
    const v = rigView(s, "rig-a", { staleAfterMs: 180_000 });
    return v?.runs.find((r) => r.id === "s-1");
  };
  return { s, ingest, run };
}

const written = (question: number, version: number, certainty: string) => ({
  kind: "card_written",
  subject: "s-1",
  body: {
    question,
    version,
    certainty,
    claims: 2,
    gaps: 1,
    by: "teacher-1",
    through: "c-000000000002",
    answer: `Answer ${version} of question ${question + 1}.`,
    cited: ["c-000000000001", "c-000000000002"],
    gap_list: [{ kind: "evidence", text: "A second site." }],
  },
});

describe("a research run's answer cards on control (goal 117)", () => {
  test("the run's view keeps each question's newest card and the newest refusal since it; History says both", async () => {
    const c = store();
    await c.ingest(
      {
        kind: "run_created",
        subject: "s-1",
        body: { campaign: "survey", version: 1, mode: "research", seed: { repo: "research" } },
      },
      { kind: "run_status", subject: "s-1", body: { status: "running", reason: null } },
      written(2, 1, "low"),
      written(0, 1, "low"),
      {
        kind: "card_refused",
        subject: "s-1",
        body: {
          question: 0,
          by: "teacher-1",
          count: 2,
          problems: ["the number 9 is not in the claims it cites", "gap 1 has no words"],
        },
      },
      {
        kind: "card_refused",
        subject: "s-1",
        body: { question: 2, by: "teacher-1", count: 1, problems: ["no claim c-x"] },
      },
      written(2, 2, "moderate"),
    );
    const r = await c.run();
    assert.deepEqual(
      r?.cards.map((x) => [x.question, x.version, x.certainty, x.answer]),
      [
        [0, 1, "low", "Answer 1 of question 1."],
        [2, 2, "moderate", "Answer 2 of question 3."],
      ],
    );
    assert.deepEqual(r?.cards[1]?.claims, ["c-000000000001", "c-000000000002"]);
    assert.deepEqual(r?.cards[1]?.gaps, [{ kind: "evidence", text: "A second site." }]);
    assert.equal(r?.cards[1]?.by, "teacher-1");
    // Question 3's refusal came before its newest card: only question 1's stands.
    assert.deepEqual(r?.card_refusals, [
      {
        question: 0,
        at: r?.card_refusals[0]?.at,
        by: "teacher-1",
        problems: ["the number 9 is not in the claims it cites", "gap 1 has no words"],
      },
    ]);
    const v = rigView(c.s, "rig-a", { staleAfterMs: 180_000 });
    assert.ok(v);
    const words = (await foldedEvents(c.s, "rig-a", "ledger-a"))
      .map((e) => (v ? sentence(v, e)?.text : undefined))
      .filter((x): x is string => typeof x === "string");
    assert.ok(
      words.includes(
        "The synthesizer wrote the answer card of question 3 (version 2): certainty moderate, 2 claims cited, 1 open gap.",
      ),
      words.join("\n"),
    );
    assert.ok(
      words.includes(
        "The harness refused the synthesizer's answer card of question 1: 2 problems, the first: the number 9 is not in the claims it cites. The old card stands.",
      ),
    );
  });
});
