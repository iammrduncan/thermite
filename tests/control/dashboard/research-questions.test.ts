import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * A research run's Overview, from its rig's research digest: each question's words beside its
 * count of verified claims, what the bars measure, and the report's numbers with no source. The
 * rest of each question's row (goal 117) is in research-run-ui.test.ts.
 */

async function control() {
  const { store, control: api } = controlOnly({ tokens: { rigs: { "rig-a": "t-a-abcdef" } } });
  const { page } = await signIn(api);
  let id = 0;
  const ingest = async (
    events: { kind: string; subject: string; body: Record<string, unknown> }[],
  ) => {
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: id,
      next: id + events.length,
      events: events.map((e) => ({
        id: ++id,
        at: new Date().toISOString(),
        actor: "research",
        ...e,
      })),
      summary: {},
    });
  };
  return { page, ingest };
}

const RUN = "/ui/campaigns/survey/runs/s-1";

describe("a research run's questions on its Overview", () => {
  test("each bar names its question and counts its verified claims", async () => {
    const c = await control();
    await c.ingest([
      {
        kind: "run_created",
        subject: "s-1",
        body: { campaign: "survey", version: 1, mode: "research", seed: { repo: "research" } },
      },
      {
        kind: "research_digest",
        subject: "s-1",
        body: {
          questions: [
            { question: "Which <b>cards</b> support peer access?", verified: 28 },
            { question: "Is the driver's limit documented?", verified: 1 },
            { question: "", verified: 0 },
          ],
          unsupported_numbers: 3,
          report: "# Report",
        },
      },
    ]);
    const run = await c.page(RUN);
    assert.match(
      run,
      /A bar counts the question's verified claims, measured against the question with the most\./,
    );
    // Each question by its name for people, its words escaped, and its count of verified claims.
    assert.match(
      run,
      /<span class="rq-text" title="Which &lt;b&gt;cards&lt;\/b&gt; support peer access\?"><b>Question 1<\/b> Which &lt;b&gt;cards&lt;\/b&gt; support peer access\?<\/span>[\s\S]*?<div class="gl-why">28 verified claims · no task given out yet<\/div><div class="bar ok"><i style="width:100\.0%"><\/i><\/div>/,
    );
    assert.match(
      run,
      /<b>Question 2<\/b> Is the driver's limit documented\?<\/span>[\s\S]*?<div class="gl-why">1 verified claim · no task given out yet<\/div>/,
    );
    assert.match(
      run,
      /<b>Question 3<\/b> \(no words\)<\/span>[\s\S]*?<div class="gl-why">0 verified claims · no task given out yet<\/div>/,
    );
    assert.match(
      run,
      /3 numbers in the latest report appear in no archived source and no verified claim\. The report flags each one\./,
    );
  });
});
