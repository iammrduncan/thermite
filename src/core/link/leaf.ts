import { RIG_ID } from "../ids.ts";

/**
 * The link's contract for a rig on RunPod (goal 168, step 5): a leaf node. A pod can't reach
 * control, and control need not be public: the pod runs a small NATS server of its own, which
 * accepts one connection only, from control's server, which dials it as a leaf node. Its
 * supervisor connects to that server on the pod's loopback and is on the bus as every other
 * rig's supervisor is.
 *
 * - **Keys, checked both ways.** Control mints the pod's TLS key and certificate at launch,
 *   signed by an authority of the pod's own that control keeps and uses for nothing else, and
 *   gives them to the pod with control's own authority. Control's server trusts only that pod's
 *   authority on its connection to the pod; the pod's server takes only a client certificate that
 *   control's authority signed (control's server's own).
 * - **What the connection may do.** On control's server the connection binds to an account of the
 *   rig's own (leafAccount), which holds nothing: it reaches the bus's account only through the
 *   services that account gives it, one for each subject the rig's user may publish
 *   (rigPermissions in users.ts), and answers come back only to what asked. So the leaf may do what
 *   the rig may do on the bus, never more, whatever the pod's own server allows.
 * - **The pod's address** comes from RunPod's API once the pod runs: its public address and the
 *   public port RunPod maps to LEAF_PORT.
 */

/**
 * The JetStream API's prefix on a leaf rig's connection, where `$JS.API` is: the server lets no
 * `$JS.API` subject across a leaf connection bound to an account without JetStream of its own, so
 * the leaf account takes the API's services under this name (leafServices in users.ts), and the
 * pod's supervisor's JetStream client sends its calls here.
 */
export const LEAF_JS_API = "thermite.jsapi";

/** NATS's own port for leaf nodes: the pod's server listens there, and RunPod maps it to a public one. */
export const LEAF_PORT = 7422;
/** The pod's server's port for its supervisor, on the pod's loopback only. */
export const POD_BUS_PORT = 4222;
/** The bus as the pod's supervisor reaches it: its pod's own server. */
export const POD_BUS_URL = `nats://127.0.0.1:${POD_BUS_PORT}`;

/**
 * The launch values of the leaf (core/tunnel.ts has the rest), each a PEM text in base64 on one
 * line (envLine): the pod's certificate with its authority's after it, the pod's private key (a
 * secret, as the enrollment code is), and control's authority, which the pod's server checks
 * control's certificate against.
 */
export const LEAF_ENV = {
  cert: "THERMITE_LEAF_CERT",
  key: "THERMITE_LEAF_KEY",
  controlCa: "THERMITE_LEAF_CONTROL_CA",
} as const;

/**
 * The name of control's server's certificate, which it shows when it dials a pod: the pod's server
 * takes a client certificate of control's authority with this name, and no other (podServerConfig).
 */
export const CONTROL_LEAF_NAME = "Thermite: the message bus's server";

/** How long the pod's authority and certificate are valid: control never makes others for a pod. */
export const LEAF_CERT_DAYS = 3650;

/** A PEM text on one line, for a launch value. */
export const envLine = (pem: string) => Buffer.from(pem, "utf8").toString("base64");

/** A PEM text from its launch value. Throws, in words, when it is not one. */
export function fromEnvLine(name: string, line: string): string {
  const pem = Buffer.from(line.trim(), "base64").toString("utf8");
  if (!/^-----BEGIN [A-Z ]+-----\n[\s\S]+-----END [A-Z ]+-----\n?$/.test(pem))
    throw new Error(`${name} is not a PEM text in base64`);
  return pem;
}

/** The account a rig's leaf connection binds to on control's server. */
export function leafAccount(rig: string): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for a leaf account: ${rig}`);
  return `LEAF_${rig}`;
}

/**
 * The name the pod's certificate is made for: a name in `.invalid`, which never resolves
 * (RFC 6761). Control's server dials the pod at an address, which no certificate made at launch
 * can name; NATS checks the certificate against the remote's first URL that is a name instead
 * (leafRemote in users.ts), so the remote lists this one too, and only the pod's authority, which
 * signed nothing else, makes it good.
 */
export function leafTlsName(rig: string): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for a leaf certificate: ${rig}`);
  return `${rig}.leaf.thermite.invalid`;
}

/** A pod's address as RunPod gives it: its public address and the public port of LEAF_PORT. */
export const LEAF_ADDRESS = /^[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$/;

/** The files of the pod's server, where its supervisor writes them. */
export interface PodBusFiles {
  /** The pod's certificate, with its authority's after it. */
  cert: string;
  key: string;
  /** Control's authority. */
  controlCa: string;
}

/**
 * The pod's server's configuration: its supervisor's port on the pod's loopback, over TLS, which
 * only the supervisor's key may sign in to; and the leaf node's port on every address, over TLS,
 * which takes only a client certificate control's authority signed for control's server
 * (CONTROL_LEAF_NAME). It advertises no other address, keeps no stream (no JetStream), and takes
 * messages as large as the bus does.
 */
export function podServerConfig(o: {
  files: PodBusFiles;
  supervisorKey: string;
  maxPayload: number;
}): string {
  const tls = { cert_file: o.files.cert, key_file: o.files.key };
  const config = {
    listen: `127.0.0.1:${POD_BUS_PORT}`,
    max_payload: o.maxPayload,
    tls,
    authorization: { users: [{ nkey: o.supervisorKey }] },
    // The leaf node's own users: the server's would otherwise apply, and control signs in with
    // its certificate alone, mapped to a user by its name once control's authority checked it.
    leafnodes: {
      listen: `0.0.0.0:${LEAF_PORT}`,
      no_advertise: true,
      tls: { ...tls, ca_file: o.files.controlCa, verify_and_map: true },
      authorization: { users: [{ user: `CN=${CONTROL_LEAF_NAME}` }] },
    },
  };
  return [
    "# The pod's own NATS server, written by its supervisor at each start: its supervisor signs in",
    "# on the loopback, and control's server dials the leaf node's port. Edits here are lost.",
    ...Object.entries(config).map(([k, v]) => `${k}: ${JSON.stringify(v, null, 2)}`),
    "",
  ].join("\n");
}
