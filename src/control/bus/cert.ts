import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import { isIP, isIPv4 } from "node:net";
import { CONTROL_LEAF_NAME } from "../../core/link/leaf.ts";

/**
 * The certificates of the message bus's TLS (goal 168): control's own certificate authority, the
 * server's certificate it signs, and each RunPod pod's authority and certificate (leaf.ts). Node can read a certificate but not make one, so this module
 * writes the few DER structures of an X.509 certificate itself (RFC 5280); every key is made and
 * every signature is made by node:crypto. Keys are ECDSA on P-256, signed with SHA-256.
 */

/** A certificate and its private key, both PEM. */
export interface CertAndKey {
  cert: string;
  key: string;
}

// ---------------------------------------------------------------- DER, as RFC 5280 needs it

function der(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  const n = content.length;
  const length: number[] = [];
  if (n < 0x80) length.push(n);
  else {
    for (let v = n; v > 0; v = Math.floor(v / 256)) length.unshift(v % 256);
    length.unshift(0x80 | length.length);
  }
  return Buffer.concat([Buffer.from([tag, ...length]), content]);
}

const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const set = (...parts: Buffer[]) => der(0x31, ...parts);
const octets = (b: Buffer) => der(0x04, b);
const utf8 = (s: string) => der(0x0c, Buffer.from(s, "utf8"));
const yes = der(0x01, Buffer.from([0xff]));
/** A BIT STRING whose last byte has `unused` bits that are not part of it. */
const bits = (b: Buffer, unused = 0) => der(0x03, Buffer.from([unused]), b);
/** A positive INTEGER from its big-endian bytes. */
const integer = (b: Buffer) =>
  der(0x02, b[0] !== undefined && b[0] & 0x80 ? Buffer.from([0]) : Buffer.alloc(0), b);

/** An OBJECT IDENTIFIER from its arcs. */
function oid(arcs: readonly number[]): Buffer {
  const [first = 0, second = 0, ...rest] = arcs;
  const bytes = [40 * first + second];
  for (const n of rest) {
    const chunk = [n % 128];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128))
      chunk.unshift(0x80 | (v % 128));
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

