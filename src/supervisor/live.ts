import { log } from "../common/env.ts";
import { untoldKinds } from "../core/kb.ts";
import { LiveLog } from "../core/live.ts";
import { buildHeaders } from "../core/version.ts";

/**
 * The live relay: every few seconds, the harness's newest live-log lines (signed by the harness)
 * go to control, with the supervisor's own lines (its advisors; unsigned, and labelled so). The
 * supervisor passes the harness's batch through untouched: it cannot sign for the harness.
 */
export interface LiveRelayConfig {
  rig: string;
  harnessUrl: string;
  harnessToken: string;
  controlUrl?: string | undefined;
  controlToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface LiveRelayState {
  logId?: string | undefined;
  cursor: number;
  /** The supervisor's own lines already sent. */
  ownCursor: number;
}

/** The supervisor's own live lines (its advisors), relayed unsigned. */
export const supervisorLive = new LiveLog({ max: 1000 });

export async function relayLiveOnce(
  cfg: LiveRelayConfig,
  state: LiveRelayState,
): Promise<LiveRelayState> {
  const f = cfg.fetchImpl ?? fetch;
  if (!cfg.controlUrl || !cfg.controlToken) return state;
  const get = async (after: number) => {
    const res = await f(`${cfg.harnessUrl}/v1/live?after=${after}&limit=500`, {
      headers: { authorization: `Bearer ${cfg.harnessToken}` },
    });
    if (!res.ok) throw new Error(`live -> ${res.status}`);
    return (await res.json()) as { log_id: string; next: number; entries: unknown[] };
  };
  let cursor = state.cursor;
  let batch = await get(cursor);
  if (state.logId !== undefined && batch.log_id !== state.logId && cursor !== 0) {
    // The controller restarted: its live log started again.
    cursor = 0;
    batch = await get(0);
  }
  const own = supervisorLive.since(state.ownCursor, 200);
  if (!batch.entries.length && !own.entries.length && batch.log_id === state.logId) return state;
  const res = await f(`${cfg.controlUrl}/v1/rigs/${encodeURIComponent(cfg.rig)}/live`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.controlToken}`,
      "content-type": "application/json",
      ...buildHeaders(),
    },
    body: JSON.stringify({
      batch,
      supervisor: { log_id: supervisorLive.id, entries: own.entries },
    }),
  });
  if (!res.ok)
    throw new Error(`control live -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // Lines this control does not know (a newer harness's) are left out there: said once each.
  const answer = (await res.json().catch(() => ({}))) as { left_out?: Record<string, number> };
  for (const [what, n] of untoldKinds(toldLeftOut, answer.left_out ?? {}))
    log("supervisor", "control left out live lines it does not know", { what, lines: n });
  return { logId: batch.log_id, cursor: batch.next, ownCursor: own.next };
}

/**
 * The relay's loop, a round every `intervalMs`. It starts once the rig's first report has gone
 * through: control pins the rig's key on that report and refuses live lines until then, so a
 * relay that started with the report relay would log a refusal on every first start. A rig whose
 * key waits for the owner keeps saying so in the report relay's errors. A failure is logged once,
 * until a round goes through again.
 */
export async function relayLive(
  cfg: LiveRelayConfig,
  opts: { intervalMs: number; stopped: () => boolean; reported: () => boolean; pollMs?: number },
): Promise<void> {
  const nap = () => new Promise((r) => setTimeout(r, opts.pollMs ?? 250));
  while (!opts.stopped() && !opts.reported()) await nap();
  let state: LiveRelayState = { cursor: 0, ownCursor: 0 };
  let failing = false;
  while (!opts.stopped()) {
    try {
      state = await relayLiveOnce(cfg, state);
      failing = false;
    } catch (err) {
      if (!failing) log("supervisor", "live relay error", { error: String(err) });
      failing = true;
    }
    const until = Date.now() + opts.intervalMs;
    while (!opts.stopped() && Date.now() < until) await nap();
  }
}

/** What control left out of the live view and was logged already. */
const toldLeftOut = new Set<string>();
