import assert from "node:assert/strict";
import { test } from "node:test";
import { RigFold } from "../../../src/control/views/fold/index.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { applied, controlStore } from "../../helpers/control-store.ts";
import { goalEvents, report } from "../../helpers/view-events.ts";

/**
 * A rig whose events control can't read now: its own row and page say why in words, and every
 * other page, and every other rig, shows as before.
 */
test("a rig whose events can't be read shows why on its row and its page; every other page and rig shows as before", async () => {
  const store = controlStore();
  const { control } = controlOnly({ store, tokens: { rigs: {} } });
  await report(store, "rig-a", "ledger-a", goalEvents("g-a").slice(0, 4));
  await report(store, "rig-b", "ledger-b", goalEvents("g-b").slice(0, 4));
  await applied(store);
  const { get, page } = await signIn(control);
  assert.match(await page("/ui/rigs/rig-a"), /g-a/);
  // rig-a's next event is one its fold fails on.
  const fold = RigFold.prototype.apply;
  RigFold.prototype.apply = function (this: RigFold, e) {
    if (e.kind === "run_status") throw new Error("a handler's mistake");
    fold.call(this, e);
  };
  try {
    await report(
      store,
      "rig-a",
      "ledger-a",
      [{ kind: "run_status", subject: "g-a", body: { status: "paused", reason: "a pause" } }],
      {},
      4,
    );
    await applied(store);
  } finally {
    RigFold.prototype.apply = fold;
  }
  for (const path of ["/ui", "/ui/rigs", "/ui/campaigns", "/ui/rigs/rig-b"])
    assert.equal((await get(path)).status, 200, path);
  assert.match(await page("/ui/rigs/rig-b"), /g-b/);
  const rigs = await page("/ui/rigs");
  assert.match(rigs, /Its events can't be read now/);
  assert.match(rigs, /rig rig-a's view failed/);
  const own = await page("/ui/rigs/rig-a");
  assert.match(own, /Control can't read rig-a's events now\./);
  assert.match(own, /rig rig-a's view failed on its event 5 \(run_status\): a handler's mistake\./);
});
