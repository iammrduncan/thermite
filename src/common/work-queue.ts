import { JetStreamApiCodes, JetStreamApiError, jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import type { StreamSettings } from "./bus/index.ts";
import { log } from "./env.ts";

/**
 * A stream that becomes a work queue, as the reports stream did (goal 168, step 4). The server
 * can't change a stream's retention to or from a work queue in place, so the bus's follow
 * (bus.ts) empties the stream made before through its own consumer, then removes it and makes it
 * anew: no message it held is lost. Only bus.ts calls these.
 */

/**
 * Whether `stream`, a work queue now, is on the server with another retention, as one made
 * before. If so, its subjects come off it first, so that nothing new comes in while its consumer
 * empties it: a publish to them finds no stream until it is made anew, and is sent again. False
 * for any other stream, or none yet.
 */
export async function startEmptying(nc: NatsConnection, stream: StreamSettings): Promise<boolean> {
  if (stream.retention !== "workqueue") return false;
  const jsm = await jetstreamManager(nc);
  const had = await jsm.streams.info(stream.name).catch((err: unknown) => {
    if (err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound)
      return undefined;
    throw err;
  });
  if (!had || had.config.retention === "workqueue") return false;
  // Its name alone as its subject: nothing publishes there.
  if (had.config.subjects?.join() !== stream.name)
    await jsm.streams.update(stream.name, { subjects: [stream.name] });
  const what = { stream: stream.name, retention: had.config.retention, held: had.state.messages };
  log("bus", "the stream becomes a work queue: its consumer takes what it holds first", what);
  return true;
}

/**
 * Removes a stream startEmptying took the subjects off, once `consumer` has taken every message
 * it held: none waits to be handed, or for its ack. True when it is gone: follow makes it anew.
 */
export async function removeOnceEmpty(
  nc: NatsConnection,
  stream: string,
  consumer: string,
): Promise<boolean> {
  const jsm = await jetstreamManager(nc);
  const c = await jsm.consumers.info(stream, consumer);
  if (c.num_pending > 0 || c.num_ack_pending > 0) return false;
  await jsm.streams.delete(stream);
  log("bus", "the stream emptied and removed, to be made again as a work queue", { stream });
  return true;
}
