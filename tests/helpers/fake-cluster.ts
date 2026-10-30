import type { ClusterKubectl } from "../../src/control/clusters/kubectl.ts";
import { CLOSED_RANGES } from "../../src/control/clusters/netcheck.ts";
import { SecretBox } from "../../src/control/secrets.ts";
import type { ControlStore } from "../../src/control/store/index.ts";
import { ADMIN, controlOnly, mcpClient, type Requester, signIn } from "./control-stack.ts";

/**
 * Control over a fake Kubernetes cluster, for the tests of clusters in Providers, Add a rig and
 * a cluster rig's page. Moved out of the clusters page's test (tests/control/dashboard/clusters.test.ts).
 */

export { ADMIN };
export const OPERATOR = "operator-token-abcdef";
export const KUBECONFIG =
  "apiVersion: v1\nkind: Config\nusers: [{ name: u, user: { token: secret-kube-token-789 } }]\n";

/** A cluster behind a fake kubectl: what it answers, and every call it got. */
export function fakeCluster(
  o: {
    canCreateNamespaces?: boolean;
    slots?: Record<string, boolean>;
    /** Slots whose operators wrote the network rule (default: thermite-slot-1). */
    ruled?: string[];
    quota?: Record<string, Record<string, string>>;
    /** The node's GPUs through the device plugin (default 2). */
    nodeGpus?: number;
    /** DRA device classes (default: the cluster has no DRA). */
    deviceClasses?: string[];
    /** What kubectl prints for one deployment by name; default: the supervisor's, in JSON. */
    deploymentStdout?: string;
  } = {},
) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const k: ClusterKubectl = {
    contextsOf: async (config) => {
      if (!config.includes("kind: Config"))
        throw new Error("that is not a kubeconfig kubectl can read");
      return { contexts: ["kind-thermite", "other"], current: "kind-thermite" };
    },
    kubectl: async (_t, args, stdin) => {
      calls.push({ args, stdin });
      const a = args.join(" ");
      if (a === "config view --raw -o json")
        return ok(
          JSON.stringify(
            _t.kubeconfig.includes("exec:")
              ? {
                  clusters: [{ name: "c", cluster: { "certificate-authority": "/etc/ca.crt" } }],
                  users: [{ name: "u", user: { exec: { command: "sh" } } }],
                }
              : {
                  clusters: [{ name: "c", cluster: { server: "https://k.example.com" } }],
                  users: [{ name: "u", user: { token: "x" } }],
                },
          ),
        );
      if (a === "version -o json")
        return ok(JSON.stringify({ serverVersion: { gitVersion: "v1.35.2" } }));
      if (a === "get nodes -o json")
        return ok(
          JSON.stringify({
            items: [
              {
                metadata: { name: "gpu-node-1" },
                status: {
                  allocatable: {
                    cpu: "16",
                    memory: "64Gi",
                    "nvidia.com/gpu": String(o.nodeGpus ?? 2),
                  },
                  conditions: [{ type: "Ready", status: "True" }],
                },
              },
            ],
          }),
        );
      if (a === "get deviceclasses -o json")
        return o.deviceClasses
          ? ok(JSON.stringify({ items: o.deviceClasses.map((name) => ({ metadata: { name } })) }))
          : {
              code: 1,
              stdout: "",
              stderr: 'error: the server doesn\'t have a resource type "deviceclasses"',
            };
      if (a === "get storageclass -o json")
        return ok(
          JSON.stringify({
            items: [
              {
                metadata: {
                  name: "standard",
                  annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
                },
              },
            ],
          }),
        );
      if (a === "auth can-i create namespaces")
        return ok(o.canCreateNamespaces === false ? "no\n" : "yes\n");
      const slot = /^auth can-i create deployments -n (\S+)$/.exec(a);
      if (slot) return ok(o.slots?.[slot[1] as string] ? "yes\n" : "no\n");
      if (args[0] === "get" && args[1] === "deployments") return ok("");
      // One deployment by name: the supervisor, with the control address it was deployed with.
      if (args[0] === "get" && args[1] === "deployment" && args[3] === "-n" && o.deploymentStdout)
        return ok(o.deploymentStdout);
      if (args[0] === "get" && args[1] === "deployment" && args[3] === "-n")
        return ok(
          JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [
                    { env: [{ name: "CONTROL_URL", value: "https://control.example.com" }] },
                  ],
                },
              },
            },
          }),
        );
      // A rig's two deployments, each running its newest pod.
      if (args[0] === "get" && args[1] === "deployment")
        return ok(
          JSON.stringify({
            items: args.slice(2, 4).map(() => ({
              metadata: { generation: 2 },
              spec: { replicas: 1 },
              status: {
                observedGeneration: 2,
                replicas: 1,
                updatedReplicas: 1,
                availableReplicas: 1,
              },
            })),
          }),
        );
      const rq = /^get resourcequota -n (\S+) -o json$/.exec(a);
      if (rq) {
        const hard = o.quota?.[rq[1] as string];
        return ok(JSON.stringify({ items: hard ? [{ status: { hard } }] : [] }));
      }
      // The operators' network rule in slot 1: DNS and the internet without the closed ranges.
      const np = /^get networkpolicy -n (\S+) -o json$/.exec(a);
      if (np)
        return ok(
          JSON.stringify({
            items: (o.ruled ?? ["thermite-slot-1"]).includes(np[1] as string)
              ? [
                  {
                    metadata: { name: "thermite-harness" },
                    spec: {
                      podSelector: { matchLabels: { "app.kubernetes.io/component": "harness" } },
                      policyTypes: ["Egress"],
                      egress: [
                        { ports: [{ port: 53, protocol: "UDP" }] },
                        {
                          to: [
                            {
                              ipBlock: {
                                cidr: "0.0.0.0/0",
                                except: CLOSED_RANGES,
                              },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ]
              : [],
          }),
        );
      return ok("");
    },
  };
  return { k, calls };
}

/** Control over a fake cluster; `tag` names the rig images it deploys (another control, later). */
export async function control(
  k: ClusterKubectl,
  o: {
    store?: ControlStore;
    secrets?: SecretBox;
    tag?: string;
    publicUrl?: string | null;
    drainWatchMs?: number;
  } = {},
) {
  const secrets = o.secrets ?? SecretBox.ephemeral();
  const tag = o.tag ?? "1";
  const { store, control: api } = controlOnly({
    store: o.store,
    tokens: { operator: OPERATOR, rigs: {} },
    options: {
      secrets,
      clusterKubectl: k,
      ...(o.drainWatchMs ? { drainWatchMs: o.drainWatchMs } : {}),
      publicUrl: o.publicUrl === null ? undefined : (o.publicUrl ?? "https://control.example.com"),
      rigImages: {
        harness: `registry.example.com/harness:${tag}`,
        harnessCuda: `registry.example.com/harness-cuda:${tag}`,
        supervisor: `registry.example.com/supervisor:${tag}`,
      },
    },
  });
  const ui = await signIn(api);
  const { page } = ui;
  const csrf = ui.csrfOf(await page("/ui/settings"));
  const post = async (path: string, form: Record<string, string>) =>
    decodeURIComponent(String((await ui.post(path, { csrf, ...form })).headers.get("location")));
  return { store, secrets, page, post, api };
}

/** An MCP client on control with a token: each call's error flag and its JSON answer. */
export async function mcpWith(api: Requester, token: string) {
  const client = await mcpClient(api, token);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return {
      error: r.isError === true,
      body: JSON.parse(r.content[0]?.text ?? "null") as Record<string, unknown>,
    };
  };
  return { call, close: () => client.close() };
}
