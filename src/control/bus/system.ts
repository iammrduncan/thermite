import type { NatsConnection } from "@nats-io/transport-node";
import { type BusTrust, connectOnce } from "../../common/bus/index.ts";
import {
  jetStreamFiguresSubject,
  reloadSubject,
  type ServerFigures,
  serverFiguresSubject,
} from "../../core/link/users.ts";

/**
 * What control asks the bus's server as its system user (goal 168): to read its configuration
 * again, and, for control's disk floor (goal 173), how much of its store JetStream uses against its
 * limit, from the server's monitoring; each of these opens a connection of its own and closes it.
 * And the server's figures for Metrics (goal 179, ServerLook), on one connection kept while the
 * page asks.
 */

/** How long a request to the server's system account may wait for the answer. It then fails. */
export const BUS_SYSTEM_TIMEOUT_MS = 10_000;

/** Asks the server one question as control's system user; the answer's JSON. */
async function askServer<T>(
  url: string,
  seed: Uint8Array,
  trust: BusTrust | undefined,
  subject: (serverId: string) => string,
): Promise<T> {
  const nc = await connectOnce(url, "control (system)", { seed, trust });
  try {
    const id = nc.info?.server_id;
    if (!id) throw new Error("the bus's server gave no id");
    const m = await nc.request(subject(id), "", { timeout: BUS_SYSTEM_TIMEOUT_MS });
    return m.json<T>();
  } finally {
    await nc.close();
  }
}

/**
 * Asks the server at `url` to read its configuration again, as control's system user (`seed`),
 * trusting it through `trust`: the users file and the certificate control wrote take effect without
 * a restart, and the connections of a user it no longer has are closed. Throws when the server
 * can't be reached, refuses the user, or says the reload failed.
 */
export async function reloadBus(url: string, seed: Uint8Array, trust?: BusTrust): Promise<void> {
  const answer = await askServer<{ error?: { description?: string } }>(
    url,
    seed,
    trust,
    reloadSubject,
  );
  if (answer.error)
    throw new Error(`the bus's server did not reload: ${answer.error.description ?? "no reason"}`);
}

/** How much of its store JetStream uses, and its limit, in bytes. */
export interface BusStoreUse {
  used: number;
  limit: number;
}

/**
 * JetStream's use of the server's store and its limit (`max_file_store`, or NATS's own default of
 * three quarters of the free space when the server started), as the server's monitoring gives
 * them. Throws when the server can't be reached or gives no figures.
 */
export async function busStoreUse(
  url: string,
  seed: Uint8Array,
  trust?: BusTrust,
): Promise<BusStoreUse> {
  const answer = await askServer<{
    data?: { storage?: unknown; config?: { max_storage?: unknown } };
    error?: { description?: string };
  }>(url, seed, trust, jetStreamFiguresSubject);
  const used = answer.data?.storage;
  const limit = answer.data?.config?.max_storage;
  if (typeof used !== "number" || typeof limit !== "number")
    throw new Error(
      `the bus's server gave no figures of its store: ${answer.error?.description ?? "none in its answer"}`,
    );
  return { used, limit };
}

/** How long ServerLook keeps its connection after the last question: then it closes it. */
const SERVER_LOOK_IDLE_MS = 60_000;

/** The server's answer to a question of its system account: its figures, or why not. */
interface ServerAnswer<T> {
  data?: T;
  error?: { description?: string };
}

interface ServerLookOptions {
  url: string;
  /** The seed of control's system user. */
  seed: Uint8Array;
  trust?: BusTrust | undefined;
  idleMs?: number | undefined;
}

/**
 * Asks the bus's server for its figures (the monitoring's VARZ, CONNZ, LEAFZ and JSZ), as
 * control's system user, on one connection: Metrics asks every 2 seconds while it is open, and a
 * connection for each question would show among the connections it lists. The connection opens at
 * the first question and closes SERVER_LOOK_IDLE_MS after the last; one that fails is opened again
 * at the next.
 */
export class ServerLook {
  private nc: Promise<NatsConnection> | undefined;
  private idle: NodeJS.Timeout | undefined;

  private readonly o: ServerLookOptions;

  constructor(o: ServerLookOptions) {
    this.o = o;
  }

  private connection(): Promise<NatsConnection> {
    if (!this.nc) {
      const opening = connectOnce(this.o.url, "control (figures)", {
        seed: this.o.seed,
        trust: this.o.trust,
      });
      this.nc = opening;
      opening.then(
        (nc) =>
          void nc.closed().then(() => {
            if (this.nc === opening) this.nc = undefined;
          }),
        () => {
          if (this.nc === opening) this.nc = undefined;
        },
      );
    }
    return this.nc;
  }

  /** The server's figures `what`, with the monitoring's options; throws on a refusal or no answer. */
  async ask<T>(what: ServerFigures, options: Record<string, unknown> = {}): Promise<T> {
    clearTimeout(this.idle);
    try {
      const nc = await this.connection();
      const id = nc.info?.server_id;
      if (!id) throw new Error("the bus's server gave no id");
      const m = await nc.request(serverFiguresSubject(id, what), JSON.stringify(options), {
        timeout: BUS_SYSTEM_TIMEOUT_MS,
      });
      const answer = m.json<ServerAnswer<T>>();
      if (answer.error || answer.data === undefined)
        throw new Error(
          `the bus's server gave no ${what}: ${answer.error?.description ?? "none in its answer"}`,
        );
      return answer.data;
    } finally {
      this.idle = setTimeout(() => void this.close(), this.o.idleMs ?? SERVER_LOOK_IDLE_MS);
      this.idle.unref?.();
    }
  }

  /** Closes its connection, if it holds one. */
  async close(): Promise<void> {
    clearTimeout(this.idle);
    const nc = this.nc;
    this.nc = undefined;
    await (await nc?.catch(() => undefined))?.close();
  }
}
