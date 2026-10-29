import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clusterLine,
  parseNodes,
  parseStorageClasses,
} from "../../../src/control/clusters/facts.ts";
import {
  asList,
  type ClusterRigPlan,
  clusterRigDeployments,
  clusterRigObjects,
} from "../../../src/control/clusters/manifests.ts";

const plan: ClusterRigPlan = {
  rig: "k8s-a-1",
  placement: "created",
  namespace: "thermite-k8s-a-1",
  controlUrl: "https://control.example.com/",
  images: {
    harness: "registry.example.com/harness-cuda:1",
    supervisor: "registry.example.com/supervisor:1",
  },
  gpus: 2,
  gpuMode: "device-plugin",
  storageGi: 100,
  storageClass: "local-path",
  controlPublicKey: "PUBLIC KEY",
};
const secrets = { controlToken: "rig-token", harnessSupervisorToken: "sup-token" };
type Obj = { kind: string; metadata: { name: string; namespace?: string }; [k: string]: unknown };
const kinds = (objs: Obj[]) => objs.map((o) => o.kind);
const find = (objs: Obj[], kind: string, name?: string) =>
  objs.find((o) => o.kind === kind && (!name || o.metadata.name === name)) as Obj;
const pod = (objs: Obj[], name: string) =>
  (
    find(objs, "Deployment", name) as unknown as {
      spec: { template: { spec: Record<string, unknown> } };
    }
  ).spec.template.spec;

