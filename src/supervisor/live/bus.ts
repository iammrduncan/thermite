import { harnessClient } from "../../common/api/harness.ts";
import { type Bus, NoStreamTakes, refusedForGood } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import type { LiveFigures } from "../../core/api/control/rigs.ts";
import { LIVE_MESSAGES, LIVE_PAGE_DEFAULT } from "../../core/api/harness/supervisor.ts";
import {
  LIVE_FIGURE_SUBJECTS,
  LIVE_RIG_HEADER,
  liveFits,
  liveGroups,
  liveMessageId,
  liveSubject,
  rigLiveSubject,
} from "../../core/link/live.ts";
import type { LiveLog } from "../../core/live.ts";
import type { LiveRelayState } from "./index.ts";

/**
 * The live view on the message bus (goal 168, step 2): every few seconds, the harness's newest
 * live lines, grouped and signed by the harness for each run's source, and the supervisor's own
 * lines, unsigned, each published to its subject (core/link/live.ts). Control takes them from
 * the bus. The supervisor counts the lines it published and dropped, by subject, in its figures.
 */

/** What the live view on the bus needs: the harness to read, the bus, and the counts to keep. */
export interface LiveBusConfig {
  rig: string;
  harnessUrl: string;
  harnessToken: string;
  fetchImpl?: typeof fetch | undefined;
  bus: Pick<Bus, "publish">;
  counts: LiveCounts;
  /** The supervisor's own live log: its advisors' lines. */
  own: LiveLog;
}

/** The lines published to the bus and dropped there, by subject: the figures' `live`. */
export class LiveCounts {
  private readonly total = { published: 0, dropped: 0 };
  /** The most recently used subject last; LIVE_FIGURE_SUBJECTS of them at most. */
  private readonly subjects = new Map<string, { published: number; dropped: number }>();

  add(subject: string, what: "published" | "dropped", lines: number): void {
    this.total[what] += lines;
    const row = this.subjects.get(subject) ?? { published: 0, dropped: 0 };
    this.subjects.delete(subject);
    row[what] += lines;
    this.subjects.set(subject, row);
    for (const old of this.subjects.keys()) {
      if (this.subjects.size <= LIVE_FIGURE_SUBJECTS) break;
      this.subjects.delete(old);
    }
  }

  figures(): LiveFigures {
    return { ...this.total, subjects: Object.fromEntries(this.subjects) };
  }
}

/** The subjects the bus refused already, told once each in the log. */
const told = new Set<string>();
const tellOnce = (subject: string, say: () => void) => {
  if (told.has(subject)) return;
  if (told.size >= LIVE_FIGURE_SUBJECTS) told.clear();
  told.add(subject);
  say();
};

/** A message to publish: one batch of lines, and the log its lines are from. */
type Message = {
  logId: string;
  batch: { entries: readonly { seq: number; source: string; run?: string | undefined }[] };
};

/**
 * One relay round on the bus: the harness's new lines and the supervisor's own, each message
 * published to its subject. The cursors move once every message is published or dropped; a bus
 * that fails otherwise (no ack, no stream yet) throws, and the round is made again from the same
 * place, its messages kept once by their ids.
 */
export async function publishLiveOnce(
  cfg: LiveBusConfig,
  state: LiveRelayState,
): Promise<LiveRelayState> {
  const harness = harnessClient({
    url: cfg.harnessUrl,
    token: cfg.harnessToken,
    fetchImpl: cfg.fetchImpl,
  });
  const get = (after: number) =>
    harness.call(LIVE_MESSAGES, { query: { after, limit: LIVE_PAGE_DEFAULT } });
  let cursor = state.cursor;
  let page = await get(cursor);
  if (state.logId !== undefined && page.log_id !== state.logId && cursor !== 0) {
    // The controller restarted: its live log started again.
    cursor = 0;
    page = await get(0);
  }
  const own = cfg.own.since(state.ownCursor, LIVE_PAGE_DEFAULT);
  const messages: Message[] = [
    // Passed through untouched: the supervisor cannot sign for the harness.
    ...page.messages.map((batch) => ({ logId: page.log_id, batch })),
    ...liveGroups(own.entries).map((entries) => ({
      logId: cfg.own.id,
      batch: { rig: cfg.rig, log_id: cfg.own.id, from: state.ownCursor, next: own.next, entries },
    })),
  ];
  for (const m of messages) await publishOne(cfg, m);
  return { logId: page.log_id, cursor: page.next, ownCursor: own.next };
}

