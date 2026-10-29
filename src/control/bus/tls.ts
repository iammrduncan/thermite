import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { BUS_URL_SETTING, busUrl } from "../../common/bus.ts";
import { log } from "../../common/env.ts";
import { writeAtomic } from "../../common/fs.ts";
import { CONTROL_STATE } from "../../core/backup.ts";
import { type CertAndKey, certFingerprint, makeCa, makeServerCert } from "./cert.ts";

/**
 * The message bus's TLS (goal 168), as control keeps it. Rigs reach the bus's server on NATS's
 * own port over TLS. Control makes its own certificate authority at its first start with the bus
 * and keeps it in its state folder beside its signing key; it signs the server's certificate for
 * the names the server is reached by, and writes it with its key to the folder the server reads
 * (THERMITE_NATS_CONFIG_DIR). Every rig control sets up gets the authority's certificate, as it
 * gets control's public key, and trusts the server through it.
 */

/** The authority's files in control's state folder. */
export const BUS_CA_FILES = { cert: CONTROL_STATE.busCaCert, key: CONTROL_STATE.busCaKey } as const;
/** The server's files in the folder control writes for it, beside its users. */
export const BUS_TLS_FILES = { cert: "server-cert.pem", key: "server-key.pem" } as const;

/** How long the authority is valid: control never makes another by itself. */
export const BUS_CA_DAYS = 3650;
/** How long a server certificate is valid. */
export const BUS_SERVER_DAYS = 397;
/** A server certificate this close to its end is made anew. */
export const BUS_RENEW_DAYS = 30;

/** The files' modes: the server reads its key through its group, control's (compose.yaml). */
const MODES = { caCert: 0o644, caKey: 0o600, cert: 0o644, key: 0o640 };

/** NATS's own port: the bus's port for rigs, unless their address names another. */
export const BUS_PORT = 4222;
/** The setting that names the bus as rigs outside control's own network reach it. */
export const BUS_PUBLIC_URL_SETTING = "THERMITE_NATS_PUBLIC_URL";
/** The setting of a file control also writes its authority's certificate to, for rigs beside it. */
export const BUS_CA_EXPORT_SETTING = "THERMITE_NATS_CA_EXPORT";

/**
 * The bus's address as control reaches it, from its setting. Control needs its bus: it keeps every
 * rig's events in the bus's events stream, and derives its records from them there, whether a rig
 * reports over the bus or over HTTP. Not set stops control at start, with the setting's name; a
 * bad one too (busUrl).
 */
export function controlBusUrl(env: Record<string, string | undefined>): string {
  const url = busUrl(env);
  if (!url)
    throw new Error(
      `control needs its message bus: set ${BUS_URL_SETTING} to its NATS server, such as nats://nats:4222. Control keeps every rig's events in the bus's EVENTS stream and derives its records from them there, whether a rig reports over the bus or over HTTP`,
    );
  return url;
}

/**
 * The bus's address for the rigs control sets up: its setting, or else control's address for
 * rigs (THERMITE_CONTROL_PUBLIC_URL) with NATS's own port; undefined when control has neither.
 * A bad one stops control at start.
 */
export function busPublicUrl(
  env: Record<string, string | undefined>,
  controlPublicUrl: string | undefined,
): string | undefined {
  const set = busUrl(env, BUS_PUBLIC_URL_SETTING);
  if (set) return set;
  if (!controlPublicUrl) return undefined;
  return `nats://${new URL(controlPublicUrl).hostname}:${BUS_PORT}`;
}

export interface BusTlsOptions {
  /** Control's state folder (THERMITE_CONTROL_DIR): the authority's files. */
  stateDir: string;
  /** The folder control writes the server's files to (THERMITE_NATS_CONFIG_DIR). */
  configDir: string;
  /** The names the server is reached by: control's own address's host, and the rigs'. */
  names: readonly string[];
  now?: () => Date;
}

/**
 * Control's certificate authority for the bus, and the server's certificate it keeps current.
 * Made with control: the authority is read from the state folder, or made there the first time.
 * Throws, with what to do, when its files are there but do not make one authority.
 */
