import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import { errorText } from "../errors.ts";
import { type BusTrust, tlsOf } from "./tls.ts";

/**
 * Whether a bus's server answers a new connection now (goal 173): the check of a RunPod pod's own
 * server, which its supervisor runs (supervisor/leaf.ts). It connects over TLS, signs in with the
 * key's seed, makes one round trip (a PING and the server's PONG) and closes, all within
 * `timeoutMs`. A server that hangs, whatever its process does, fails it: it takes no connection,
 * signs nothing in, or never answers the PING. It never reconnects, and closes the connection it
 * made. One the server never sent its first line on stays open on this side until the server
 * closes it or ends: the NATS library leaves such a connection alone. A hung server holds at most
 * one for each failed check, and the watch kills it at the third; a slow one closes it once it
 * goes unsigned for the server's sign-in time (core/link/leaf.ts's BUS_SIGN_IN_SECONDS).
 * Undefined when the server answered; otherwise why not, in words.
 */
export async function probeBus(
  url: string,
  name: string,
  signIn: { seed: Uint8Array; trust?: BusTrust | undefined },
  timeoutMs: number,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`no answer within ${timeoutMs / 1000} s`), timeoutMs);
  });
  const made = connect({
    servers: url,
    name,
    timeout: timeoutMs,
    reconnect: false,
    maxReconnectAttempts: 0,
    tls: tlsOf(signIn.trust, url),
    authenticator: nkeyAuthenticator(signIn.seed),
  });
  const asked = made.then(
    async (nc): Promise<string | undefined> => {
      try {
        await nc.flush();
        return undefined;
      } catch (err) {
        return `no answer to its round trip: ${errorText(err)}`;
      }
    },
    (err: unknown) => `no connection: ${errorText(err)}`,
  );
  try {
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
    // Closed whether it answered, failed or is still on its way: a connection made late too.
    void made.then(
      (nc) => nc.close().catch(() => undefined),
      () => undefined,
    );
  }
}
