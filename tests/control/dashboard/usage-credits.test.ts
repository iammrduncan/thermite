import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CREDITS_NOTE_DISMISSED_STEP } from "../../../src/control/providers/index.ts";
import { ModelSource } from "../../../src/harness/agents/model/source.ts";
import { handModelRoute } from "../../../src/supervisor/model-route.ts";
import { stack } from "./stack.ts";

/**
 * A Claude subscription's usage credits on Settings › Providers (goal 169; the owner's decision of
 * 2026-11-01): while Claude Code on a rig reports them on, the subscription is marked "usage
 * credits on", with a note on why it matters and a Dismiss. A dismissal hides the note and keeps
 * the chip; the note comes back once the credits are reported on again after being off; the mark
 * goes when they are reported off. The rig's report carries them (`subscription_usage.credits`).
 */

const TOKEN = "sk-ant-oat01-test-subscription-token-8888"; // public-check: allow (a made-up token for tests)

test("Providers marks a Claude subscription whose usage credits are on; Dismiss hides the note until they come on again", async () => {
  const s = await stack("owner_approval", {
    providerFetch: (async () => new Response("no", { status: 404 })) as typeof fetch,
  });
  const dir = mkdtempSync(join(tmpdir(), "thermite-credits-"));
  s.env.service.models = new ModelSource(join(dir, "model-route.json"), undefined);
  await s.relay();
  let page = await (await s.get("/ui/settings")).text();
  const csrf = s.csrfFrom(page);
  await s.post("/ui/settings/add", {
    csrf,
    type: "claude",
    name: "lab-claude",
    claude_token: TOKEN,
  });
  await s.post("/ui/settings/rigs", {
    csrf,
    rig: "rig-a",
    harness: "claude-code",
    choice: "lab-claude|opus-5.5%5B1m%5D",
  });
  assert.equal(await handModelRoute(s.cfg, (await s.rigConfig("model-route")) as never), "set");
  /** The rig reports its subscription's usage with these credits, as Claude Code last gave them. */
  const report = async (credits: { on: boolean; since: string | null }) => {
    s.env.service.subscriptionUsage = {
      seven_day: { utilization: 1, resets_at: "2026-11-03T18:00:00.000Z" },
      credits,
      at: new Date().toISOString(),
    };
    await s.relay();
    return (await (await s.get("/ui/settings")).text()) as string;
  };
  const chip = /<span class="chip warn" data-credits="on" title="([^"]*)">usage credits on<\/span>/;
  const note =
    /data-credits-note="lab-claude">Claude Code reports usage credits on for this account \(in its last session on rig-a, \d{4}-\d\d-\d\d \d\d:\d\d UTC\)\. With credits on, a full window can spend paid usage instead of waiting/;

  // Never reported: no mark.
  page = (await (await s.get("/ui/settings")).text()) as string;
  assert.doesNotMatch(page, chip);
  // Reported on: the chip and the note, with Dismiss.
  page = await report({ on: true, since: null });
  assert.match(page, chip);
  assert.match(page, note);
  assert.match(page, /action="\/ui\/settings\/providers\/lab-claude\/credits-note\/dismiss"/);
  // Dismissed: the note goes, the chip stays and says so; the history and the audit log keep it.
  const dismissed = await s.post("/ui/settings/providers/lab-claude/credits-note/dismiss", {
    csrf,
  });
  assert.match(
    decodeURIComponent(dismissed.headers.get("location") ?? ""),
    /The note for "lab-claude" is dismissed\. The chip stays/,
  );
  page = (await (await s.get("/ui/settings")).text()) as string;
  assert.doesNotMatch(page, note);
  assert.match(
    chip.exec(page)?.[1] ?? "",
    /You dismissed the note on \d{4}-\d\d-\d\d \d\d:\d\d UTC; it comes back if credits are reported on again after being off\./,
  );
  assert.equal(
    (await s.store.rigHistory.latest("rig-a", [CREDITS_NOTE_DISMISSED_STEP], 1))[0]?.detail,
    "lab-claude",
  );
  assert.ok((await s.store.auditLog.list(50)).some((a) => a.action === "credits_note_dismissed"));
  // Reported on again, with no change between: still dismissed.
  page = await report({ on: true, since: null });
  assert.doesNotMatch(page, note);
  assert.match(page, chip);
  // Reported off: the mark goes.
  await new Promise((r) => setTimeout(r, 5));
  page = await report({ on: false, since: new Date().toISOString() });
  assert.doesNotMatch(page, chip);
  assert.doesNotMatch(page, note);
  // On again after off: the note comes back.
  await new Promise((r) => setTimeout(r, 5));
  page = await report({ on: true, since: new Date().toISOString() });
  assert.match(page, chip);
  assert.match(page, note);
  // A dismissal with the credits off is refused in words.
  await report({ on: false, since: new Date().toISOString() });
  const refused = await s.post("/ui/settings/providers/lab-claude/credits-note/dismiss", { csrf });
  assert.match(
    decodeURIComponent(refused.headers.get("location") ?? ""),
    /Claude Code does not report usage credits on for "lab-claude"/,
  );
});
