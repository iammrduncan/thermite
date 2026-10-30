import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { log, secretFromPath } from "../common/env.ts";
import { errorText, Refusal } from "../common/errors.ts";
import { RIG_ID } from "../core/ids.ts";
import { harnessConfirmed, issueCommand } from "./issue/index.ts";
import { exportLeft, resultsLeft } from "./results-left.ts";
import { type RunpodRigs, type RunpodRigView, runpodResetRefusal } from "./runpod/index.ts";
import type { ControlStore } from "./store/index.ts";
import { type RigView, rigView } from "./views/index.ts";

/**
 * Lifecycle: restarting a rig's containers, and the owner's full reset. Pause and resume are
 * app commands; restarts go through a deployment driver:
 *
 * - Kubernetes: control's service account deletes the rig's pods (its Role allows pods get,
 *   list and delete in the rig's namespace, nothing else); the Deployment recreates them.
 * - Compose: the container engine's API (Docker or Podman) restarts the rig's containers.
 * - RunPod: for the rigs control launched on RunPod, whatever THERMITE_LIFECYCLE says, RunPod's
 *   API stops, starts, restarts and terminates the rig's pod (RunpodDriver; runpod/lifecycle.ts).
 *
 * A full reset: pause the rig's running runs, export, wait until that export has left the rig
 * (the supervisor reports it pushed to the results repository, or control holds all of it), then
 * the signed wipe_state (the harness and the supervisor wipe their own state and restart), then a
 * restart through the driver. On RunPod the reset waits until every result has left the pod, and
 * keeps the pod and its GPU: the two parts restart themselves in it.
 */

export type Component = "harness" | "supervisor";

export interface DeploymentDriver {
  readonly kind: string;
  /** Restarts the rig's parts; `by` is who asked, for the drivers that record it. */
  restart(rig: string, components: Component[], by?: string): Promise<string[]>;
}