/** How the live view's loop runs: its period, when it stops, and when control holds a report. */
interface LiveLoopOptions {
  intervalMs: number;
  stopped: () => boolean;
  /**
   * Whether control holds a report of the rig: it pins the rig's report key on the first, and
   * refuses the harness's live lines until then, with no answer back on the bus.
   */
  reported: () => boolean;
  /** Each round, and while it waits for the first report: the health route's `live` loop. */
  tick: () => void;
  pollMs?: number | undefined;
}

/**
 * The live view's loop: a round every `intervalMs`, from the moment control holds a report of the
 * rig. Lines published before it would be refused and lost (issue #27), so a first start waits for
 * the first report, telling the health route all the while: waiting for it is not being late. A failure is logged
 * once, until a round goes through again.
 */
export async function followLive(cfg: LiveBusConfig, o: LiveLoopOptions): Promise<void> {
  const nap = () => new Promise((r) => setTimeout(r, o.pollMs ?? 250));
  if (!o.stopped() && !o.reported())
    log("supervisor", "the live view waits for control to take the rig's first report");
  while (!o.stopped() && !o.reported()) {
    o.tick();
    await nap();
  }
  let state: LiveRelayState = { cursor: 0, ownCursor: 0 };
  let failing = false;
  while (!o.stopped()) {
    try {
      state = await publishLiveOnce(cfg, state);
      failing = false;
    } catch (err) {
      if (!failing) log("supervisor", "live relay error", { error: String(err) }, "error");
      failing = true;
    }
    o.tick();
    const until = Date.now() + o.intervalMs;
    while (!o.stopped() && Date.now() < until) await nap();
  }
}

/**
 * One message, to its subject. A run's subject the bus refuses, or no stream takes (a run control
 * does not give this rig yet, such as one the rig made itself, until control has its first report
 * of it), sends the message to the rig's own subject instead, its lines naming their run as
 * always. A message the bus refuses there too, or one too large, is dropped and counted; one no
 * stream takes there waits for the next round.
 */
async function publishOne(cfg: LiveBusConfig, m: Message): Promise<void> {
  const lines = m.batch.entries.length;
  const first = m.batch.entries[0];
  if (!first) return;
  let subject: string;
  try {
    subject = liveSubject(cfg.rig, first);
  } catch (err) {
    // A source this build has no subject for: a newer harness's.
    cfg.counts.add("(a source with no subject)", "dropped", lines);
    log("supervisor", "live lines with no subject dropped", { error: errorText(err) }, "warn");
    return;
  }
  const data = JSON.stringify(m.batch);
  if (!liveFits(Buffer.byteLength(data))) {
    cfg.counts.add(subject, "dropped", lines);
    log("supervisor", "live lines too large for the bus dropped", { subject, lines }, "warn");
    return;
  }
  const o = {
    id: liveMessageId({ log_id: m.logId, entries: m.batch.entries }),
    headers: { [LIVE_RIG_HEADER]: cfg.rig },
  };
  const own = rigLiveSubject(cfg.rig, first.source);
  for (const to of new Set([subject, own])) {
    try {
      await cfg.bus.publish(to, data, o);
      cfg.counts.add(to, "published", lines);
      return;
    } catch (err) {
      // On a leaf node (a rig on RunPod) a run's subject the rig may not use gets no answer, as a
      // subject no stream takes, where the server refuses it elsewhere: its lines go on the rig's.
      const leafRefused = to !== own && err instanceof NoStreamTakes;
      if (!refusedForGood(err) && !leafRefused) throw err;
      const why = { subject: to, error: errorText(err).slice(0, 300) };
      tellOnce(to, () =>
        to === own
          ? log("supervisor", "the bus refused the rig's own live subject", why, "error")
          : log(
              "supervisor",
              "the bus refused a run's live subject; its lines go on the rig's",
              why,
            ),
      );
    }
  }
  cfg.counts.add(subject, "dropped", lines);
}
