import assert from "node:assert/strict";
import { test } from "node:test";
import { briefingFromKb } from "../../src/control/briefing.ts";
import { briefingSeedOf } from "../../src/control/kb/index.ts";
import type { ControlStore } from "../../src/control/store/index.ts";
import { controlStore, ingestReport } from "../helpers/control-store.ts";

/** One run of `campaign` on `rig`, named `run`, with one finding, in the knowledge base. */
async function ran(store: ControlStore, rig: string, run: string, words: string) {
  const at = (m: number) => new Date(Date.parse("2026-10-27T01:00:00Z") + m * 60_000).toISOString();
  await ingestReport(store, {
    rig,
    ledger_id: `ledger-${rig}`,
    cursor: 0,
    next: 2,
    generated_at: at(5),
    events: [
      {
        id: 1,
        at: at(0),
        actor: "harness",
        kind: "run_created",
        subject: run,
        body: { campaign: "speed", mode: "goal" },
      },
      {
        id: 2,
        at: at(1),
        actor: "lane-1",
        kind: "research_note",
        subject: run,
        body: { id: 7, by: "lane-1", text: words },
      },
    ],
    summary: {},
  });
}

test("a briefing item from one of two runs of one name, on two rigs, is found by its rig (goal 162)", async () => {
  const store = controlStore();
  await ran(store, "rig-a", "s-1", "On rig-a the cache was the limit.");
  await ran(store, "rig-b", "s-1", "On rig-b the clock was the limit.");
  const kb = store.kb();
  const fromB = kb.search("clock", ["speed"]).find((x) => x.rig === "rig-b");
  assert.ok(fromB);
  const seed = briefingSeedOf(fromB);
  assert.equal(seed?.from.rig, "rig-b");

  const payload = { contract: { campaign: "speed" }, briefing: [seed] };
  const out = briefingFromKb(store, payload) as { briefing?: { text: string }[] };
  assert.deepEqual(
    out.briefing?.map((b) => b.text),
    [seed?.text],
  );
  assert.match(out.briefing?.[0]?.text ?? "", /rig-b the clock/);

  // Without its rig the item can't be told apart: it is left out, and control's log says so.
  const { rig: _rig, ...noRig } = seed?.from ?? {};
  const left = briefingFromKb(store, { ...payload, briefing: [{ ...seed, from: noRig }] });
  assert.equal((left as { briefing?: unknown }).briefing, undefined);
});
