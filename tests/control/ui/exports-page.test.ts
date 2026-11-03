import assert from "node:assert/strict";
import { test } from "node:test";
import type { RigExport } from "../../../src/control/store/index.ts";
import { EXPORTS_PAGE, exportsBody } from "../../../src/control/ui/exports.ts";

/** The Exports page's pages (goal 181): EXPORTS_PAGE at a time, newest first, with the filters kept. */

const exp = (i: number): RigExport => ({
  rig: i % 2 ? "rig-a" : "rig-b",
  name: `2026110${Math.floor(i / 10)}T0${i % 10}0000-${String(i).padStart(8, "0")}`,
  manifest: { run: `run-${i}`, end: true },
  files: { "events.jsonl": { size: 10, sha256: "0".repeat(64) } },
  done: ["events.jsonl"],
  bytes: 1024 * i,
  full: false,
  from_event: 0,
  through_event: i,
  created_at: new Date(Date.parse("2026-11-02T00:00:00Z") - i * 60_000).toISOString(),
  complete_at: new Date(Date.parse("2026-11-02T00:00:00Z") - i * 60_000).toISOString(),
});

const body = (at: number, rig: string[] = []) =>
  exportsBody({
    exports: Array.from({ length: 30 }, (_, i) => exp(i)),
    rigs: ["rig-a", "rig-b"],
    campaignOf: () => "papers",
    query: { rig, kind: [], campaign: [], q: "", at },
    kept: true,
    now: Date.parse("2026-11-02T01:00:00Z"),
    csrf: "c",
    receiving: () => false,
  });

const rows = (html: string) => [...html.matchAll(/<tr data-export="/g)].length;

test("the first page holds EXPORTS_PAGE exports and links to the older ones", () => {
  const first = body(0);
  assert.equal(rows(first), EXPORTS_PAGE);
  assert.match(first, /1–25 of 30/);
  assert.match(first, /<a class="btn sm" href="\/ui\/exports\?at=25">Older ›<\/a>/);
  assert.match(first, /<span class="btn sm" aria-disabled="true">‹ Newer<\/span>/);
});

test("the next page holds the rest, links back, and keeps the filters in its links", () => {
  const next = body(25);
  assert.equal(rows(next), 5);
  assert.match(next, /26–30 of 30/);
  assert.match(next, /href="\/ui\/exports">Newest<\/a>/);
  const rigA = body(10, ["rig-a"]);
  assert.equal(rows(rigA), 5, "15 of rig-a's, from the eleventh");
  assert.match(rigA, /href="\/ui\/exports\?rig=rig-a">Newest<\/a>/);
  // Delete keeps the page's filters and place.
  assert.match(
    rigA,
    /<form method="get" action="\/ui\/exports" id="xpick"><input type="hidden" name="rig" value="rig-a"><input type="hidden" name="at" value="10">/,
  );
});
