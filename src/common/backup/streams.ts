import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { createInbox, type NatsConnection } from "@nats-io/transport-node";
import { BACKUP_INBOX_PREFIX } from "../../core/link/users.ts";
import { type BusTrust, connectOnce } from "../bus.ts";

/**
 * The streams of a backup (goal 173): each stream kept for good is backed up by the server's
 * snapshot API, which gives the stream's own files as one archive (a tar, compressed with s2), and
 * put back by its restore API, which takes that archive and makes the stream from it, only where
 * the server has no stream of that name. The NATS library has no call for either, so this module
 * speaks the API's subjects itself, as the backup's own user, which may do this and nothing else.
 */

/** A stream's state: how many messages it keeps, its first and last places, and its bytes. */
export interface StreamEnd {
  messages: number;
  first_seq: number;
  last_seq: number;
  bytes: number;
}

/** What a stream's snapshot holds: its state then, and the stream's settings as the server gave them. */
export interface StreamSnapshot extends StreamEnd {
  config: Record<string, unknown>;
}

/** What a backup and a restore need of the bus. */
export interface BackupBus {
  /** The stream's state now; undefined when the server has no such stream. */
  state(stream: string): Promise<StreamEnd | undefined>;
  /** The digest of the message at `seq` (messageDigest); undefined when there is none there. */
  messageSha256(stream: string, seq: number): Promise<string | undefined>;
  /** Writes the stream's snapshot to `file`, made new, and gives what it holds. */
  snapshot(stream: string, file: string): Promise<StreamSnapshot>;
  /**
   * Makes the stream from a snapshot file and what it held. The server refuses a stream it has
   * already, and may be stopped part way: a caller checks the stream it finds after.
   */
  restore(stream: string, file: string, held: StreamSnapshot): Promise<void>;
  close(): Promise<void>;
}

/** A message's digest, as a backup records the last one of each stream: its subject, a newline, its data. */
export function messageDigest(subject: string, data: Uint8Array): string {
  return createHash("sha256").update(`${subject}\n`).update(data).digest("hex");
}

/** How large each chunk of a snapshot is, both ways. */
export const SNAPSHOT_CHUNK_BYTES = 256 * 1024;
/** How long the server may take to answer a request or a chunk. It then fails. */
export const BACKUP_ANSWER_TIMEOUT_MS = 30_000;
/** How long a snapshot may go without a chunk from the server. It then fails. */
export const SNAPSHOT_QUIET_MS = 60_000;
/**
 * How long the server may take to make the stream from the archive, after its last chunk. It then
 * fails, and the stream the server leaves is checked by the next restore.
 */
export const RESTORE_FINISH_TIMEOUT_MS = 30 * 60_000;

/** The JetStream API's prefix. */
const API = "$JS.API";
/** The server's code for a stream it does not have, and for a message not there. */
const NO_STREAM = 10059;
const NO_MESSAGE = 10037;

/** A refusal from the JetStream API, in the server's words. */
export class StreamApiError extends Error {
  readonly code: number;
  constructor(e: { err_code?: number; description?: string }) {
    super(e.description ?? "the server refused it");
    this.code = e.err_code ?? 0;
  }
}

interface Answer {
  error?: { err_code?: number; description?: string };
}

/**
 * The bus at `url` as the backup's user (`seed`), trusting the server through `trust`. It connects
 * on first use and never again: a call after the connection was lost fails.
 */
