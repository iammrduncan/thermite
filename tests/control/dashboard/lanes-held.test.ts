import assert from "node:assert/strict";
import { test } from "node:test";
import { formPayload } from "../../../src/control/ui/commands/forms.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 230 on control's side: a run whose lanes wait for the judge says so on its page and in
 * History, with the count and the limit, and its ⋯ sets how many changes may wait.
 */

test("a run whose lanes wait for the judge says why on its page and in History; ⋯ sets the limit (goal 230)", async () => {
  const { store, control: api } = await controlOnly({
    tokens: { rigs: { "rig-a": "t-a-abcdef" } },
  });
  const { page } = await signIn(api);
  let id = 0;
  const ingest = (events: { kind: string; subject: string; body: Record<string, unknown> }[]) =>
    ingestReport(store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: id,
      next: id + events.length,
      events: events.map((e) => ({
        id: ++id,
        at: new Date().toISOString(),
        actor: "scheduler",
        ...e,
      })),
      summary: {},
    });
  await ingest([
    {
      kind: "run_created",
      subject: "sum-1",
      body: {
        campaign: "sum-speed",
        version: 1,
        mode: "hill_climb",
        seed: { repo: "proj", commit: "a".repeat(40) },
      },
    },
    { kind: "run_status", subject: "sum-1", body: { status: "running" } },
    { kind: "lanes_held", subject: "sum-1", body: { open: 5, limit: 4, from: "contract" } },
  ]);
  const run = await page("/ui/campaigns/sum-speed/runs/sum-1");
  assert.match(
    run,
    /Its lanes wait: 5 changes the judge has not settled, at most 4 \(its contract's max_open_attempts\)\. An open_attempts rule raises it\./,
  );
  assert.match(run, /Set how many may wait/);
  const history = await page("/ui/campaigns/sum-speed/runs/sum-1/history");
  assert.match(
    history,
    /The lanes start no new trial: 5 changes wait for the judge, at most 4 \(the contract's max_open_attempts\)\./,
  );
  await ingest([{ kind: "lanes_held_ended", subject: "sum-1", body: { open: 3 } }]);
  assert.doesNotMatch(await page("/ui/campaigns/sum-speed/runs/sum-1"), /Its lanes wait/);
  // The form sends the owner's rule, and nothing when it has no number.
  assert.deepEqual(formPayload("redirect", { run: "sum-1", open_attempts: "16" }), {
    run: "sum-1",
    directives: [{ kind: "open_attempts", value: 16, rationale: "set on the run's page" }],
    replace: false,
  });
  assert.equal(formPayload("redirect", { run: "sum-1" }), undefined);
});
