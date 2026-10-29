import { type BusTrust, connectOnce } from "../../common/bus.ts";
import { jetStreamFiguresSubject, reloadSubject } from "../../core/link/users.ts";

/**
 * What control asks the bus's server as its system user (goal 168): to read its configuration
 * again, and, for control's disk floor (goal 173), how much of its store JetStream uses against its
 * limit, from the server's monitoring. Each call opens a connection of its own and closes it.
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
