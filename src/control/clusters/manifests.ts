import { HEALTH } from "../../core/api/harness/supervisor.ts";
import { HEALTH_URLS, healthProbe } from "../../core/health.ts";
import { HARNESS_INBOX_DIR, SUPERVISOR_INBOX_DIR } from "../../core/paths.ts";
import type { ReachEntry } from "../../core/reach.ts";
import { gpuSplit, type RigBus } from "../machines/index.ts";
import { CLOSED_RANGES, reachEgress } from "./netcheck.ts";

/**
 * A rig on a Kubernetes cluster, as the objects control applies with `kubectl apply -f -`: the
 * same two parts as the compose rig (harness and supervisor, each its own pod, so network rules
 * can tell them apart), sharing one volume on one node for the inbox and outbox. Two placements:
 * a namespace control creates for the rig (with its own network rules), or a slot the cluster's
 * operators made in advance (their quotas, admission rules and network rules; control only
 * deploys into it). GPUs come through NVIDIA's device plugin or through DRA.
 */

export interface ClusterRigPlan {
  rig: string;
  /**
   * created: control makes the namespace and its network rules; slot: it exists already, with
   * the operators' rules; joined: it exists already, and the operator applies the rig's objects
   * with its network rules (join.ts).
   */
  placement: "created" | "slot" | "joined";
  namespace: string;
  controlUrl: string;
  images: { harness: string; supervisor: string };
  /** GPUs for the rig: 0 (CPU), 1 (shared by the judge and agents) or several (split). */
  gpus: number;
  /** With two or more GPUs, how many are the judge's (default: half, rounded up). */
  judgeGpus?: number | undefined;
  /** How GPUs are asked for. */
  gpuMode: "device-plugin" | "dra";
  /** The DRA device class, when gpuMode is dra. */
  deviceClass?: string | undefined;
  /** A node to keep the rig on, or any node with room. */
  node?: string | undefined;
  storageClass?: string | undefined;
  storageGi: number;
  /** The rig's CPUs and memory (a slot's quota, say); none: the namespace's defaults apply. */
  resources?: { cpus: number; memoryGi: number } | undefined;
  controlPublicKey: string;
  /**
   * The message bus for its supervisor; none: it keeps to HTTP. Control's authority goes in the
   * supervisor's environment, so that every apply of the deployments (an update, a resize) carries
   * the one control has now.
   */
  bus?: RigBus | undefined;
  /** The owner's list of addresses rigs may reach, which the harness's network rule opens. */
  reach?: ReachEntry[] | undefined;
}

type Resources = { requests: Record<string, string>; limits: Record<string, string> };
const amount = (cpus: number, mi: number): Resources => {
  const cpu = `${Math.round(cpus * 1000)}m`;
  const memory = `${Math.round(mi)}Mi`;
  return { requests: { cpu, memory }, limits: { cpu, memory } };
};
/** The supervisor's fixed share of a rig: it relays, fetches and exports, and computes little. */
export const SUPERVISOR_SHARE = { cpus: 0.5, memoryGi: 2 };

/**
 * A rig's CPUs and memory as its containers get them: the supervisor its small share, the
 * harness the rest, and each pod's preparing step a little (a quota counts it as well). Requests
 * equal limits, so the rig keeps what it was given.
 */
export function rigResources(r: { cpus: number; memoryGi: number }): {
  harness: Resources;
  supervisor: Resources;
  prepare: Resources;
} {
  if (!(r.cpus >= 1.5) || !(r.memoryGi >= 6))
    throw new Error("a rig needs at least 1.5 CPUs and 6 GiB of memory");
  return {
    harness: amount(
      r.cpus - SUPERVISOR_SHARE.cpus,
      (r.memoryGi - SUPERVISOR_SHARE.memoryGi) * 1024,
    ),
    supervisor: amount(SUPERVISOR_SHARE.cpus, SUPERVISOR_SHARE.memoryGi * 1024),
    prepare: amount(0.25, 256),
  };
}

export interface ClusterRigSecrets {
  controlToken: string;
  harnessSupervisorToken: string;
}

type Obj = Record<string, unknown>;

export const clusterNames = (rig: string) => ({
  secret: `thermite-${rig}`,
  volume: `thermite-${rig}-data`,
  harness: `thermite-${rig}-harness`,
  supervisor: `thermite-${rig}-supervisor`,
  gpus: `thermite-${rig}-gpus`,
});

