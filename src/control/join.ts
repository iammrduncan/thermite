import { shellQuote } from "../common/exec.ts";
import { PROGRAM_MODE_DEFAULT } from "../core/rig-settings.ts";
import { asList, type ClusterRigPlan, clusterRigObjects } from "./clusters/index.ts";
import { deployScript, manageScript, type RigPlan, type RigSecrets } from "./machines/index.ts";

/**
 * "Join a rig yourself": for a place control can't connect to, such as a machine
 * behind NAT or a namespace whose operators give Thermite no kubeconfig. Control mints a join
 * command for one rig: it works once, for one hour, and control keeps only its hash. Run where the
 * rig goes, it fetches from control the same files and units the SSH path writes (a script), or
 * the same objects the cluster path applies (a manifest, applied with the operator's own rights).
 * Control installs nothing there and can't reach the place afterwards, so stopping, restarting
 * and removing the rig are commands the page shows for the owner to run.
 */

export const JOIN_HOURS = 1;

export type JoinForm = "machine" | "namespace";

export interface JoinedSpec {
  /** machine: the machine's GPU indices; namespace: how many GPUs the harness pod asks for. */
  gpus: number[] | number;
  /** With two or more GPUs, how many are the judge's (the rest are the agents'). */
  judgeGpus?: number | undefined;
  images: { harness: string; supervisor: string };
  /** machine: whether the join ran as root (known once it has run). */
  root?: boolean | undefined;
  /** namespace only. */
  namespace?: string | undefined;
  gpuMode?: "device-plugin" | "dra" | undefined;
  deviceClass?: string | undefined;
  storageClass?: string | undefined;
  storageGi?: number | undefined;
}

const fail = (why: string) => `fail ${JSON.stringify(why)}`;

/**
 * The script a machine fetches: checks what the rig needs first (nothing is written when one is
 * missing), then the SSH path's deploy script.
 */
export function joinMachineScript(p: RigPlan, s: RigSecrets): string {
  const checks = [
    "set -eu",
    'fail() { echo "thermite: $1" >&2; exit 4; }',
    `command -v podman >/dev/null 2>&1 || ${fail("Podman is missing: install Podman 4.4 or later, then make a new join command")}`,
    `command -v systemctl >/dev/null 2>&1 || ${fail("systemd is missing: a rig runs as systemd services")}`,
    ...(p.root
      ? []
      : [
          `loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q '=yes' || fail "lingering is off for $(id -un), so its services would stop at logout: run sudo loginctl enable-linger $(id -un), then make a new join command"`,
        ]),
    ...(p.gpus.length
      ? [
          "cdi=$(nvidia-ctk cdi list 2>/dev/null || true)",
          ...p.gpus.map(
            (g) =>
              `printf '%s\\n' "$cdi" | grep -qx 'nvidia.com/gpu=${g}' || ${fail(`GPU ${g} has no CDI device: install NVIDIA's container toolkit and run sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml, then make a new join command`)}`,
          ),
        ]
      : []),
  ];
  return `${checks.join("\n")}\n${deployScript(p, s)}\n`;
}

/**
 * The manifest a namespace's operator applies: the cluster path's objects, with network rules. It
 * sets no CPUs or memory (the namespace's defaults apply), so how the agent programs run sets no
 * share of them in it.
 */
export function joinNamespaceManifest(
  p: Omit<ClusterRigPlan, "placement" | "resources" | "programMode">,
  s: RigSecrets,
): string {
  return asList(
    clusterRigObjects({ ...p, placement: "joined", programMode: PROGRAM_MODE_DEFAULT }, s),
  );
}

/** The one command the owner runs where the rig goes. */
export function joinCommand(
  form: JoinForm,
  o: { controlUrl: string; rig: string; token: string; namespace?: string | undefined },
): string {
  const base = `${o.controlUrl.replace(/\/$/, "")}/v1/join/${o.rig}`;
  const auth = shellQuote(`authorization: Bearer ${o.token}`);
  return form === "machine"
    ? `f=$(mktemp) && curl -fsS -H ${auth} "${base}/script?uid=$(id -u)" -o "$f" && sh "$f"; rm -f "$f"`
    : `curl -fsS -H ${auth} ${shellQuote(`${base}/manifest`)} | kubectl apply -n ${o.namespace} -f -`;
}

/** Commands for a joined rig, which control can't run itself. */
export function joinedCommands(
  form: JoinForm,
  rig: string,
  spec: JoinedSpec,
): { stop: string; start: string; restart: string; remove: string } {
  if (form === "namespace") {
    const ns = spec.namespace ?? "";
    const sel = `app.kubernetes.io/instance=${rig}`;
    return {
      stop: `kubectl scale deployment -n ${ns} -l ${sel} --replicas=0`,
      start: `kubectl scale deployment -n ${ns} -l ${sel} --replicas=1`,
      restart: `kubectl rollout restart deployment -n ${ns} -l ${sel}`,
      remove: `kubectl delete deployment,service,persistentvolumeclaim,secret,networkpolicy,resourceclaimtemplate -n ${ns} -l ${sel} --ignore-not-found`,
    };
  }
  const p = { rig, root: spec.root === true };
  const body = (a: "stop" | "start" | "restart" | "remove") =>
    manageScript(p, a)
      .split("\n")
      .filter((l) => l !== "set -eu" && !l.startsWith("echo "))
      .join("\n");
  return {
    stop: body("stop"),
    start: body("start"),
    restart: body("restart"),
    remove: body("remove"),
  };
}
