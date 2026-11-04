import { HEALTH } from "../../core/api/harness/supervisor.ts";
import { HEALTH_URLS, healthProbe } from "../../core/health.ts";
import { HARNESS_INBOX_DIR, SUPERVISOR_INBOX_DIR } from "../../core/paths.ts";
import type { ReachEntry } from "../../core/reach.ts";
import type { ProgramMode } from "../../core/rig-settings.ts";
import { gpuSplit, type RigBus } from "../machines/index.ts";
import { followerObjects } from "./followers.ts";
import {
  amount,
  envOf,
  grace,
  harnessPolicy,
  labels,
  type Obj,
  partDeployment,
  prepare,
  probes,
  type Resources,
  secretFile,
  supervisorPolicy,
} from "./manifest-parts.ts";

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
  /** How the rig's agent programs run, which sets the supervisor's share of its resources. */
  programMode: ProgramMode;
  controlPublicKey: string;
  /**
   * The message bus for its supervisor: the one way it reaches control but its registration.
   * Control's authority goes in the supervisor's environment, so that every apply of the
   * deployments (an update, a resize) carries the one control has now.
   */
  bus: RigBus;
  /** The owner's list of addresses rigs may reach, which the harness's network rule opens. */
  reach?: ReachEntry[] | undefined;
  /**
   * A rig over several machines (goal 205): its followers, each on a node of its own with its
   * judge GPUs. The rig's own node is then its leader's, which `node` must name.
   */
  followers?: FollowerPlan[] | undefined;
  /** False: the leader's own GPUs are all the workers', and it judges only on its followers'. */
  judgeHere?: boolean | undefined;
}

/** A follower as control plans it: its node, GPUs, volume, and CPUs and memory. */
interface FollowerPlan {
  machine: string;
  node: string;
  gpus: number;
  deviceClass?: string | undefined;
  storageGi: number;
  resources?: { cpus: number; memoryGi: number } | undefined;
}

/**
 * The supervisor's share of a rig, by how the rig's agent programs run. It relays, fetches and
 * exports, and computes little; but its advisors in their programs' own terminals take about
 * 550 MiB each in Claude Code's, and two teachers and three reviewers can run at once, so there it
 * has 4 GiB (the owner's choice, 2026-10-31).
 */
export const SUPERVISOR_SHARE: Record<ProgramMode, { cpus: number; memoryGi: number }> = {
  terminal: { cpus: 0.5, memoryGi: 4 },
  headless: { cpus: 0.5, memoryGi: 2 },
};
/** The least the harness keeps beside the supervisor's share: it takes the rest of the rig. */
export const HARNESS_LEAST = { cpus: 1, memoryGi: 4 };

/** The least CPUs and memory of a rig whose agent programs run so. */
export const leastRigSize = (mode: ProgramMode) => ({
  cpus: SUPERVISOR_SHARE[mode].cpus + HARNESS_LEAST.cpus,
  memoryGi: SUPERVISOR_SHARE[mode].memoryGi + HARNESS_LEAST.memoryGi,
});

/**
 * A rig's CPUs and memory as its containers get them: the supervisor its share for how the rig's
 * agent programs run, the harness the rest, and each pod's preparing step a little (a quota counts
 * it as well). Requests equal limits, so the rig keeps what it was given. Too little for the
 * supervisor's share and the harness's least is refused in words.
 */
export function rigResources(
  r: { cpus: number; memoryGi: number },
  mode: ProgramMode,
): {
  harness: Resources;
  supervisor: Resources;
  prepare: Resources;
} {
  const share = SUPERVISOR_SHARE[mode];
  const least = leastRigSize(mode);
  if (!(r.cpus >= least.cpus) || !(r.memoryGi >= least.memoryGi))
    throw new Error(
      mode === "terminal"
        ? `a rig needs at least ${least.cpus} CPUs and ${least.memoryGi} GiB of memory while its agent programs run in their own terminals: its supervisor takes ${share.memoryGi} GiB for the advisors' terminals, and its harness at least ${HARNESS_LEAST.memoryGi} GiB`
        : `a rig needs at least ${least.cpus} CPUs and ${least.memoryGi} GiB of memory`,
    );
  return {
    harness: amount(r.cpus - share.cpus, (r.memoryGi - share.memoryGi) * 1024),
    supervisor: amount(share.cpus, share.memoryGi * 1024),
    prepare: amount(0.25, 256),
  };
}