export function natsBackupBus(url: string, seed: Uint8Array, trust?: BusTrust): BackupBus {
  let conn: Promise<NatsConnection> | undefined;
  const nc = () => {
    conn ??= connectOnce(url, "thermite backup", {
      seed,
      trust,
      inboxPrefix: BACKUP_INBOX_PREFIX,
    });
    return conn;
  };
  const ask = async <T>(subject: string, body: unknown, timeout = BACKUP_ANSWER_TIMEOUT_MS) => {
    const m = await (await nc()).request(subject, JSON.stringify(body), { timeout });
    const answer = m.json<T & Answer>();
    if (answer.error) throw new StreamApiError(answer.error);
    return answer;
  };
  return {
    async state(stream) {
      try {
        const a = await ask<{ state: StreamEnd }>(`${API}.STREAM.INFO.${stream}`, {});
        const { messages, first_seq, last_seq, bytes } = a.state;
        return { messages, first_seq, last_seq, bytes };
      } catch (err) {
        if (err instanceof StreamApiError && err.code === NO_STREAM) return undefined;
        throw err;
      }
    },
    async messageSha256(stream, seq) {
      try {
        const a = await ask<{ message: { subject: string; data?: string } }>(
          `${API}.STREAM.MSG.GET.${stream}`,
          { seq },
        );
        return messageDigest(a.message.subject, Buffer.from(a.message.data ?? "", "base64"));
      } catch (err) {
        if (err instanceof StreamApiError && [NO_STREAM, NO_MESSAGE].includes(err.code))
          return undefined;
        throw err;
      }
    },
    async snapshot(stream, file) {
      const c = await nc();
      const inbox = createInbox(BACKUP_INBOX_PREFIX);
      const chunks = c.subscribe(inbox);
      const out = createWriteStream(file, { flags: "wx", mode: 0o600 });
      let quiet: ReturnType<typeof setTimeout> | undefined;
      let stopped: string | undefined;
      const wait = () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          stopped = `no part of the snapshot came for ${SNAPSHOT_QUIET_MS / 1000} s`;
          chunks.unsubscribe();
        }, SNAPSHOT_QUIET_MS);
      };
      try {
        wait();
        const a = await ask<{ config: Record<string, unknown>; state: StreamEnd }>(
          `${API}.STREAM.SNAPSHOT.${stream}`,
          { deliver_subject: inbox, no_consumers: true, chunk_size: SNAPSHOT_CHUNK_BYTES },
        );
        let ended = false;
        for await (const m of chunks) {
          wait();
          // The last message is empty: its status says whether the snapshot ended well.
          if (m.data.length === 0) {
            const code = m.headers?.code ?? 0;
            if (code >= 400)
              stopped = `the server stopped the snapshot: ${code} ${m.headers?.description ?? ""}`;
            ended = true;
            break;
          }
          if (!out.write(m.data)) await once(out, "drain");
          // Each chunk's ack lets the server send the next ones.
          if (m.reply) m.respond();
        }
        if (stopped || !ended)
          throw new Error(stopped ?? "the snapshot ended before its last part");
        const { messages, first_seq, last_seq, bytes } = a.state;
        return { messages, first_seq, last_seq, bytes, config: a.config };
      } finally {
        clearTimeout(quiet);
        chunks.unsubscribe();
        out.end();
        await once(out, "close");
      }
    },
    async restore(stream, file, held) {
      const c = await nc();
      const { messages, first_seq, last_seq, bytes } = held;
      const start = await ask<{ deliver_subject: string }>(`${API}.STREAM.RESTORE.${stream}`, {
        config: held.config,
        state: { messages, first_seq, last_seq, bytes },
      });
      const to = start.deliver_subject;
      for await (const chunk of createReadStream(file, { highWaterMark: SNAPSHOT_CHUNK_BYTES })) {
        const m = await c.request(to, chunk as Buffer, { timeout: BACKUP_ANSWER_TIMEOUT_MS });
        if (m.data.length) {
          const a = m.json<Answer>();
          if (a.error) throw new StreamApiError(a.error);
        }
      }
      // An empty message ends it: the server answers once the stream is made, or why not.
      const end = await c.request(to, new Uint8Array(0), { timeout: RESTORE_FINISH_TIMEOUT_MS });
      const a = end.json<Answer>();
      if (a.error) throw new StreamApiError(a.error);
    },
    async close() {
      const c = await conn?.catch(() => undefined);
      await c?.close();
    },
  };
}
