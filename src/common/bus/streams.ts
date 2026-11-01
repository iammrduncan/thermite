import { JetStreamApiCodes, JetStreamApiError, jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { log } from "../env.ts";
import {
  BUS_LOOK_TIMEOUT_MS,
  BUS_STATE_CONSUMERS_MAX,
  type ConsumerSettings,
  type StreamInfo,
  type StreamSettings,
  type StreamState,
} from "./index.ts";

/**
 * The bus client's calls on streams and consumers themselves (index.ts makes the client): make or
 * bring a stream to its settings, make a consumer, read a stream's settings and state, delete a
 * stream, and purge its messages on a subject.
 */

/** Whether the server said there is no such stream. */
export const noSuchStream = (err: unknown) =>
  err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound;

/** Makes the stream, or brings an existing one to these settings. */
export async function ensureStream(nc: NatsConnection, stream: StreamSettings): Promise<void> {
  const jsm = await jetstreamManager(nc);
  try {
    await jsm.streams.info(stream.name);
  } catch (err) {
    if (!noSuchStream(err)) throw err;
    await jsm.streams.add(stream);
    log("bus", "stream made", { stream: stream.name });
    return;
  }
  await jsm.streams.update(stream.name, stream);
}

/** A consumer's name, whether it is given with its settings or alone. */
export const nameOf = (c: ConsumerSettings | string) =>
  typeof c === "string" ? c : c.durable_name;

/** Makes the durable consumer unless it exists; one named alone is another part's to make. */
export async function ensureConsumer(
  nc: NatsConnection,
  stream: string,
  consumer: ConsumerSettings | string,
  api: { apiPrefix?: string },
): Promise<void> {
  // No check of the account's JetStream first: a rig's user may not read the account's figures.
  const jsm = await jetstreamManager(nc, { checkAPI: false, ...api });
  try {
    await jsm.consumers.info(stream, nameOf(consumer));
  } catch (err) {
    if (noSuchStream(err))
      throw new Error(`no stream ${stream} on the bus yet: control makes it`, { cause: err });
    if (!(err instanceof JetStreamApiError && err.code === JetStreamApiCodes.ConsumerNotFound))
      throw err;
    if (typeof consumer === "string")
      throw new Error(`no consumer ${consumer} on the bus yet: control makes it`, { cause: err });
    await jsm.consumers.add(stream, consumer);
    log("bus", "consumer made", { stream, consumer: consumer.durable_name });
  }
}

/** A stream's settings and places; undefined when the server has no such stream. */
export async function streamInfoOn(
  nc: NatsConnection,
  stream: string,
): Promise<StreamInfo | undefined> {
  const jsm = await jetstreamManager(nc, { timeout: BUS_LOOK_TIMEOUT_MS });
  const info = await jsm.streams.info(stream).catch((err: unknown) => {
    if (noSuchStream(err)) return undefined;
    throw err;
  });
  if (!info) return undefined;
  return {
    config: info.config as StreamSettings,
    first_seq: info.state.first_seq,
    last_seq: info.state.last_seq,
    messages: info.state.messages,
    bytes: info.state.bytes,
  };
}

/** Deletes a stream and every message in it; false when there was none. */
export async function deleteStreamOn(nc: NatsConnection, stream: string): Promise<boolean> {
  const jsm = await jetstreamManager(nc);
  return await jsm.streams.delete(stream).catch((err: unknown) => {
    if (noSuchStream(err)) return false;
    throw err;
  });
}

/** The server's purge of a stream's messages on a subject: before a place, all but some, or all. */
export async function purgeOn(
  nc: NatsConnection,
  stream: string,
  o: { filter: string; seq?: number; keep?: number },
): Promise<number> {
  const jsm = await jetstreamManager(nc);
  const how =
    o.seq !== undefined
      ? { filter: o.filter, seq: o.seq }
      : o.keep !== undefined
        ? { filter: o.filter, keep: o.keep }
        : { filter: o.filter };
  return (await jsm.streams.purge(stream, how)).purged;
}

/** The state of each of these streams the server has, with its consumers; others left out. */
export async function streamStates(
  nc: NatsConnection,
  names: readonly string[],
): Promise<StreamState[]> {
  const jsm = await jetstreamManager(nc);
  const out: StreamState[] = [];
  for (const name of names) {
    let info: Awaited<ReturnType<typeof jsm.streams.info>>;
    try {
      info = await jsm.streams.info(name);
    } catch (err) {
      if (noSuchStream(err)) continue;
      throw err;
    }
    const st = info.state;
    const consumers: StreamState["consumers"] = [];
    let leftOut = 0;
    for await (const c of jsm.consumers.list(name)) {
      if (consumers.length >= BUS_STATE_CONSUMERS_MAX) {
        leftOut++;
        continue;
      }
      consumers.push({
        name: c.name,
        pending: c.num_pending,
        ack_pending: c.num_ack_pending,
        redelivered: c.num_redelivered,
      });
    }
    const at = (ts: string) => (st.messages && !ts.startsWith("0001") ? ts : null);
    out.push({
      name,
      messages: st.messages,
      bytes: st.bytes,
      subjects: st.num_subjects ?? 0,
      first_at: at(st.first_ts),
      last_at: at(st.last_ts),
      consumers,
      consumers_left_out: leftOut,
    });
  }
  return out;
}
