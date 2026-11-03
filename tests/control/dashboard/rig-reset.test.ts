import assert from "node:assert/strict";
import { test } from "node:test";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * A full reset under way shows on its rig's page (goal 181), with Cancel, and its actions come
 * back there: the Reports page no longer holds the resets.
 */

test("a full reset under way: its card on the rig's page, and Cancel back to it", async () => {
  const s = controlOnly();
  await ingestReport(s.store, {
    rig: "rig-a",
    ledger_id: "ledger-a",
    cursor: 0,
    next: 0,
    events: [],
    summary: {},
    generated_at: new Date().toISOString(),
  });
  const id = s.store.fullResets.create("rig-a", "owner:ui");
  const ui = await signIn(s.control);
  const html = await ui.page("/ui/rigs/rig-a");
  assert.match(html, /<span class="title">A full reset is under way<\/span>/);
  assert.match(html, new RegExp(`action="/ui/resets/${id}/cancel"`));
  assert.doesNotMatch(
    html,
    /Confirm the wipe<\/button><\/form><\/div><\/div>/,
    "nothing to confirm yet",
  );
  const csrf = ui.csrfOf(html);
  const r = await ui.post(`/ui/resets/${id}/cancel`, { csrf });
  assert.deepEqual([r.status, r.headers.get("location")], [303, "/ui/rigs/rig-a"]);
  assert.doesNotMatch(await ui.page("/ui/rigs/rig-a"), /A full reset is under way/);
});