/** UTCTime before 2050, GeneralizedTime from then on, to the second. */
function time(d: Date): Buffer {
  const full = `${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
  return d.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(full.slice(2)))
    : der(0x18, Buffer.from(full));
}

/** An address's bytes, for a certificate's iPAddress name: 4 for IPv4, 16 for IPv6. */
function ipBytes(ip: string): Buffer {
  if (isIPv4(ip)) return Buffer.from(ip.split(".").map(Number));
  const [head = "", tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return Buffer.from(
    groups.flatMap((g) => [Number.parseInt(g, 16) >> 8, Number.parseInt(g, 16) & 0xff]),
  );
}

/** The object identifiers a certificate here names, from RFC 5280 and RFC 5758, as arcs. */
const OID = {
  ecdsaSha256: [1, 2, 840, 10045, 4, 3, 2],
  commonName: [2, 5, 4, 3],
  subjectKeyId: [2, 5, 29, 14],
  keyUsage: [2, 5, 29, 15],
  altNames: [2, 5, 29, 17],
  basicConstraints: [2, 5, 29, 19],
  authorityKeyId: [2, 5, 29, 35],
  extKeyUsage: [2, 5, 29, 37],
  serverAuth: [1, 3, 6, 1, 5, 5, 7, 3, 1],
  clientAuth: [1, 3, 6, 1, 5, 5, 7, 3, 2],
} as const;

const ALGORITHM = sequence(oid(OID.ecdsaSha256));
const name = (commonName: string) => sequence(set(sequence(oid(OID.commonName), utf8(commonName))));
const extension = (id: readonly number[], critical: boolean, value: Buffer) =>
  sequence(oid(id), ...(critical ? [yes] : []), octets(value));
/** A key's identifier: the first 20 bytes of its public key's SHA-256. */
const keyId = (publicKey: KeyObject) =>
  createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest()
    .subarray(0, 20);

const pem = (body: Buffer) =>
  `-----BEGIN CERTIFICATE-----\n${body.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n$/, "")}\n-----END CERTIFICATE-----\n`;

// ---------------------------------------------------------------- the two certificates

/** The bus's certificate authority's name, as its certificates show it. */
export const BUS_CA_NAME = "Thermite control: the message bus's certificate authority";
/** The bus's server certificate's name: a pod's server takes it as control's (core/link/leaf.ts). */
export const BUS_SERVER_NAME = CONTROL_LEAF_NAME;

/** How long before `from` a certificate is valid: an hour, for a clock a little behind. */
const EARLY_MS = 3_600_000;

interface Making {
  subject: string;
  publicKey: KeyObject;
  /** The authority's name and its key, which signs; its own name and key for itself. */
  issuer: { name: string; key: KeyObject };
  from: Date;
  days: number;
  extensions: Buffer[];
}

function certificate(m: Making): string {
  const notBefore = new Date(m.from.getTime() - EARLY_MS);
  const notAfter = new Date(m.from.getTime() + m.days * 86_400_000);
  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x40;
  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    ALGORITHM,
    name(m.issuer.name),
    sequence(time(notBefore), time(notAfter)),
    name(m.subject),
    m.publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, sequence(...m.extensions)),
  );
  return pem(sequence(tbs, ALGORITHM, bits(sign("sha256", tbs, m.issuer.key))));
}

const keyPair = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
const keyPem = (key: KeyObject) => key.export({ type: "pkcs8", format: "pem" }).toString();

/**
 * A certificate authority named `subject` (the bus's own by default), valid from `from` for
 * `days`: it signs certificates and nothing else.
 */
export function makeCa(from: Date, days: number, subject: string = BUS_CA_NAME): CertAndKey {
  const { publicKey, privateKey } = keyPair();
  const id = keyId(publicKey);
  const cert = certificate({
    subject,
    publicKey,
    issuer: { name: subject, key: privateKey },
    from,
    days,
    extensions: [
      extension(OID.basicConstraints, true, sequence(yes, integer(Buffer.from([0])))),
      // keyCertSign and cRLSign.
      extension(OID.keyUsage, true, bits(Buffer.from([0x06]), 1)),
      extension(OID.subjectKeyId, false, octets(id)),
    ],
  });
  return { cert, key: keyPem(privateKey) };
}

/** Who else a server's certificate names, and whether it may also sign in as a client. */
export interface ServerCertOptions {
  /** Its own name (the bus's server by default). */
  subject?: string | undefined;
  /** The authority's name, as makeCa gave it (the bus's own by default). */
  caName?: string | undefined;
  /**
   * Also good for a client's side of TLS: the bus's server shows it when it dials a RunPod pod's
   * server as a leaf node, and the pod's server takes no other.
   */
  client?: boolean | undefined;
}

/**
 * A server's certificate for these names (host names or addresses), signed by the authority,
 * valid from `from` for `days`. Throws on a name that is neither.
 */
export function makeServerCert(
  ca: CertAndKey,
  names: readonly string[],
  from: Date,
  days: number,
  o: ServerCertOptions = {},
): CertAndKey {
  if (!names.length) throw new Error("a server certificate needs at least one name");
  const altNames = names.map((n) => {
    if (isIP(n)) return der(0x87, ipBytes(n));
    if (!/^[A-Za-z0-9.-]+$/.test(n))
      throw new Error(`not a host name or an address: ${JSON.stringify(n)}`);
    return der(0x82, Buffer.from(n, "ascii"));
  });
  const authorityKeyId = keyId(new X509Certificate(ca.cert).publicKey);
  const { publicKey, privateKey } = keyPair();
  const uses = [oid(OID.serverAuth), ...(o.client ? [oid(OID.clientAuth)] : [])];
  const cert = certificate({
    subject: o.subject ?? BUS_SERVER_NAME,
    publicKey,
    issuer: { name: o.caName ?? BUS_CA_NAME, key: createPrivateKey(ca.key) },
    from,
    days,
    extensions: [
      extension(OID.basicConstraints, true, sequence()),
      // digitalSignature.
      extension(OID.keyUsage, true, bits(Buffer.from([0x80]), 7)),
      extension(OID.extKeyUsage, false, sequence(...uses)),
      extension(OID.altNames, false, sequence(...altNames)),
      extension(OID.subjectKeyId, false, octets(keyId(publicKey))),
      extension(OID.authorityKeyId, false, sequence(der(0x80, authorityKeyId))),
    ],
  });
  return { cert, key: keyPem(privateKey) };
}

/** A certificate's fingerprint for logs and pages: the first 16 hex digits of its SHA-256. */
export const certFingerprint = (cert: string) =>
  new X509Certificate(cert).fingerprint256.replace(/:/g, "").slice(0, 16).toLowerCase();
