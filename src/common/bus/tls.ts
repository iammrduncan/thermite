import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { type ConnectionOptions, checkServerIdentity } from "node:tls";
import type { TlsOptions } from "@nats-io/transport-node";

/**
 * Where the bus is and how a part trusts it (goal 168): the settings that name the server and its
 * authority, read and checked at start, and the client's TLS options. Every connection is over TLS.
 */

/** The setting that names the server: control and every rig's supervisor need it. */
export const BUS_URL_SETTING = "THERMITE_NATS_URL";
/** The settings that give a supervisor the authority it trusts the server through: the PEM itself… */
export const BUS_CA_SETTING = "THERMITE_NATS_CA";
/** …or a file that holds it, read at each connection. */
export const BUS_CA_FILE_SETTING = "THERMITE_NATS_CA_FILE";

/** The certificate authority a part trusts the bus's server through: its PEM, or a file of it. */
export type BusTrust = { ca: string } | { caFile: string };

/**
 * The bus's address from its setting (`setting`: another that names one), or undefined when not
 * set. A bad one stops the part.
 */
export function busUrl(
  env: Record<string, string | undefined>,
  setting = BUS_URL_SETTING,
): string | undefined {
  const raw = env[setting]?.trim();
  if (!raw) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== "nats:" || !url.hostname)
    throw new Error(`${setting} takes a nats:// address, such as nats://nats:4222, not "${raw}"`);
  return raw;
}

/**
 * The authority a supervisor trusts the bus's server through, from its settings: the certificate
 * itself (THERMITE_NATS_CA, as a rig on a cluster gets it), or a file of it (THERMITE_NATS_CA_FILE,
 * read at each connection, so that it may come after the supervisor starts); undefined when neither
 * is set, and the system's authorities serve. Both set, or a certificate that is not an
 * authority's, stops the part at start.
 */
export function busTrust(env: Record<string, string | undefined>): BusTrust | undefined {
  const ca = env[BUS_CA_SETTING]?.trim();
  const caFile = env[BUS_CA_FILE_SETTING]?.trim();
  if (ca && caFile) throw new Error(`set ${BUS_CA_SETTING} or ${BUS_CA_FILE_SETTING}, not both`);
  if (caFile) return { caFile };
  if (!ca) return undefined;
  let authority = false;
  try {
    authority = new X509Certificate(ca).ca;
  } catch {
    authority = false;
  }
  if (!authority)
    throw new Error(
      `${BUS_CA_SETTING} takes the PEM certificate of the authority that signed the bus's server's certificate`,
    );
  return { ca: `${ca}\n` };
}

/** The server's host and port, for logs: never a user or password in its address. */
export const where = (url: string) => new URL(url).host;

/** The host of a nats:// address, as a certificate names it: no brackets round an IPv6 one. */
export const busHost = (url: string) => new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");

/**
 * The client's TLS options: always TLS, with the authority when one is given. A server reached at
 * an address, not a name, is checked against the certificate's addresses: the NATS client gives
 * Node's TLS no name then, and Node would check the certificate against "localhost".
 */
export function tlsOf(trust: BusTrust | undefined, url: string): TlsOptions {
  const host = busHost(url);
  if (!isIP(host)) return trust ?? {};
  const byAddress: TlsOptions & Pick<ConnectionOptions, "checkServerIdentity"> = {
    ...trust,
    checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert),
  };
  return byAddress;
}
