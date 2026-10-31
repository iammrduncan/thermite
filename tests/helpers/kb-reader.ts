import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KbFiles } from "../../src/control/kb/index.ts";
import type { ControlStore } from "../../src/control/store/index.ts";
import type { KbItemBody } from "../../src/core/kb.ts";
import { ingestReport } from "./control-store.ts";
import { fillKnowledge, KB_RIG } from "./kb-places.ts";

/**
 * The knowledge base of kb-places.ts with a case of everything an item's reader shows (goal 176):
 *
 * - worker-1's finding (`gemv/gs-1/worker-1/finding:1`) in a second version, the planner's
 *   decision following it, and survey's finding supporting it across a grant (survey reads gemv);
 * - two files of worker-1's that control holds, an HTML page (`reference:3`) and an SVG image
 *   (`reference:4`), both active content; kb-places.ts's PDF (`reference:2`), which it does not;
 * - attempt a-2 of gs-1, whose evidence the owner withdrew;
 * - worker calls of gs-1 made in Claude Code;
 * - runs at work: gs-1 and gs-2 (fresh) of gemv, at-1 of attic, and sv-1 and sv-2 of survey on
 *   rig-b, sv-1 started with the grant and sv-2 without it.
 */
export const HTML_PAGE = "<!doctype html><title>x</title><script>alert(document.cookie)</script>";
export const SVG_IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';
export const RIG_B = { rig: "rig-b", ledger: "ledger-rig-b" };
export const FINDING = "gemv/gs-1/worker-1/finding:1";
export const WITHDRAWN_WHY = "measured while the judge's clocks were not locked";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Fills the store; with `files`, control holds the two active files there. */
export async function fillReader(store: ControlStore, files?: KbFiles): Promise<void> {
  fillKnowledge(store);
  let n = 0;
  const at = () => new Date(Date.parse("2026-10-30T11:00:00Z") + n++ * 60_000).toISOString();
  const write = (src: { rig: string; ledger: string }, run: string, b: Partial<KbItemBody>) => {
    const refused = store.kb().write({ ...src, run, event: 2000 + n, at: at() }, {
      item: 1,
      version: 1,
      kind: "finding",
      title: "untitled",
      links: [],
      ...b,
    } as KbItemBody);
    if (refused) throw new Error(refused);
  };
  const report = (src: { rig: string; ledger: string }, events: [string, string, object][]) =>
    ingestReport(store, {
      rig: src.rig,
      ledger_id: src.ledger,
      cursor: 0,
      next: events.length,
      generated_at: new Date().toISOString(),
      events: events.map(([kind, subject, body], i) => ({
        id: i + 1,
        at: at(),
        actor: "harness",
        kind,
        subject,
        body,
      })),
      summary: {},
    });
  write(KB_RIG, "gs-1", {
    slot: "worker-1",
    version: 2,
    title: "Vector loads double the bandwidth, measured twice",
    text: "Measured again over 30 runs: 128-bit loads doubled the bandwidth.",
  });
  for (const [item, name, type, text] of [
    [3, "loads.html", "text/html", HTML_PAGE],
    [4, "loads.svg", "image/svg+xml", SVG_IMAGE],
  ] as const) {
    const file = { sha256: sha(text), name, type, bytes: Buffer.byteLength(text) };
    write(KB_RIG, "gs-1", { slot: "worker-1", item, kind: "reference", title: name, file });
    if (!files) continue;
    mkdirSync(dirname(files.path(file.sha256)), { recursive: true });
    writeFileSync(files.path(file.sha256), text);
    store.kb().files.kept(file.sha256, file.bytes);
  }
  const index = (kind: string, subject: string, body: object, actor = "harness") =>
    store.kb().index(KB_RIG, { at: at(), actor, kind, subject, body });
  index("attempt_recorded", "a-2", { run: "gs-1", lane: "lane-2", hypothesis: "tile by 64" });
  index("verdict", "a-2", { verdict: "invalidated", reasons: WITHDRAWN_WHY }, "judge");
  store.usage.recordCall(KB_RIG.rig, KB_RIG.ledger, 9000, "gs-1", {
    trial: "t-1",
    round: null,
    agent: "workers",
    harness: "claude-code",
    provider: null,
    model: "a-model",
    calls: 1,
    at: at(),
    tokens_in: 10,
    cached_in: null,
    uncached_in: null,
    tokens_out: 5,
    reasoning: null,
    first_token_ms: null,
    call_ms: null,
  });
  // The runs at work, as the rigs report them.
  const created = (run: string, campaign: string): [string, string, object] => [
    "run_created",
    run,
    { campaign, mode: "goal" },
  ];
  await report(KB_RIG, [
    created("gs-1", "gemv"),
    created("gs-2", "gemv"),
    created("at-1", "attic"),
  ]);
  await report(RIG_B, [created("sv-1", "survey"), created("sv-2", "survey")]);
  store.kb().grant("survey", "gemv", "owner:ui");
  // Each run's scope as Start a run sets it: sv-1 includes the grant, sv-2 does not.
  store.kb().setScope("survey", "sv-1", { fresh: false, granted: ["gemv"] }, "owner:ui");
  store.kb().setScope("survey", "sv-2", { fresh: false, granted: [] }, "owner:ui");
  write(RIG_B, "sv-1", {
    slot: "worker-1",
    title: "The bandwidth gain holds on another device",
    text: "The same loads, measured on another device, doubled the bandwidth too.",
    links: [
      { rel: "supports", to: FINDING },
      { rel: "follows", to: "gemv/gs-1/worker-1/finding:9" },
    ],
  });
}