const labels = (rig: string, component?: "harness" | "supervisor") => ({
  "app.kubernetes.io/name": "thermite",
  "app.kubernetes.io/instance": rig,
  "app.kubernetes.io/managed-by": "thermite-control",
  ...(component ? { "app.kubernetes.io/component": component } : {}),
});

/**
 * Prepares the shared volume's folders for both pods' users, as the compose images do. It changes
 * the owner of the folders it makes only, never their trees: everything below them is written by
 * their users, and root without DAC_OVERRIDE cannot read a folder a user made private (as the Codex
 * CLI makes its own), so a recursive chown would stop the rig at every start. The inbox is the
 * supervisor's, with the controller's group (setgid, so what the supervisor adds keeps it), and
 * closed to everyone else, as the outbox is the controller's with the supervisor's group.
 */
const prepare = (image: string, resources?: Resources): Obj => ({
  name: "prepare",
  image,
  ...(resources ? { resources } : {}),
  imagePullPolicy: "IfNotPresent",
  command: [
    "sh",
    "-c",
    "mkdir -p /data/state /data/scratch /data/inbox/repos /data/inbox/models /data/outbox /data/supervisor && chown 10001:10010 /data/inbox /data/inbox/repos /data/inbox/models && chmod 2750 /data/inbox /data/inbox/repos /data/inbox/models && chown 10001:10001 /data/supervisor && chown 10010:10001 /data/outbox && chmod 2750 /data/outbox",
  ],
  securityContext: {
    // Root, with the controller's group as its own. Without DAC_READ_SEARCH, root enters the
    // closed inbox only through that group: with root's group, it stopped at the inbox's folders
    // once it had closed the inbox, and no pod of the rig started. Both pods run it at every
    // start. FSETID keeps the setgid bit on the outbox, whose group (the supervisor's) is not
    // root's: without it, chmod takes the bit off.
    runAsUser: 0,
    runAsGroup: 10010,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER", "FSETID"] },
  },
  volumeMounts: [{ name: "data", mountPath: "/data" }],
});

