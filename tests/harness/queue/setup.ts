import assert from "node:assert/strict";
import { rigView } from "../../../src/control/views/index.ts";
import type { CommandKind } from "../../../src/core/commands.ts";
import type { LedgerEvent } from "../../../src/harness/ledger/rows.ts";
import { controlStore, ingestReport } from "../../helpers/control-store.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/**
 * What the experiment queue's tests (harness/queue.ts) share: a harness with a run assigned,
 * commands signed as control signs them, the ledger's events, and the queue control builds from
 * those events.
 */

export const RUN = "smoke-1";

export async function setup(over: Record<string, unknown> = {}) {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload(over)));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  /** A command as control signs it; the owner's by default. */
  const command = async (kind: CommandKind, payload: unknown, issuedBy = "owner:ui") => {
    const r = await env.service.applyCommand(env.sign(kind, payload, { issuedBy }));
    assert.equal(r.status, "applied", JSON.stringify(r));
    return r as { accepted: boolean; result: Record<string, unknown> };
  };
  const events = (kind?: string): LedgerEvent[] =>
    env.service.ledger.eventsAfter(0, 100_000).events.filter((e) => !kind || e.kind === kind);
  return { env, q: env.service.queue, command, events };
}

/** The run's queue as control builds it from the rig's events (src/control/views/). */
export async function controlQueue(events: LedgerEvent[]) {
  const store = controlStore();
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "ledger-a",
    cursor: 0,
    next: events.at(-1)?.id ?? 0,
    generated_at: new Date().toISOString(),
    events,
    summary: {},
  });
  const u = rigView(store, "rig-a", { staleAfterMs: 600_000 });
  const r = u?.runs.find((x) => x.id === RUN);
  assert.ok(r, "control sees the run");
  return r;
}