/** One HTTP(S) request with a JSON body, over TCP or a Unix socket. */
function call(
  url: URL,
  method: string,
  opts: { headers?: Record<string, string>; ca?: string; socketPath?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = send(
      {
        protocol: url.protocol,
        hostname: opts.socketPath ? undefined : url.hostname,
        port: opts.socketPath ? undefined : url.port,
        socketPath: opts.socketPath,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          accept: "application/json",
          ...(payload ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
        ...(opts.ca ? { ca: opts.ca } : {}),
        timeout: 30_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          text += d;
        });
        res.on("end", () => {
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Each rig's namespace when THERMITE_K8S_NAMESPACE is not set: the name control also gives the
 * namespaces it creates on a cluster. A control that sets the template keeps its own.
 */
export const DEFAULT_NAMESPACE = "thermite-{rig}";

export interface KubernetesOptions {
  /** API server; in a pod, the address Kubernetes gives every pod (no DNS needed). */
  apiUrl: string;
  /** The token, or a function that reads it (service-account tokens are rotated on disk). */
  token: string | (() => string);
  ca?: string | undefined;
  /** Namespace per rig, with {rig} replaced (default DEFAULT_NAMESPACE). */
  namespaceTemplate: string;
  /** Label selector per component (default app.kubernetes.io/component=<component>). */
  selectors: Record<Component, string>;
}

export class KubernetesDriver implements DeploymentDriver {
  readonly kind = "kubernetes";
  private readonly o: KubernetesOptions;

  constructor(o: KubernetesOptions) {
    this.o = o;
  }

  /** In-cluster configuration from the pod's service account. */
  static inCluster(env: NodeJS.ProcessEnv = process.env): KubernetesDriver {
    const sa = "/var/run/secrets/kubernetes.io/serviceaccount";
    return new KubernetesDriver({
      apiUrl: env.THERMITE_K8S_API ?? inClusterApi(env),
      token: () =>
        secretFromPath(env.THERMITE_K8S_TOKEN_FILE ?? `${sa}/token`, "THERMITE_K8S_TOKEN_FILE"),
      ca: readFileSync(env.THERMITE_K8S_CA_FILE ?? `${sa}/ca.crt`, "utf8"),
      namespaceTemplate: env.THERMITE_K8S_NAMESPACE || DEFAULT_NAMESPACE,
      selectors: {
        harness: env.THERMITE_K8S_SELECTOR_HARNESS ?? "app.kubernetes.io/component=harness",
        supervisor:
          env.THERMITE_K8S_SELECTOR_SUPERVISOR ?? "app.kubernetes.io/component=supervisor",
      },
    });
  }

  async restart(rig: string, components: Component[]): Promise<string[]> {
    if (!RIG_ID.test(rig)) throw new Error(`not a rig name: ${rig}`);
    // {unit} is the placeholder's name before the 2026-10-15 rename.
    const ns = this.o.namespaceTemplate.replace("{rig}", rig).replace("{unit}", rig);
    const token = typeof this.o.token === "function" ? this.o.token() : this.o.token;
    const headers = { authorization: `Bearer ${token}` };
    const deleted: string[] = [];
    for (const c of components) {
      const list = await call(
        new URL(
          `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(this.o.selectors[c])}`,
          this.o.apiUrl,
        ),
        "GET",
        { headers, ca: this.o.ca },
      );
      if (list.status !== 200) throw new Error(`listing ${c} pods in ${ns}: HTTP ${list.status}`);
      const pods = ((list.body as { items?: { metadata: { name: string } }[] }).items ?? []).map(
        (p) => p.metadata.name,
      );
      if (!pods.length) throw new Error(`no ${c} pod in ${ns}`);
      for (const name of pods) {
        const r = await call(
          new URL(`/api/v1/namespaces/${ns}/pods/${encodeURIComponent(name)}`, this.o.apiUrl),
          "DELETE",
          { headers, ca: this.o.ca },
        );
        if (r.status !== 200 && r.status !== 202)
          throw new Error(`deleting ${ns}/${name}: HTTP ${r.status}`);
        deleted.push(`${ns}/${name}`);
      }
    }
    return deleted;
  }
}

export interface ComposeOptions {
  /** The engine's API socket (Docker or Podman's Docker-compatible API). */
  socketPath: string;
  project: string;
  /** rig -> component -> compose service name. */
  services: Record<string, Partial<Record<Component, string>>>;
}

export class ComposeDriver implements DeploymentDriver {
  readonly kind = "compose";
  private readonly o: ComposeOptions;

  constructor(o: ComposeOptions) {
    this.o = o;
  }

  async restart(rig: string, components: Component[]): Promise<string[]> {
    const base = new URL("http://engine");
    const restarted: string[] = [];
    for (const c of components) {
      const service = this.o.services[rig]?.[c];
      if (!service) throw new Error(`no ${c} service configured for ${rig}`);
      const filters = JSON.stringify({
        label: [
          `com.docker.compose.project=${this.o.project}`,
          `com.docker.compose.service=${service}`,
        ],
      });
      const list = await call(
        new URL(`/containers/json?all=1&filters=${encodeURIComponent(filters)}`, base),
        "GET",
        { socketPath: this.o.socketPath },
      );
      if (list.status !== 200) throw new Error(`listing ${service}: HTTP ${list.status}`);
      const ids = ((list.body as { Id: string }[]) ?? []).map((x) => x.Id);
      if (!ids.length) throw new Error(`no container for service ${service}`);
      for (const id of ids) {
        const r = await call(new URL(`/containers/${id}/restart?t=10`, base), "POST", {
          socketPath: this.o.socketPath,
        });
        if (r.status !== 204 && r.status !== 200)
          throw new Error(`restarting ${service}: HTTP ${r.status}`);
        restarted.push(service);
      }
    }
    return restarted;
  }
}

/**
 * Rigs control launched on RunPod (runpod/rigs.ts): one container per pod, driven through RunPod's
 * API. It serves only those rigs, beside the driver THERMITE_LIFECYCLE names for the others, and
 * needs no setting: control holds the RunPod key in Providers. Each change goes through the
 * rig's results first (runpod/lifecycle.ts) and is a step in the rig's history.
 */
export class RunpodDriver implements DeploymentDriver {
  readonly kind = "runpod";
  private readonly rigs: RunpodRigs;

  constructor(rigs: RunpodRigs) {
    this.rigs = rigs;
  }

  /** Whether the rig is one control launched on RunPod and still follows. */
  serves(rig: string): boolean {
    return Boolean(this.rigs.view(rig)?.active);
  }

  /** Stops the pod and starts it again; its volume stays. Both parts restart together. */
  async restart(rig: string, components: Component[], by = "owner:api"): Promise<string[]> {
    if (!(components.includes("harness") && components.includes("supervisor")))
      throw new Error(
        "a rig on RunPod runs its harness and its supervisor in one container: they restart together",
      );
    const v = await this.rigs.restart(rig, by);
    return [`pod ${v.pod}: it stops, then starts again`];
  }

  stop(rig: string, by: string): Promise<RunpodRigView> {
    return this.rigs.stop(rig, by);
  }

  start(rig: string, by: string): Promise<RunpodRigView> {
    return this.rigs.start(rig, by);
  }

  /** Removes the pod, but only once every result has left it; `confirm` is "terminate <rig>". */
  terminate(rig: string, by: string, confirm: string): Promise<RunpodRigView> {
    return this.rigs.terminate(rig, by, confirm);
  }
}

/** The driver configured for this control, if any. */
export function driverFromEnv(env: NodeJS.ProcessEnv = process.env): DeploymentDriver | undefined {
  if (env.THERMITE_LIFECYCLE === "kubernetes") return KubernetesDriver.inCluster(env);
  if (env.THERMITE_LIFECYCLE === "compose") {
    return new ComposeDriver({
      socketPath: env.THERMITE_ENGINE_SOCKET ?? "/run/engine.sock",
      project: env.THERMITE_COMPOSE_PROJECT ?? "thermite",
      services: JSON.parse(env.THERMITE_COMPOSE_SERVICES ?? "{}") as ComposeOptions["services"],
    });
  }
  return undefined;
}

/** How long each reset step may take before the reset fails (the owner's confirmation: a day). */
const STEP_LIMIT_MS: Record<string, number> = {
  quiescing: 60 * 60_000,
  exporting: 30 * 60_000,
  verifying: 60 * 60_000,
  awaiting_owner: 24 * 3_600_000,
  wiping: 30 * 60_000,
};

let advancing: Promise<void> | undefined;

/**
 * Advances every open full reset by one step. Each step waits for evidence before the next:
 *
 *  start          pause the rig's running runs;
 *  quiescing      until the rig reports no queued or running judge jobs (an hour at most);
 *  exporting      a full export (research archive and ledger snapshot), until its result arrives;
 *  verifying      until the supervisor reports that export pushed to the results repository,
 *                 or, for a rig without one, control holds every file of it (results-left.ts);
 *  awaiting_owner the owner checks the pushed commit (or control's copy) and confirms (the
 *                 supervisor's report is unsigned: the owner, not control, is the last check
 *                 before data goes);
 *  wiping         the signed wipe_state; then the restart through the driver.
 *
 * Runs are serialized: a timer and an API call can't advance the same reset twice.
 */
export async function advanceResets(input: {
  store: ControlStore;
  privateKeyPem: string;
  driver: DeploymentDriver | undefined;
  staleAfterMs: number;
}): Promise<void> {
  while (advancing) await advancing;
  advancing = advanceOnce(input).finally(() => {
    advancing = undefined;
  });
  return advancing;
}

async function advanceOnce(input: {
  store: ControlStore;
  privateKeyPem: string;
  driver: DeploymentDriver | undefined;
  staleAfterMs: number;
}): Promise<void> {
  const { store } = input;
  for (const r of store.fullResets
    .list(50)
    .filter((x) => !["done", "failed", "cancelled"].includes(String(x.state)))) {
    const id = Number(r.id);
    const rig = String(r.rig);
    const state = String(r.state);
    const issue = (kind: "pause_run" | "export_now" | "wipe_state", payload: unknown) =>
      issueCommand(store, input.privateKeyPem, {
        rig,
        kind,
        payload,
        ttlMinutes: 30,
        // The owner who asked for the reset: the harness accepts wipe_state only from the owner.
        issuedBy: String(r.requested_by),
      }).id;
    // A rig control launched on RunPod: every result leaves the pod, which stays, with its GPU.
    const onRunpod = Boolean(store.runpod.rig(rig));
    const fail = (detail: string) => {
      store.fullResets.update(id, {
        state: "failed",
        detail: `${detail} (the rig's campaigns stay paused: resume them when it is safe)`,
      });
      if (onRunpod) store.rigHistory.add(rig, "reset_failed", false, detail);
      log("control", "reset failed", { rig, detail }, "error");
    };
    const limit = STEP_LIMIT_MS[state];
    if (limit && Date.now() - Date.parse(String(r.updated_at)) > limit) {
      fail(`timed out while ${state}`);
      continue;
    }
    try {
      switch (state) {
        case "start": {
          const refused = runpodResetRefusal(store, rig);
          if (refused) {
            fail(refused);
            break;
          }
          if (onRunpod)
            store.rigHistory.add(
              rig,
              "reset_requested",
              true,
              `asked by ${String(r.requested_by)}`,
            );
          const v = rigView(store, rig, { staleAfterMs: input.staleAfterMs });
          for (const i of v?.runs.filter((x) => x.status === "running") ?? []) {
            issue("pause_run", { run: i.id, reason: "full reset" });
          }
          store.fullResets.update(id, { state: "quiescing" });
          break;
        }
        case "quiescing": {
          const v = rigView(store, rig, { staleAfterMs: input.staleAfterMs });
          if (judgeBusy(v) > 0 || store.commands.pending(rig).length > 0) break;
          store.fullResets.update(id, {
            state: "exporting",
            command: issue("export_now", { full: true }),
          });
          break;
        }
        case "exporting": {
          const c = store.commands.get(String(r.command));
          // The harness's own (signed) record of the command, not the supervisor's acknowledgement.
          if (!c || c.status === "pending" || !harnessConfirmed(c.outcome)) break;
          const out = (c.outcome ?? {}) as {
            result?: { export?: string; through_event?: number };
          };
          const result = out.result;
          if (c.status !== "delivered" || !result?.export) {
            fail(`the export did not complete (${c.status})`);
            break;
          }
          store.fullResets.update(id, {
            state: "verifying",
            export_name: result.export,
            through_event: Number(result.through_event ?? 0),
          });
          break;
        }
        case "verifying": {
          // The export reached the results repository (the supervisor reports the push), or, for
          // a rig without one, control holds every file of it (control checks its own copy).
          const name = String(r.export_name);
          const e = exportLeft(store, rig, name);
          if (e.never) {
            fail(`${e.why}: its export cannot be verified`);
            break;
          }
          if (!e.left) break;
          // On RunPod, every result too: what waits on the pod is gone after the wipe.
          if (onRunpod && !resultsLeft(store, rig, { export: name }).left) break;
          store.fullResets.update(id, {
            state: "awaiting_owner",
            detail:
              e.to === "control"
                ? `export ${name} is on control, every file checked against its manifest; check it there (GET /v1/rigs/${rig}/exports/${name}), then confirm the wipe`
                : `export ${name} reported pushed${e.commit ? ` (results repository commit ${e.commit})` : ""}; check it there, then confirm the wipe`,
          });
          break;
        }
        case "confirmed": {
          store.fullResets.update(id, {
            state: "wiping",
            command: issue("wipe_state", {
              confirm: "wipe",
              export: String(r.export_name),
              through_event: Number(r.through_event),
            }),
          });
          break;
        }
        case "wiping": {
          const c = store.commands.get(String(r.command));
          if (!c || c.status === "pending" || !harnessConfirmed(c.outcome)) break;
          if (c.status !== "delivered") {
            fail(`the harness refused the wipe: ${JSON.stringify(c.outcome).slice(0, 300)}`);
            break;
          }
          let restart = "the rig restarted itself (no deployment driver configured)";
          if (onRunpod) {
            // RunPod's driver keeps the pod: a stop could give its GPU to someone else.
            restart =
              "the pod and its GPU stay: the harness and the supervisor restarted themselves in it";
            store.rigHistory.add(rig, "reset_done", true, `export ${String(r.export_name)}`);
          } else if (input.driver) {
            try {
              restart = `restarted ${(await input.driver.restart(rig, ["harness", "supervisor"])).join(", ")}`;
            } catch (err) {
              // The wipe happened; the containers restart themselves after it anyway.
              restart = `the restart through the driver failed (${errorText(err)}); the rig restarts itself`;
            }
          }
          store.fullResets.update(id, { state: "done", detail: `wiped; ${restart}` });
          break;
        }
      }
    } catch (err) {
      fail(errorText(err));
    }
  }
}

/** The owner's confirmation of a reset waiting for it. */
export function confirmReset(store: ControlStore, id: number, by: string): void {
  const r = store.fullResets.list(200).find((x) => Number(x.id) === id);
  if (!r) throw new Refusal(`no reset ${id}`);
  if (String(r.state) !== "awaiting_owner")
    throw new Refusal(`reset ${id} is ${String(r.state)}, not waiting for confirmation`);
  store.fullResets.update(id, { state: "confirmed", detail: `confirmed by ${by}` });
}

/** The owner cancels a reset that has not wiped yet. */
export function cancelReset(store: ControlStore, id: number, by: string): void {
  const r = store.fullResets.list(200).find((x) => Number(x.id) === id);
  if (!r) throw new Refusal(`no reset ${id}`);
  if (["wiping", "done", "failed", "cancelled"].includes(String(r.state)))
    throw new Refusal(`reset ${id} is ${String(r.state)}`);
  store.fullResets.update(id, {
    state: "cancelled",
    detail: `cancelled by ${by}; the rig's campaigns stay paused until resumed`,
  });
  if (store.runpod.rig(String(r.rig)))
    store.rigHistory.add(String(r.rig), "reset_cancelled", true, `by ${by}`);
}

/**
 * The API server as every pod sees it: KUBERNETES_SERVICE_HOST and _PORT (an address, so control
 * needs no DNS egress); the service name only when they are missing.
 */
export function inClusterApi(env: NodeJS.ProcessEnv): string {
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host) return "https://kubernetes.default.svc";
  const port = env.KUBERNETES_SERVICE_PORT ?? "443";
  return `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/**
 * The judge's jobs a full reset waits for before its export (goal 165): those under way, and the
 * queued jobs it will still take. The reset paused the runs, and the judge never takes a paused or
 * closed run's queued job: those stay in the queue, and the export carries them.
 */
export function judgeBusy(v: RigView | undefined): number {
  if (!v) return 0;
  const held = new Set(v.runs.filter((r) => r.status !== "running").map((r) => r.id));
  const queued = v.judge.queued.filter((j) => !j.run || !held.has(j.run)).length;
  return Number(v.jobs.leased ?? 0) + queued;
}