/** The objects for one rig, in the order they are applied. */
export function clusterRigObjects(p: ClusterRigPlan, s: ClusterRigSecrets): Obj[] {
  const split = gpuSplit(p.gpus, p.judgeGpus);
  const res = p.resources ? rigResources(p.resources) : undefined;
  if (p.gpus > 0 && p.gpuMode === "dra" && !p.deviceClass)
    throw new Error("a DRA rig needs its device class");
  const n = clusterNames(p.rig);
  const ns = p.namespace;
  const meta = (name: string, component?: "harness" | "supervisor") => ({
    name,
    namespace: ns,
    labels: labels(p.rig, component),
  });
  const together = {
    // Both pods share one volume, so they run on one node.
    podAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: [
        {
          labelSelector: { matchLabels: { "app.kubernetes.io/instance": p.rig } },
          topologyKey: "kubernetes.io/hostname",
        },
      ],
    },
  };
  const placement = p.node ? { nodeSelector: { "kubernetes.io/hostname": p.node } } : {};
  const env = (pairs: Record<string, string>) =>
    Object.entries(pairs).map(([name, value]) => ({ name, value }));
  const gpu = p.gpus > 0;
  // Each part's health (goal 173): its route answers 503 while one of its loops is late. A part
  // may take minutes to start (the harness runs its isolation check before it listens), so the
  // startup probe allows 10; then kubelet looks every 30 s, and restarts a part that fails three
  // times running. The harness is asked over HTTP; the supervisor's route listens in its container
  // only, so a program asks it there.
  const probes = (how: Obj, startMinutes: number) => ({
    startupProbe: { ...how, periodSeconds: 10, failureThreshold: startMinutes * 6 },
    readinessProbe: { ...how, periodSeconds: 30, timeoutSeconds: 10, failureThreshold: 3 },
    livenessProbe: { ...how, periodSeconds: 30, timeoutSeconds: 10, failureThreshold: 3 },
  });
  // At a stop the harness ends its trials as interrupted and waits at most 5 s for the judge's
  // job, whose lease is taken back at its next start; the supervisor ends its calls. 30 s is room
  // for both, stated here rather than left to the default.
  const grace = { terminationGracePeriodSeconds: 30 };
  const deployment = (component: "harness" | "supervisor", pod: Obj): Obj => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: meta(component === "harness" ? n.harness : n.supervisor, component),
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: {
        matchLabels: {
          "app.kubernetes.io/instance": p.rig,
          "app.kubernetes.io/component": component,
        },
      },
      // Neither part calls the Kubernetes API (control drives the rig's lifecycle), so neither
      // pod gets the namespace's service-account token. Both run under the container runtime's
      // default seccomp profile, as compose and Quadlet run them, whatever the kubelet's default.
      template: {
        metadata: { labels: labels(p.rig, component) },
        spec: {
          automountServiceAccountToken: false,
          ...pod,
          securityContext: {
            ...((pod.securityContext as Obj | undefined) ?? {}),
            seccompProfile: { type: "RuntimeDefault" },
          },
        },
      },
    },
  });
  const objects: Obj[] = [];
  if (p.placement === "created")
    objects.push({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: ns, labels: labels(p.rig) },
    });
  objects.push(
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta(n.secret),
      type: "Opaque",
      stringData: {
        "control-rig-token": s.controlToken,
        "harness-supervisor-token": s.harnessSupervisorToken,
        "control-signing.pub": p.controlPublicKey,
      },
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: meta(n.volume),
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: `${p.storageGi}Gi` } },
        ...(p.storageClass ? { storageClassName: p.storageClass } : {}),
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(n.harness, "harness"),
      spec: {
        selector: { "app.kubernetes.io/instance": p.rig, "app.kubernetes.io/component": "harness" },
        ports: [{ name: "api", port: 8700, targetPort: 8700 }],
      },
    },
  );
  if (gpu && p.gpuMode === "dra")
    objects.push({
      apiVersion: "resource.k8s.io/v1",
      kind: "ResourceClaimTemplate",
      metadata: meta(n.gpus, "harness"),
      spec: {
        spec: {
          devices: {
            requests: [
              { name: "gpus", exactly: { deviceClassName: p.deviceClass, count: p.gpus } },
            ],
          },
        },
      },
    });
  const secretFile = (key: string, path: string) => ({
    name: "secrets",
    mountPath: path,
    subPath: key,
    readOnly: true,
  });
  objects.push(
    deployment("harness", {
      affinity: together,
      ...placement,
      ...grace,
      initContainers: [prepare(p.images.harness, res?.prepare)],
      containers: [
        {
          name: "harness",
          image: p.images.harness,
          imagePullPolicy: "IfNotPresent",
          env: env({
            THERMITE_RIG_ID: p.rig,
            THERMITE_TARGET: gpu ? "cuda-gpu" : "cpu",
            ...split,
            THERMITE_CONTROL_PUBKEY_FILE: "/keys/control-signing.pub",
            THERMITE_SUPERVISOR_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
          }),
          ports: [{ containerPort: 8700, name: "api" }],
          ...probes({ httpGet: { path: HEALTH.path, port: 8700 } }, 10),
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: {
              drop: ["ALL"],
              add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"],
            },
          },
          resources:
            gpu && p.gpuMode === "device-plugin"
              ? {
                  ...(res ? { requests: res.harness.requests } : {}),
                  limits: { ...(res?.harness.limits ?? {}), "nvidia.com/gpu": p.gpus },
                }
              : gpu
                ? { ...(res?.harness ?? {}), claims: [{ name: "gpus" }] }
                : (res?.harness ?? {}),
          volumeMounts: [
            { name: "data", mountPath: "/var/lib/thermite", subPath: "state" },
            { name: "data", mountPath: "/scratch", subPath: "scratch" },
            { name: "data", mountPath: HARNESS_INBOX_DIR, subPath: "inbox", readOnly: true },
            { name: "data", mountPath: "/outbox", subPath: "outbox" },
            secretFile("control-signing.pub", "/keys/control-signing.pub"),
            secretFile("harness-supervisor-token", "/run/secrets/harness-supervisor-token"),
          ],
        },
      ],
      ...(gpu && p.gpuMode === "dra"
        ? { resourceClaims: [{ name: "gpus", resourceClaimTemplateName: n.gpus }] }
        : {}),
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: n.volume } },
        { name: "secrets", secret: { secretName: n.secret, defaultMode: 0o444 } },
      ],
    }),
    deployment("supervisor", {
      affinity: together,
      ...placement,
      ...grace,
      initContainers: [prepare(p.images.harness, res?.prepare)],
      containers: [
        {
          name: "supervisor",
          image: p.images.supervisor,
          imagePullPolicy: "IfNotPresent",
          env: env({
            THERMITE_RIG_ID: p.rig,
            HARNESS_URL: `http://${n.harness}:8700`,
            CONTROL_URL: p.controlUrl.replace(/\/$/, ""),
            THERMITE_HARNESS_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
            THERMITE_CONTROL_TOKEN_FILE: "/run/secrets/control-rig-token",
            ...(p.bus ? { THERMITE_NATS_URL: p.bus.url, THERMITE_NATS_CA: p.bus.ca } : {}),
          }),
          // Its entry runs as root to close its folders to the advisor users and to start the
          // supervisor and each advisor's program as users of their own; the supervisor keeps
          // no capability.
          securityContext: {
            runAsUser: 0,
            runAsGroup: 0,
            allowPrivilegeEscalation: false,
            capabilities: {
              drop: ["ALL"],
              add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"],
            },
          },
          ...probes({ exec: { command: ["node", "-e", healthProbe(HEALTH_URLS.supervisor)] } }, 5),
          ...(res ? { resources: res.supervisor } : {}),
          volumeMounts: [
            { name: "data", mountPath: "/var/lib/thermite-supervisor", subPath: "supervisor" },
            { name: "data", mountPath: SUPERVISOR_INBOX_DIR, subPath: "inbox" },
            { name: "data", mountPath: "/outbox", subPath: "outbox", readOnly: true },
            secretFile("harness-supervisor-token", "/run/secrets/harness-supervisor-token"),
            secretFile("control-rig-token", "/run/secrets/control-rig-token"),
          ],
        },
      ],
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: n.volume } },
        { name: "secrets", secret: { secretName: n.secret, defaultMode: 0o444 } },
      ],
    }),
  );
  if (p.placement === "created" || p.placement === "joined") {
    objects.push(
      {
        // The harness reaches DNS and the internet, not the cluster, control or the closed
        // ranges; only its supervisor reaches it.
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: meta(`${n.harness}-net`, "harness"),
        spec: {
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/instance": p.rig,
              "app.kubernetes.io/component": "harness",
            },
          },
          policyTypes: ["Ingress", "Egress"],
          ingress: [
            {
              from: [
                {
                  podSelector: {
                    matchLabels: {
                      "app.kubernetes.io/instance": p.rig,
                      "app.kubernetes.io/component": "supervisor",
                    },
                  },
                },
              ],
              ports: [{ port: 8700, protocol: "TCP" }],
            },
          ],
          egress: [
            {
              ports: [
                { port: 53, protocol: "UDP" },
                { port: 53, protocol: "TCP" },
              ],
            },
            { to: [{ ipBlock: { cidr: "0.0.0.0/0", except: CLOSED_RANGES } }] },
            ...reachEgress(p.reach ?? []),
          ],
        },
      },
      {
        // The supervisor takes no connections.
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: meta(`${n.supervisor}-net`, "supervisor"),
        spec: {
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/instance": p.rig,
              "app.kubernetes.io/component": "supervisor",
            },
          },
          policyTypes: ["Ingress"],
          ingress: [],
        },
      },
    );
  }
  return objects;
}