export interface ClusterRigSecrets {
  controlToken: string;
  harnessSupervisorToken: string;
}

export const clusterNames = (rig: string) => ({
  secret: `thermite-${rig}`,
  volume: `thermite-${rig}-data`,
  harness: `thermite-${rig}-harness`,
  supervisor: `thermite-${rig}-supervisor`,
  gpus: `thermite-${rig}-gpus`,
});

/** The objects for one rig, in the order they are applied. */
export function clusterRigObjects(p: ClusterRigPlan, s: ClusterRigSecrets): Obj[] {
  const split = gpuSplit(p.gpus, p.judgeGpus);
  const res = p.resources ? rigResources(p.resources, p.programMode) : undefined;
  if (p.gpus > 0 && p.gpuMode === "dra" && !p.deviceClass)
    throw new Error("a DRA rig needs its device class");
  const n = clusterNames(p.rig);
  const ns = p.namespace;
  const followers = p.followers ?? [];
  if (followers.length && !p.node) throw new Error("a rig with followers needs its leader's node");
  // The leader judges on its followers' GPUs (goal 205), and on its own unless they are all the
  // workers'.
  const leading: Record<string, string> = followers.length
    ? {
        // A follower with no GPU judges on its CPU: one device all the same.
        THERMITE_FOLLOWERS: followers.map((f) => `${f.machine}=${Math.max(1, f.gpus)}`).join(","),
        ...(p.judgeHere === false ? { THERMITE_LOCAL_JUDGE: "0" } : {}),
      }
    : {};
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
  const gpu = p.gpus > 0;
  const deployment = (component: "harness" | "supervisor", pod: Obj): Obj =>
    partDeployment({
      metadata: meta(component === "harness" ? n.harness : n.supervisor, component),
      selector: { "app.kubernetes.io/instance": p.rig, "app.kubernetes.io/component": component },
      podLabels: labels(p.rig, component),
      pod,
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
          env: envOf({
            THERMITE_RIG_ID: p.rig,
            THERMITE_TARGET: gpu ? "cuda-gpu" : "cpu",
            ...split,
            ...leading,
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
          env: envOf({
            THERMITE_RIG_ID: p.rig,
            HARNESS_URL: `http://${n.harness}:8700`,
            CONTROL_URL: p.controlUrl.replace(/\/$/, ""),
            THERMITE_HARNESS_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
            THERMITE_CONTROL_TOKEN_FILE: "/run/secrets/control-rig-token",
            THERMITE_NATS_URL: p.bus.url,
            THERMITE_NATS_CA: p.bus.ca,
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
    const part = (component: "harness" | "supervisor") => ({
      "app.kubernetes.io/instance": p.rig,
      "app.kubernetes.io/component": component,
    });
    objects.push(
      harnessPolicy({
        metadata: meta(`${n.harness}-net`, "harness"),
        harness: part("harness"),
        supervisor: part("supervisor"),
        reach: p.reach ?? [],
      }),
      supervisorPolicy({
        metadata: meta(`${n.supervisor}-net`, "supervisor"),
        supervisor: part("supervisor"),
      }),
    );
  }
  // A rig over several machines (goal 205): each follower's parts, on its own node.
  // A follower's supervisor runs no advisor: it takes the headless share.
  for (const f of followers)
    objects.push(
      ...followerObjects(p, {
        ...f,
        resources: f.resources ? rigResources(f.resources, "headless") : undefined,
      }),
    );
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

/**
 * The rig's network rules alone, as a change of the list of addresses rigs may reach applies them.
 * They don't depend on its CPUs and memory, which are left out so that no size check stops them.
 */
export function clusterRigNetwork(p: ClusterRigPlan): Obj[] {
  return clusterRigParts({ ...p, resources: undefined }, ["NetworkPolicy"], false);
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
