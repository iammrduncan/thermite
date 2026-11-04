import type { ReachEntry } from "../../core/reach.ts";
import { CLOSED_RANGES, reachEgress } from "./netcheck.ts";

/**
 * The pieces a rig's objects on a cluster are made of (manifests.ts): the labels, a pod's preparing
 * step, its probes, a part's deployment and the network rules. The rig's own two parts and each
 * follower's two (goal 205, followers.ts) are made of the same pieces.
 */

export type Obj = Record<string, unknown>;
export type Resources = { requests: Record<string, string>; limits: Record<string, string> };

/** A container's CPUs and memory, requests equal to limits so it keeps what it was given. */
export const amount = (cpus: number, mi: number): Resources => {
  const cpu = `${Math.round(cpus * 1000)}m`;
  const memory = `${Math.round(mi)}Mi`;
  return { requests: { cpu, memory }, limits: { cpu, memory } };
};

/** The label a follower's objects carry beside the rig's (goal 205): which machine they are. */
export const MACHINE_LABEL = "thermite.dev/machine";

/**
 * A rig's labels: every object of the rig has its instance, which stop, start and remove select
 * by; a part's objects its component; a follower's its machine too.
 */
export const labels = (rig: string, component?: string, machine?: string) => ({
  "app.kubernetes.io/name": "thermite",
  "app.kubernetes.io/instance": rig,
  "app.kubernetes.io/managed-by": "thermite-control",
  ...(component ? { "app.kubernetes.io/component": component } : {}),
  ...(machine ? { [MACHINE_LABEL]: machine } : {}),
});

/**
 * Prepares the shared volume's folders for both pods' users, as the compose images do. It changes
 * the owner of the folders it makes only, never their trees: everything below them is written by
 * their users, and root without DAC_OVERRIDE cannot read a folder a user made private (as the Codex
 * CLI makes its own), so a recursive chown would stop the rig at every start. The inbox is the
 * supervisor's, with the controller's group (setgid, so what the supervisor adds keeps it), and
 * closed to everyone else, as the outbox is the controller's with the supervisor's group.
 */
export const prepare = (image: string, resources?: Resources): Obj => ({
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

// Each part's health (goal 173): its route answers 503 while one of its loops is late. A part
// may take minutes to start (the harness runs its isolation check before it listens), so the
// startup probe allows 10; then kubelet looks every 30 s, and restarts a part that fails three
// times running. The harness is asked over HTTP; the supervisor's route listens in its container
// only, so a program asks it there.
export const probes = (how: Obj, startMinutes: number) => ({
  startupProbe: { ...how, periodSeconds: 10, failureThreshold: startMinutes * 6 },
  readinessProbe: { ...how, periodSeconds: 30, timeoutSeconds: 10, failureThreshold: 3 },
  livenessProbe: { ...how, periodSeconds: 30, timeoutSeconds: 10, failureThreshold: 3 },
});

// At a stop the harness ends its trials as interrupted and waits at most 5 s for the judge's
// job, whose lease is taken back at its next start; the supervisor ends its calls. 30 s is room
// for both, stated here rather than left to the default.
export const grace = { terminationGracePeriodSeconds: 30 };

/** A container's environment from name-value pairs. */
export const envOf = (pairs: Record<string, string>) =>
  Object.entries(pairs).map(([name, value]) => ({ name, value }));

/** One file of the rig's secret, mounted read-only. */
export const secretFile = (key: string, path: string) => ({
  name: "secrets",
  mountPath: path,
  subPath: key,
  readOnly: true,
});

/** One part's deployment: one pod, made anew (never two at once) on a change. */
export const partDeployment = (o: {
  metadata: Obj;
  selector: Record<string, string>;
  podLabels: Record<string, string>;
  pod: Obj;
}): Obj => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: o.metadata,
  spec: {
    replicas: 1,
    strategy: { type: "Recreate" },
    selector: { matchLabels: o.selector },
    // Neither part calls the Kubernetes API (control drives the rig's lifecycle), so neither
    // pod gets the namespace's service-account token, nor the namespace's services as
    // variables (KUBERNETES_SERVICE_HOST stays: the isolation selftest probes it). Both run
    // under the container runtime's default seccomp profile, as compose and Quadlet run them,
    // whatever the kubelet's default.
    template: {
      metadata: { labels: o.podLabels },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        ...o.pod,
        securityContext: {
          ...((o.pod.securityContext as Obj | undefined) ?? {}),
          seccompProfile: { type: "RuntimeDefault" },
        },
      },
    },
  },
});

/**
 * A harness's network rules: it reaches DNS and the internet, not the cluster, control or the
 * closed ranges; only its own supervisor reaches it.
 */
export const harnessPolicy = (o: {
  metadata: Obj;
  harness: Record<string, string>;
  supervisor: Record<string, string>;
  reach: ReachEntry[];
}): Obj => ({
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  metadata: o.metadata,
  spec: {
    podSelector: { matchLabels: o.harness },
    policyTypes: ["Ingress", "Egress"],
    ingress: [
      {
        from: [{ podSelector: { matchLabels: o.supervisor } }],
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
      ...reachEgress(o.reach),
    ],
  },
});

/** A supervisor's network rules: it takes no connections. */
export const supervisorPolicy = (o: {
  metadata: Obj;
  supervisor: Record<string, string>;
}): Obj => ({
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  metadata: o.metadata,
  spec: {
    podSelector: { matchLabels: o.supervisor },
    policyTypes: ["Ingress"],
    ingress: [],
  },
});