export class BusTls {
  /** The authority's certificate, which every rig on the bus trusts. */
  readonly caCert: string;
  private readonly ca: CertAndKey;
  private readonly o: BusTlsOptions;
  readonly names: readonly string[];

  constructor(o: BusTlsOptions) {
    this.o = o;
    this.names = [...new Set(o.names.filter(Boolean))];
    this.ca = keepCa(o.stateDir, this.now());
    this.caCert = this.ca.cert;
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  /**
   * Makes the server's certificate and key anew, and writes them, when there is none, its key does
   * not match, another authority signed it, it lacks one of the names, or it ends within
   * BUS_RENEW_DAYS. The key is written first: the server waits for its certificate. True when it
   * wrote them, so that the server reads them again.
   */
  write(): boolean {
    const cert = join(this.o.configDir, BUS_TLS_FILES.cert);
    const key = join(this.o.configDir, BUS_TLS_FILES.key);
    const why = this.staleBecause(cert, key);
    if (!why) return false;
    const made = makeServerCert(this.ca, this.names, this.now(), BUS_SERVER_DAYS);
    writeAtomic(key, made.key, MODES.key);
    writeAtomic(cert, made.cert, MODES.cert);
    const validTo = new Date(new X509Certificate(made.cert).validTo).toISOString();
    log("control", "the bus's server certificate made", {
      why,
      names: this.names,
      valid_to: validTo,
      fingerprint: certFingerprint(made.cert),
    });
    return true;
  }

  /** Why the server's files must be made anew, or undefined while they serve. */
  private staleBecause(certFile: string, keyFile: string): string | undefined {
    if (!existsSync(certFile) || !existsSync(keyFile)) return "none yet";
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(readFileSync(certFile));
      const key = createPublicKey(createPrivateKey(readFileSync(keyFile)));
      if (!cert.publicKey.equals(key)) return "its key does not match it";
    } catch {
      return "it can't be read";
    }
    const authority = new X509Certificate(this.ca.cert);
    if (!cert.checkIssued(authority) || !cert.verify(authority.publicKey))
      return "another authority signed it";
    const missing = this.names.find((n) => (isIP(n) ? !cert.checkIP(n) : !cert.checkHost(n)));
    if (missing !== undefined) return `it does not name ${missing}`;
    const left = Date.parse(cert.validTo) - this.now().getTime();
    if (left < BUS_RENEW_DAYS * 86_400_000) return `it ends within ${BUS_RENEW_DAYS} days`;
    return undefined;
  }
}

/** The authority from the state folder, made there first when neither of its files is. */
function keepCa(dir: string, now: Date): CertAndKey {
  const certFile = join(dir, BUS_CA_FILES.cert);
  const keyFile = join(dir, BUS_CA_FILES.key);
  const has = [existsSync(certFile), existsSync(keyFile)];
  if (!has[0] && !has[1]) {
    const made = makeCa(now, BUS_CA_DAYS);
    writeAtomic(keyFile, made.key, MODES.caKey);
    writeAtomic(certFile, made.cert, MODES.caCert);
    log("control", "made the bus's certificate authority", {
      fingerprint: certFingerprint(made.cert),
      valid_to: new Date(new X509Certificate(made.cert).validTo).toISOString(),
    });
    return made;
  }
  const fix = `delete both ${BUS_CA_FILES.cert} and ${BUS_CA_FILES.key} from control's state folder for a new one, then move every rig on the bus onto its images again, so that it gets the new certificate`;
  if (!has[0] || !has[1])
    throw new Error(`the bus's certificate authority has one of its two files only: ${fix}`);
  const ca = { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8") };
  try {
    const cert = new X509Certificate(ca.cert);
    const matches = cert.publicKey.equals(createPublicKey(createPrivateKey(ca.key)));
    if (cert.ca && matches) return ca;
  } catch {
    // Said below, with the rest.
  }
  throw new Error(`the bus's certificate authority in ${certFile} does not open: ${fix}`);
}
