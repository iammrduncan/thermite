import { HEALTH } from "../../core/api/harness/supervisor.ts";
import { followerGpuEnv } from "../../core/followers.ts";
import { HEALTH_URLS, healthProbe } from "../../core/health.ts";
import { HARNESS_INBOX_DIR, SUPERVISOR_INBOX_DIR } from "../../core/paths.ts";
import {
  envOf,
  grace,
  harnessPolicy,
  labels,
  MACHINE_LABEL,
  type Obj,
  partDeployment,
  prepare,
  probes,
  type Resources,
  secretFile,
  supervisorPolicy,
} from "./manifest-parts.ts";
import type { ClusterRigPlan } from "./manifests.ts";

/**
 * A follower of a rig over several machines, on a cluster (goal 205): a node of its own, with its
 * judge's and workers' GPUs, its own volume and its two parts, the harness started as a follower and its
 * supervisor, which take the leader's asks on the bus. They share the rig's namespace and secret;
 * their objects carry the rig's instance, so the rig's stop, start and removal take them too, and
 * the machine's label, with components of their own, so no selector of the rig's own parts takes
 * their pods.
 */

export interface Follower {
  /** The follower's name in the rig: a rig's name's form. */
  machine: string;
  /** The node it runs on. */
  node: string;
  /** Its judge's GPUs. */
  gpus: number;
  /** Its workers' GPUs (step 2), after the judge's in its container's numbering. */
  workers?: number | undefined;
  /** With no GPU: whose its CPUs are. */
  cpu?: "judge" | "workers" | undefined;
  /** Its DRA device class, when it is not the rig's. */
  deviceClass?: string | undefined;
  storageGi: number;
  /** Its CPUs and memory; none: the namespace's defaults. */
  resources?: { harness: Resources; supervisor: Resources; prepare: Resources } | undefined;
}

/** A follower's objects' names, each with the machine's. */
const followerNames = (rig: string, machine: string) => ({
  volume: `thermite-${rig}-${machine}-data`,
  harness: `thermite-${rig}-${machine}-harness`,
  supervisor: `thermite-${rig}-${machine}-supervisor`,
  gpus: `thermite-${rig}-${machine}-gpus`,
});

const HARNESS = "follower-harness";
const SUPERVISOR = "follower-supervisor";

