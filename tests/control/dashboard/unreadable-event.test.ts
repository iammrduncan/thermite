import assert from "node:assert/strict";
import { test } from "node:test";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { applied, controlStore } from "../../helpers/control-store.ts";
import { goalEvents, report } from "../../helpers/view-events.ts";

/**
 * An event whose body control can't read as its kind's: the rig's history says so in words, and
 * every page shows the rest of the rig as before.
 */
test("an event control can't read shows in the rig's history with why; every page shows as before", async () => {
  const store = controlStore();
  const { control } = controlOnly({ store, tokens: { rigs: {} } });
  await report(store, "rig-a", "ledger-a", [
    ...goalEvents("g-a").slice(0, 4),
    {
      kind: "attempt_recorded",
      subject: "a-bad",
      body: { run: "g-a", lifecycle: "submitted", files: [null] },
    },
    // A field the pages make words of, as an object that can't become words.
    { kind: "run_status", subject: "g-a", body: { status: { toString: 1 }, reason: "x" } },
  ]);
  await applied(store);
  const { get, page } = await signIn(control);
  for (const path of [
    "/ui",
    "/ui/rigs",
    "/ui/campaigns",
    "/ui/rigs/rig-a",
    "/ui/campaigns/decoder",
  ])
    assert.equal((await get(path)).status, 200, path);
  const rig = await page("/ui/rigs/rig-a");
  assert.match(
    rig,
    /Control can.t read this attempt_recorded event: files\.0: [^<]*expected object, received null\. It is kept as the rig sent it; nothing in it is shown or counted here\./,
  );
  assert.match(rig, /Control can.t read this run_status event: status: /);
  const run = await page("/ui/campaigns/decoder/runs/g-a");
  assert.match(run, /Control can.t read this attempt_recorded event/);
  assert.doesNotMatch(run, /a-bad/);
});
