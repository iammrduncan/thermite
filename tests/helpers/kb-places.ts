import type { ControlStore } from "../../src/control/store/index.ts";
import type { KbItemBody } from "../../src/core/kb.ts";

/**
 * A knowledge base with places to list (goal 176), in one store, as rig-a's events and its
 * agents' writes leave it:
 *
 * - gemv: run gs-1, with its records (the run, experiment x-1 that won, x-2 the planner dropped,
 *   attempt a-1 and a field note), worker-1's finding (its title holds a script tag) and a file
 *   (loads.pdf, 52,000 bytes), and the planner's decision that follows the finding; run gs-2,
 *   which started fresh, with only its run's record;
 * - attic: run at-1, archived;
 * - empty: a collection made with its campaign, with no run yet.
 *
 * Each event and write is a minute after the one before, from 2026-10-30 10:00 UTC.
 */
export const KB_RIG = { rig: "rig-a", ledger: "ledger-rig-a" };

export function fillKnowledge(store: ControlStore): void {
  let minute = 0;
  const at = () => new Date(Date.parse("2026-10-30T10:00:00Z") + minute++ * 60_000).toISOString();
  const event = (actor: string, kind: string, subject: string, body: Record<string, unknown>) =>
    store.kb().index(KB_RIG, { at: at(), actor, kind, subject, body });
  const write = (run: string, b: Partial<KbItemBody> & Pick<KbItemBody, "slot" | "kind">) => {
    const refused = store.kb().write({ ...KB_RIG, run, event: 1000 + minute, at: at() }, {
      item: 1,
      version: 1,
      title: "untitled",
      links: [],
      ...b,
    } as KbItemBody);
    if (refused) throw new Error(refused);
  };
  event("harness", "run_created", "gs-1", { campaign: "gemv", mode: "goal" });
  event("supervisor", "experiment_added", "gs-1", {
    id: "x-1",
    title: "Load int4 weights with vector loads",
    details: "128-bit loads of the packed weights",
    by: "planner",
  });
  event("supervisor", "experiment_added", "gs-1", {
    id: "x-2",
    title: "Tile the vector in shared memory",
    by: "lane-2",
  });
  event("harness", "attempt_recorded", "a-1", {
    run: "gs-1",
    lane: "lane-1",
    hypothesis: "vector loads for the weights",
  });
  event("judge", "verdict", "a-1", { verdict: "win_confirmed", delta: 0.061 });
  event("harness", "experiment_finished", "gs-1", {
    id: "x-1",
    lane: "lane-1",
    attempt: "a-1",
    result: "submitted",
  });
  event("planner", "experiment_dropped", "gs-1", { id: "x-2", why: "the L2 is too small" });
  event("harness", "journal_note", "gs-1", {
    id: 1,
    by: "lane-1",
    kind: "decision",
    text: "Kept the old path below n = 4096.",
  });
  write("gs-1", {
    slot: "worker-1",
    kind: "finding",
    title: "<script>alert(1)</script> Vector loads double the bandwidth",
    text: "128-bit loads doubled the measured bandwidth. See [the doc](/ui/settings).",
  });
  write("gs-1", {
    slot: "worker-1",
    item: 2,
    kind: "reference",
    title: "A paper on wide loads",
    file: { sha256: "a".repeat(64), name: "loads.pdf", type: "application/pdf", bytes: 52_000 },
  });
  write("gs-1", {
    slot: "planner",
    kind: "decision",
    title: "Tile next",
    text: "Tiling comes after the loads.",
    links: [{ rel: "follows", to: "gemv/gs-1/worker-1/finding:1" }],
  });
  event("harness", "run_created", "gs-2", { campaign: "gemv", mode: "goal" });
  store.kb().setScope("gemv", "gs-2", { fresh: true, granted: [] }, "owner:ui");
  event("harness", "run_created", "at-1", { campaign: "attic", mode: "hill_climb" });
  store.archive.add("attic", "owner:ui");
  store.kb().makeCollection("empty", at());
}