/** One follower's objects, in the order they are applied. */
export function followerObjects(p: ClusterRigPlan, f: Follower): Obj[] {
  const n = followerNames(p.rig, f.machine);
  const secret = `thermite-${p.rig}`;
  const deviceClass = f.deviceClass ?? p.deviceClass;
  // The judge's GPUs and the workers', in one claim: the container numbers the judge's first.
  const count = f.gpus + (f.workers ?? 0);
  const gpu = count > 0;
  if (gpu && p.gpuMode === "dra" && !deviceClass)
    throw new Error(`follower ${f.machine} needs its DRA device class`);
  const meta = (name: string, component?: string) => ({
    name,
    namespace: p.namespace,
    labels: labels(p.rig, component, f.machine),
  });
  const part = (component: string) => ({
    "app.kubernetes.io/instance": p.rig,
    "app.kubernetes.io/component": component,
    [MACHINE_LABEL]: f.machine,
  });
  const pod = (component: string, spec: Obj): Obj =>
    partDeployment({
      metadata: meta(component === HARNESS ? n.harness : n.supervisor, component),
      selector: part(component),
      podLabels: labels(p.rig, component, f.machine),
      pod: {
        nodeSelector: { "kubernetes.io/hostname": f.node },
        ...grace,
        initContainers: [prepare(p.images.harness, f.resources?.prepare)],
        ...spec,
        volumes: [
          { name: "data", persistentVolumeClaim: { claimName: n.volume } },
          { name: "secrets", secret: { secretName: secret, defaultMode: 0o444 } },
        ],
      },
    });
  // The same capabilities as the rig's own parts: the broker's roles, and the supervisor's entry.
  const capabilities = {
    drop: ["ALL"],
    add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"],
  };
  const objects: Obj[] = [
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: meta(n.volume),
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: `${f.storageGi}Gi` } },
        ...(p.storageClass ? { storageClassName: p.storageClass } : {}),
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(n.harness, HARNESS),
      spec: { selector: part(HARNESS), ports: [{ name: "api", port: 8700, targetPort: 8700 }] },
    },
  ];
  if (gpu && p.gpuMode === "dra")
    objects.push({
      apiVersion: "resource.k8s.io/v1",
      kind: "ResourceClaimTemplate",
      metadata: meta(n.gpus, HARNESS),
      spec: {
        spec: {
          devices: {
            requests: [{ name: "gpus", exactly: { deviceClassName: deviceClass, count } }],
          },
        },
      },
    });
  const harnessResources =
    gpu && p.gpuMode === "device-plugin"
      ? {
          ...(f.resources ? { requests: f.resources.harness.requests } : {}),
          limits: { ...(f.resources?.harness.limits ?? {}), "nvidia.com/gpu": count },
        }
      : gpu
        ? { ...(f.resources?.harness ?? {}), claims: [{ name: "gpus" }] }
        : (f.resources?.harness ?? {});
  objects.push(
    pod(HARNESS, {
      containers: [
        {
          name: "harness",
          image: p.images.harness,
          imagePullPolicy: "IfNotPresent",
          env: envOf({
            THERMITE_RIG_ID: p.rig,
            THERMITE_ROLE: "follower",
            THERMITE_TARGET: gpu ? "cuda-gpu" : "cpu",
            // Its GPUs by pool (core/followers.ts).
            ...followerGpuEnv({ judge: f.gpus, workers: f.workers ?? 0 }),
            THERMITE_CONTROL_PUBKEY_FILE: "/keys/control-signing.pub",
            THERMITE_SUPERVISOR_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
          }),
          ports: [{ containerPort: 8700, name: "api" }],
          ...probes({ httpGet: { path: HEALTH.path, port: 8700 } }, 10),
          securityContext: { allowPrivilegeEscalation: false, capabilities },
          resources: harnessResources,
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
    }),
    pod(SUPERVISOR, {
      containers: [
        {
          name: "supervisor",
          image: p.images.supervisor,
          imagePullPolicy: "IfNotPresent",
          env: envOf({
            THERMITE_RIG_ID: p.rig,
            THERMITE_ROLE: "follower",
            THERMITE_MACHINE: f.machine,
            HARNESS_URL: `http://${n.harness}:8700`,
            CONTROL_URL: p.controlUrl.replace(/\/$/, ""),
            THERMITE_HARNESS_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
            THERMITE_CONTROL_TOKEN_FILE: "/run/secrets/control-rig-token",
            THERMITE_NATS_URL: p.bus.url,
            THERMITE_NATS_CA: p.bus.ca,
          }),
          securityContext: {
            runAsUser: 0,
            runAsGroup: 0,
            allowPrivilegeEscalation: false,
            capabilities,
          },
          ...probes({ exec: { command: ["node", "-e", healthProbe(HEALTH_URLS.supervisor)] } }, 5),
          ...(f.resources ? { resources: f.resources.supervisor } : {}),
          volumeMounts: [
            { name: "data", mountPath: "/var/lib/thermite-supervisor", subPath: "supervisor" },
            { name: "data", mountPath: SUPERVISOR_INBOX_DIR, subPath: "inbox" },
            { name: "data", mountPath: "/outbox", subPath: "outbox", readOnly: true },
            secretFile("harness-supervisor-token", "/run/secrets/harness-supervisor-token"),
            secretFile("control-rig-token", "/run/secrets/control-rig-token"),
          ],
        },
      ],
    }),
  );
  if (p.placement === "created" || p.placement === "joined")
    objects.push(
      harnessPolicy({
        metadata: meta(`${n.harness}-net`, HARNESS),
        harness: part(HARNESS),
        supervisor: part(SUPERVISOR),
        reach: p.reach ?? [],
      }),
      supervisorPolicy({
        metadata: meta(`${n.supervisor}-net`, SUPERVISOR),
        supervisor: part(SUPERVISOR),
      }),
    );
  return objects;
}