describe("rigs on Kubernetes", () => {
  test("a created namespace: its namespace, secret, volume, service, both deployments and network rules", () => {
    const objs = clusterRigObjects(plan, secrets) as Obj[];
    assert.deepEqual(kinds(objs), [
      "Namespace",
      "Secret",
      "PersistentVolumeClaim",
      "Service",
      "Deployment",
      "Deployment",
      "NetworkPolicy",
      "NetworkPolicy",
    ]);
    assert.ok(objs.slice(1).every((o) => o.metadata.namespace === "thermite-k8s-a-1"));
    assert.deepEqual(
      (find(objs, "Secret") as unknown as { stringData: Record<string, string> }).stringData,
      {
        "control-rig-token": "rig-token",
        "harness-supervisor-token": "sup-token",
        "control-signing.pub": "PUBLIC KEY",
      },
    );
    const harness = pod(objs, "thermite-k8s-a-1-harness") as {
      containers: {
        env: { name: string; value: string }[];
        resources: unknown;
        securityContext: { capabilities: { add: string[] } };
      }[];
    };
    const env = Object.fromEntries(harness.containers[0]?.env.map((e) => [e.name, e.value]) ?? []);
    assert.equal(env.THERMITE_TARGET, "cuda-gpu");
    assert.equal(env.THERMITE_GPUS, "0,1");
    assert.equal(env.THERMITE_JUDGE_GPUS, "1");
    assert.deepEqual(harness.containers[0]?.resources, { limits: { "nvidia.com/gpu": 2 } });
    assert.deepEqual(harness.containers[0]?.securityContext.capabilities.add, [
      "CHOWN",
      "DAC_OVERRIDE",
      "FOWNER",
      "KILL",
      "SETGID",
      "SETUID",
    ]);
    // The harness never sees control's token; the supervisor reports to control.
    assert.ok(!JSON.stringify(harness).includes("control-rig-token"));
    const sup = pod(objs, "thermite-k8s-a-1-supervisor") as {
      containers: { env: { name: string; value: string }[] }[];
    };
    const senv = Object.fromEntries(sup.containers[0]?.env.map((e) => [e.name, e.value]) ?? []);
    assert.equal(senv.CONTROL_URL, "https://control.example.com");
    assert.equal(senv.HARNESS_URL, "http://thermite-k8s-a-1-harness:8700");
    // The two pods share one volume, so they stay on one node.
    assert.match(
      JSON.stringify(pod(objs, "thermite-k8s-a-1-supervisor")),
      /kubernetes\.io\/hostname/,
    );
    // Neither pod gets a service-account token: nothing in them calls the cluster's API. Both run
    // under the runtime's default seccomp profile; the supervisor keeps its own user.
    for (const name of ["thermite-k8s-a-1-harness", "thermite-k8s-a-1-supervisor"]) {
      const spec = pod(objs, name) as {
        automountServiceAccountToken?: boolean;
        securityContext?: { seccompProfile?: { type: string } };
      };
      assert.equal(spec.automountServiceAccountToken, false);
      assert.deepEqual(spec.securityContext?.seccompProfile, { type: "RuntimeDefault" });
    }
    assert.deepEqual(pod(objs, "thermite-k8s-a-1-supervisor").securityContext, {
      runAsUser: 10001,
      runAsGroup: 10001,
      seccompProfile: { type: "RuntimeDefault" },
    });
    assert.equal(JSON.parse(asList(objs)).kind, "List");
  });

  test("each part has startup, readiness and liveness probes on its health, and a grace period (goal 173)", () => {
    const objs = clusterRigObjects(plan, secrets) as Obj[];
    type Container = Record<string, { [k: string]: unknown } | undefined>;
    const part = (name: string) => {
      const spec = pod(objs, name);
      return { spec, c: (spec.containers as Container[])[0] as Container };
    };
    const h = part("thermite-k8s-a-1-harness");
    assert.equal(h.spec.terminationGracePeriodSeconds, 30);
    assert.deepEqual(h.c.livenessProbe, {
      httpGet: { path: "/v1/health", port: 8700 },
      periodSeconds: 30,
      timeoutSeconds: 10,
      failureThreshold: 3,
    });
    assert.deepEqual(h.c.readinessProbe?.httpGet, { path: "/v1/health", port: 8700 });
    assert.equal(h.c.startupProbe?.failureThreshold, 60);
    const s = part("thermite-k8s-a-1-supervisor");
    assert.equal(s.spec.terminationGracePeriodSeconds, 30);
    const command = (s.c.livenessProbe?.exec as { command: string[] } | undefined)?.command ?? [];
    assert.deepEqual(command.slice(0, 2), ["node", "-e"]);
    assert.match(command[2] ?? "", /fetch\('http:\/\/127\.0\.0\.1:8701\/v1\/health'/);
    assert.ok(s.c.readinessProbe && s.c.startupProbe);
  });

  test("a slot: no namespace and no network rules of control's; DRA asks for GPUs by claim", () => {
    const objs = clusterRigObjects(
      {
        ...plan,
        placement: "slot",
        namespace: "thermite-slot-1",
        gpuMode: "dra",
        deviceClass: "gpu.nvidia.com",
        gpus: 1,
      },
      secrets,
    ) as Obj[];
    assert.deepEqual(kinds(objs), [
      "Secret",
      "PersistentVolumeClaim",
      "Service",
      "ResourceClaimTemplate",
      "Deployment",
      "Deployment",
    ]);
    assert.match(
      JSON.stringify(find(objs, "ResourceClaimTemplate")),
      /"deviceClassName":"gpu.nvidia.com","count":1/,
    );
    const harness = pod(objs, "thermite-k8s-a-1-harness") as {
      resourceClaims: unknown;
      containers: { resources: unknown }[];
    };
    assert.deepEqual(harness.resourceClaims, [
      { name: "gpus", resourceClaimTemplateName: "thermite-k8s-a-1-gpus" },
    ]);
    assert.deepEqual(harness.containers[0]?.resources, { claims: [{ name: "gpus" }] });
    // A CPU rig asks for nothing; more GPUs are split, half for the judge by default.
    const cpu = clusterRigObjects({ ...plan, gpus: 0 }, secrets) as Obj[];
    assert.ok(
      !JSON.stringify(cpu).includes("nvidia.com/gpu") && !JSON.stringify(cpu).includes("GPU_INDEX"),
    );
    const envOf = (objs: Obj[]) =>
      Object.fromEntries(
        (
          pod(objs, "thermite-k8s-a-1-harness") as {
            containers: { env: { name: string; value: string }[] }[];
          }
        ).containers[0]?.env.map((e) => [e.name, e.value]) ?? [],
      );
    const four = envOf(clusterRigObjects({ ...plan, gpus: 4 }, secrets) as Obj[]);
    assert.equal(four.THERMITE_GPUS, "0,1,2,3");
    assert.equal(four.THERMITE_JUDGE_GPUS, "2");
    const three = envOf(clusterRigObjects({ ...plan, gpus: 3, judgeGpus: 1 }, secrets) as Obj[]);
    assert.equal(three.THERMITE_GPUS, "0,1,2");
    assert.equal(three.THERMITE_JUDGE_GPUS, "1");
    assert.throws(
      () => clusterRigObjects({ ...plan, gpus: 3, judgeGpus: 3 }, secrets),
      /judge takes 1 to 2/,
    );
    assert.throws(() => clusterRigObjects({ ...plan, gpus: 17 }, secrets), /at most 16 GPUs/);
    assert.throws(
      () => clusterRigObjects({ ...plan, gpuMode: "dra", gpus: 1 }, secrets),
      /device class/,
    );
  });

  test("with the message bus, the supervisor's environment carries its address and control's authority", () => {
    const bus = { url: "nats://control.example.com:4222", ca: "-----BEGIN CERTIFICATE-----\nca\n" };
    const env = (objs: Obj[], name: string) =>
      Object.fromEntries(
        (
          (pod(objs, name).containers as { env: { name: string; value: string }[] }[])[0]?.env ?? []
        ).map((e) => [e.name, e.value]),
      );
    const objs = clusterRigObjects({ ...plan, bus }, secrets) as Obj[];
    const sup = env(objs, "thermite-k8s-a-1-supervisor");
    assert.equal(sup.THERMITE_NATS_URL, bus.url);
    assert.equal(sup.THERMITE_NATS_CA, bus.ca);
    assert.equal(sup.THERMITE_NATS_CA_FILE, undefined);
    assert.ok(!Object.keys(env(objs, "thermite-k8s-a-1-harness")).some((k) => k.includes("NATS")));
    // The secret is the same: the authority is no secret, and an update applies the deployments
    // alone, which carry it.
    assert.deepEqual(
      find(objs, "Secret"),
      find(clusterRigObjects(plan, secrets) as Obj[], "Secret"),
    );
    const updated = clusterRigDeployments({ ...plan, bus }) as Obj[];
    assert.equal(env(updated, "thermite-k8s-a-1-supervisor").THERMITE_NATS_CA, bus.ca);
    assert.ok(
      !Object.keys(
        env(clusterRigObjects(plan, secrets) as Obj[], "thermite-k8s-a-1-supervisor"),
      ).some((k) => k.includes("NATS")),
    );
  });

  test("prepare changes the owner of the folders it makes, never their trees", () => {
    // A folder a user made private below them (the Codex CLI's own) stopped a rig at every start.
    const objs = clusterRigObjects(plan, secrets) as Obj[];
    const inits = JSON.stringify(objs).match(/"name":"prepare"[^}]*"command":\[[^\]]*\]/g) ?? [];
    assert.ok(inits.length > 0);
    for (const i of inits) {
      assert.doesNotMatch(i, /chown -R/);
      assert.match(i, /chown 10001:10001 \/data\/supervisor/);
    }
  });

  test("the inbox is the supervisor's with the controller's group, and the harness reads it in a closed folder", () => {
    const objs = clusterRigObjects(plan, secrets) as Obj[];
    const inits = JSON.stringify(objs).match(/"name":"prepare"[^}]*"command":\[[^\]]*\]/g) ?? [];
    assert.ok(inits.length > 0);
    const inbox = "\\/data\\/inbox \\/data\\/inbox\\/repos \\/data\\/inbox\\/models";
    for (const i of inits) {
      assert.match(i, new RegExp(`chown 10001:10010 ${inbox}`));
      assert.match(i, new RegExp(`chmod 2750 ${inbox}`));
    }
    const mounts = JSON.stringify(objs).match(/\{[^{}]*"subPath":"inbox"[^{}]*\}/g) ?? [];
    assert.deepEqual(
      mounts.map((m) => JSON.parse(m)),
      [
        { name: "data", mountPath: "/controller/inbox", subPath: "inbox", readOnly: true },
        { name: "data", mountPath: "/inbox", subPath: "inbox" },
      ],
    );
  });

  test("prepare runs as root with the controller's group, and enters the closed inbox at every start", () => {
    // Root without DAC_READ_SEARCH enters the inbox (10001:10010, 2750) only through its group.
    // With root's own group, prepare stopped at the inbox's folders, and no pod of the rig started.
    // Without FSETID, root keeps the setgid bit only on a folder of its own group.
    const objs = clusterRigObjects(plan, secrets) as Obj[];
    for (const name of ["thermite-k8s-a-1-harness", "thermite-k8s-a-1-supervisor"]) {
      const inits = pod(objs, name).initContainers as { name: string; securityContext: unknown }[];
      assert.deepEqual(
        inits.map((i) => [i.name, i.securityContext]),
        [
          [
            "prepare",
            {
              runAsUser: 0,
              runAsGroup: 10010,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER"] },
            },
          ],
        ],
      );
    }
  });

  test("the check reads nodes with their GPUs and the default storage class", () => {
    const nodes = parseNodes(
      JSON.stringify({
        items: [
          {
            metadata: {
              name: "gpu-node-1",
              labels: { "nvidia.com/gpu.product": "NVIDIA-A100-SXM4-80GB" },
            },
            status: {
              allocatable: { cpu: "64", memory: "512Gi", "nvidia.com/gpu": "4" },
              conditions: [{ type: "Ready", status: "True" }],
            },
          },
          {
            metadata: { name: "cpu-node" },
            status: {
              allocatable: { cpu: "8", memory: "32Gi" },
              conditions: [{ type: "Ready", status: "False" }],
            },
          },
        ],
      }),
    );
    assert.deepEqual(nodes[0], {
      name: "gpu-node-1",
      ready: true,
      gpus: 4,
      gpu_product: "NVIDIA-A100-SXM4-80GB",
      cpu: "64",
      memory: "512Gi",
    });
    assert.equal(nodes[1]?.ready, false);
    const storage = parseStorageClasses(
      JSON.stringify({
        items: [
          {
            metadata: {
              name: "local-path",
              annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
            },
          },
          { metadata: { name: "fast" } },
        ],
      }),
    );
    assert.deepEqual(storage, [
      { name: "local-path", default: true },
      { name: "fast", default: false },
    ]);
    assert.equal(
      clusterLine({
        version: "v1.35.2",
        nodes,
        device_classes: ["gpu.nvidia.com"],
        storage_classes: storage,
        can_create_namespaces: true,
        slots: [],
      }),
      "Kubernetes v1.35.2 · 2 nodes, 1 with 4 GPUs · DRA: gpu.nvidia.com · storage local-path",
    );
  });
});
