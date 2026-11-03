import { X509Certificate } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../common/env.ts";
import { writeAtomic } from "../../common/fs.ts";
import { envLine, LEAF_CERT_DAYS, LEAF_ENV, leafTlsName } from "../../core/link/leaf.ts";
import { LIVE_RUNS_PER_RIG } from "../../core/link/live.ts";
import type { LeafRigs } from "../../core/link/users.ts";
import type { ControlStore } from "../store/index.ts";
import { certFingerprint, makeCa, makeServerCert } from "./cert.ts";
import { BUS_TLS_FILES } from "./tls.ts";

/**
 * Rigs on RunPod on the message bus (goal 168): control's server dials each pod's own server as a
 * leaf node (core/link/leaf.ts). At a launch control mints the pod's TLS key and certificate,
 * signed by an authority of the pod's own whose key it drops at once, so that nothing else can
 * ever pass for the pod; the pod gets them with control's own authority in its launch values, and
 * control keeps the pod's authority's certificate. Once RunPod gives the pod's public address
 * (runpod/rigs.ts), control's users file names the pod (BusUsers in users.ts), with that
 * authority's certificate in a file of its own beside it.
 */

/**
 * Where the bus's server reads the folder control writes for it (THERMITE_NATS_CONFIG_DIR, as
 * control sees it): compose.yaml, the release bundle's template and the acceptance stacks mount it
 * there. The leaf nodes' files are named by this path in the users file.
 */
export const BUS_SERVER_DIR = "/etc/nats/thermite";

/** The file of a pod's authority, in the folder control writes for the bus's server. */
export const leafCaFile = (rig: string) => `leaf-${rig}-ca.pem`;
/** The pod authorities' files, as leafCaFile names them. */
const LEAF_CA_FILE = /^leaf-[a-z0-9-]+-ca\.pem$/;

/** What a launch gives a pod for its leaf node, and what control keeps of it. */
export interface MintedLeaf {
  /** The pod's launch values for its leaf (LEAF_ENV): its key among them, which control drops. */
  env: Record<(typeof LEAF_ENV)[keyof typeof LEAF_ENV], string>;
  /** The pod's authority's certificate, which control's server trusts on its connection to the pod. */
  podCa: string;
}

/**
 * The pod's leaf keys for a launch: an authority of the pod's own, which signs the pod's
 * certificate for its leaf name (leafTlsName) and the pod's loopback, where its supervisor
 * connects; then its key is gone. `controlCa` is control's authority, which the pod's server
 * checks control's certificate against.
 */
export function mintLeaf(rig: string, controlCa: string, now: Date = new Date()): MintedLeaf {
  const caName = `Thermite: the leaf node authority of rig ${rig}`;
  const ca = makeCa(now, LEAF_CERT_DAYS, caName);
  const pod = makeServerCert(ca, [leafTlsName(rig), "127.0.0.1"], now, LEAF_CERT_DAYS, {
    caName,
    subject: `Thermite: the pod of rig ${rig}`,
  });
  log("control", "made a pod's leaf node keys", {
    rig,
    authority: certFingerprint(ca.cert),
    certificate: certFingerprint(pod.cert),
  });
  return {
    env: {
      [LEAF_ENV.cert]: envLine(`${pod.cert}${ca.cert}`),
      [LEAF_ENV.key]: envLine(pod.key),
      [LEAF_ENV.controlCa]: envLine(controlCa),
    },
    podCa: ca.cert,
  };
}

/** A leaf rig as control keeps it: its pod's authority, and the pod's address once RunPod gave it. */
interface KeptLeaf {
  rig: string;
  ca: string;
  address: string | null;
}

/** The rigs launched with a leaf and not retired, with the pod's address when RunPod gave one. */
export function leafRigsOf(store: ControlStore): KeptLeaf[] {
  return store.tunnels
    .list()
    .flatMap((t) =>
      t.leaf_ca && !store.retired.get(t.rig)
        ? [{ rig: t.rig, ca: t.leaf_ca, address: t.leaf_address }]
        : [],
    );
}

/**
 * The leaf rigs as the users file names them, with the runs control gives each: each one's
 * account, and its pod's address only when `dial` says the server may dial it (BusUsers).
 */
export function leafRigsFor(
  store: ControlStore,
  rigs: readonly KeptLeaf[],
  dial: (rig: string) => boolean = () => true,
): LeafRigs {
  const runs = store.runRegistry.runsByRig(LIVE_RUNS_PER_RIG);
  return {
    rigs: rigs.map((r) => ({
      rig: r.rig,
      runs: runs.get(r.rig) ?? [],
      address: r.address && dial(r.rig) ? r.address : undefined,
      caFile: join(BUS_SERVER_DIR, leafCaFile(r.rig)),
    })),
    certFile: join(BUS_SERVER_DIR, BUS_TLS_FILES.cert),
    keyFile: join(BUS_SERVER_DIR, BUS_TLS_FILES.key),
  };
}

/**
 * Writes each leaf rig's authority to its file in `dir` when it is not there as it should be, and
 * removes the files of rigs that are no longer leaf rigs. True when it changed a file.
 */
export function writeLeafFiles(dir: string, rigs: readonly KeptLeaf[]): boolean {
  let changed = false;
  const keep = new Set<string>();
  for (const r of rigs) {
    const file = leafCaFile(r.rig);
    keep.add(file);
    const path = join(dir, file);
    if (existsSync(path) && readFileSync(path, "utf8") === r.ca) continue;
    // Read before it is written: one that is no certificate would stop the server at its reload.
    new X509Certificate(r.ca);
    writeAtomic(path, r.ca, 0o644);
    changed = true;
  }
  for (const file of readdirSync(dir))
    if (LEAF_CA_FILE.test(file) && !keep.has(file)) {
      rmSync(join(dir, file), { force: true });
      changed = true;
    }
  return changed;
}