/**
 * The rig's two deployments alone, as an image update applies them: its secret (so its tokens),
 * volume claim, service and network rules stay as they are. A stopped rig stays stopped.
 */
export function clusterRigDeployments(p: ClusterRigPlan, stopped = false): Obj[] {
  return clusterRigParts(p, ["Deployment"], stopped);
}

/**
 * The objects a change to a rig's GPUs, CPUs or memory applies: its two deployments and, for DRA,
 * its resource claim template, which holds the number of GPUs the harness pod asks for. Its secret
 * (so its tokens), volume claim, service and network rules stay. A stopped rig stays stopped.
 */
export function clusterRigResized(p: ClusterRigPlan, stopped = false): Obj[] {
  return clusterRigParts(p, ["ResourceClaimTemplate", "Deployment"], stopped);
}

/** The rig's network rules alone, as a change of the list of addresses rigs may reach applies them. */
export function clusterRigNetwork(p: ClusterRigPlan): Obj[] {
  return clusterRigParts(p, ["NetworkPolicy"], false);
}

function clusterRigParts(p: ClusterRigPlan, kinds: string[], stopped: boolean): Obj[] {
  // The secret is built with empty tokens and left out: nothing here reads or replaces it.
  return clusterRigObjects(p, { controlToken: "", harnessSupervisorToken: "" })
    .filter((o) => kinds.includes(String(o.kind)))
    .map((o) =>
      stopped && o.kind === "Deployment" ? { ...o, spec: { ...(o.spec as Obj), replicas: 0 } } : o,
    );
}

/** The objects as one document `kubectl apply -f -` reads (JSON is YAML). */
export const asList = (items: Obj[]) => JSON.stringify({ apiVersion: "v1", kind: "List", items });
