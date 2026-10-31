import type { Bus, StreamState } from "../../common/bus/index.ts";
import { errorText } from "../../common/errors.ts";
import type { LiveFigures } from "../../core/api/control/rigs.ts";
import { COMMAND_STREAM } from "../../core/link/commands.ts";
import { CONFIG_STREAM } from "../../core/link/config.ts";
import { EVENT_STREAM } from "../../core/link/events.ts";
import { KB_FILES_STREAM } from "../../core/link/kb-files.ts";
import {
  LIVE_KEPT_BYTES,
  LIVE_KEPT_PER_SUBJECT,
  LIVE_KEPT_SECONDS,
  LIVE_MAX_BYTES,
  LIVE_STREAM,
} from "../../core/link/live.ts";
import { REPORT_STREAM } from "../../core/link/report.ts";
import {
  applyState,
  type EventsApply,
  type EventsMove,
  type EventsWriter,
  writerState,
} from "../events/index.ts";
import type { LiveTaken } from "../live/index.ts";
import type { ControlStore } from "../store/index.ts";
import { type ConfigWritten, configState } from "./config.ts";

/**
 * The message bus's state, for whoever runs control (goal 168): its server, the streams control
 * makes with what each consumer has still to take, the writer of the events stream and its apply,
 * and the live stream's and the config bucket's figures, from control's side and from each rig's
 * supervisor. REST (`GET /v1/bus`), MCP (`bus_state`) and
 * `/metrics` read it.
 */

/** The streams control makes, in the order the state lists them. */
export const BUS_STREAMS = [
  REPORT_STREAM,
  EVENT_STREAM,
  COMMAND_STREAM,
  LIVE_STREAM,
  CONFIG_STREAM,
  KB_FILES_STREAM,
] as const;

/** How long a look at the server may take: then the state says the server did not answer. */
export const BUS_STATE_TIMEOUT_MS = 5_000;

/**
 * The bus as control's APIs see it: its server, the writer of the events stream, the move of the
 * events table a store had before, and the apply of the stream, what control took from the live
 * stream, and what it wrote to the config bucket.
 */
export interface BusView {
  /** The server's host and port. */
  server: string;
  bus: Pick<Bus, "streams" | "connected" | "lastSeq">;
  events: EventsWriter;
  move: Pick<EventsMove, "published">;
  apply: EventsApply;
  live: LiveTaken;
  config: ConfigWritten;
}

/** A rig's live lines on the bus: what control took of them, and its supervisor's own counts. */
export interface RigLive {
  rig: string;
  /** Lines control added to the rig's live view from the bus, since control started. */
  taken: number;
  /** The supervisor's figures, since it started; null before its first figures with them. */
  supervisor: (LiveFigures & { at: string | null }) | null;
}

/** The live stream's limits, what control took from it, and each rig's counts. */
export function liveState(store: ControlStore, taken: LiveTaken) {
  const rigs: RigLive[] = [];
  const seen = new Set(taken.rigs.keys());
  for (const r of store.reportedRigs.list()) {
    const sup = store.reportedRigs.supervisor(r.id);
    const live = sup?.live as LiveFigures | undefined;
    if (!live && !seen.has(r.id)) continue;
    seen.delete(r.id);
    const at = typeof sup?.received_at === "string" ? sup.received_at : null;
    rigs.push({
      rig: r.id,
      taken: taken.rigs.get(r.id) ?? 0,
      supervisor: live ? { ...live, at } : null,
    });
  }
  for (const rig of seen) rigs.push({ rig, taken: taken.rigs.get(rig) ?? 0, supervisor: null });
  return {
    kept: {
      seconds: LIVE_KEPT_SECONDS,
      messages_per_subject: LIVE_KEPT_PER_SUBJECT,
      bytes: LIVE_KEPT_BYTES,
      message_bytes: LIVE_MAX_BYTES,
    },
    taken: {
      since: taken.since,
      messages: taken.messages,
      lines: taken.lines,
      left_out: taken.leftOut,
      refused: { ...taken.refused },
    },
    rigs,
  };
}

/**
 * The bus in control's health answer: connected (control holds a connection to its server now) or
 * away (it holds none, and tries again); off only where control was made without it, as in a
 * test, since control needs its bus to start. Control's own routes serve either way, so the
 * answer stays 200: a restart of control mends nothing on the bus.
 */
export const busHealth = (view: BusView | undefined): "off" | "connected" | "away" =>
  view ? (view.bus.connected() ? "connected" : "away") : "off";

/** The bus's state now; for a test's control made without its bus, only that it is off. */
export async function busState(store: ControlStore, view: BusView | undefined) {
  if (!view) return { on: false as const };
  let streams: StreamState[] = [];
  // The events stream's last place, as the server has it.
  let eventsPlace: number | null = null;
  let error: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(
      () => fail(new Error(`no answer within ${BUS_STATE_TIMEOUT_MS / 1000} seconds`)),
      BUS_STATE_TIMEOUT_MS,
    );
  });
  try {
    const read = Promise.all([view.bus.streams(BUS_STREAMS), view.bus.lastSeq(EVENT_STREAM)]);
    [streams, eventsPlace] = await Promise.race([read, late]);
  } catch (err) {
    error = errorText(err);
  } finally {
    clearTimeout(timer);
  }
  return {
    on: true as const,
    server: view.server,
    reachable: error === null,
    error,
    streams,
    events: {
      ...writerState(view.events, view.move.published),
      apply: applyState(store, view.apply, eventsPlace),
    },
    live: liveState(store, view.live),
    config: configState(store, view.config),
  };
}
